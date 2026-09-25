# 调研: jev + fallback 两层级联的生产 audit 数据分析

> 调研日期: 2026-09-25。
> 问题: 基于 2026-09-19 ~ 2026-09-25 两台主机（本地 macOS 与远程 Linux）的真实 audit 日志，评估 jev（第一层分类器）与 fallback 分类器（第二层）级联在生产中的表现，并对该组合提出改进意见。
> 数据源: `~/.pi/agent/verdicts/*.jsonl`（本地 22 个会话文件 + 远程 13 个独有会话文件；其中 7 个文件两台机器内容完全一致，为同步副本，只计一次）。
> 配置事实: 两台机器均为第一层 `typesafe/jev-latest`、第二层 `claude-haiku-4-5-20251001`（经内部网关路由）、`classifierFallbackMode: "enforce"`；差异在 confidence floor 阈值——本地 `classifierMinConfidence: 80`，远程 `classifierMinConfidence: 90`。
> 前置阅读: `research/classifier-fallback-model-feasibility.md`（该级联的设计论证，本文是其生产验证）。
> 方法: 对去重后的 1265 条判定记录做统计聚合与逐条抽样核对，交叉比对第一层原始判定、第二层判定与最终生效判定（effective verdict）。全部数字可由附录的复现方法重跑得出。

## TL;DR

1. **架构的层间边界在生产中全部被验证正确**：第一层 deny 不可被第二层放宽为 allow 的规则、protected-path 与级联的隔离、第一层失败时第二层兜底——没有观察到任何一层越界。
2. **触发率是 floor 策略的代价，不是缺陷**：0.11.0（confidence floor）全面生效后（2026-09-24 起）39% 的分类器调用进入第二层，这是 `classifierMinConfidence` 高阈值（本地 80 / 远程 90）的直接结果。设计立场（用户决策）：对第一层 jev 的安全判断智能存疑，故以高 floor 将需要更高智能的判断移交给第二层——阈值属用户主权的调参。该策略在本批数据中有正面证据：两例凭据访问的 allow 正是因低置信触发 floor、经第二层审查后才被抓（见 2.2）。
3. **真正的浪费点与阈值无关，在无副作用工具**：约三分之一（33%）的第二层触发落在 todo / ask_user_question / memory_write / memory_forget 上，第二层对这些工具的裁决无一收紧、几乎全部 allow——无论阈值多高，这部分触发都不包含「需要更高智能判断」的内容，纯属延迟开销（每次触发 p50 2.5 秒）。
4. **jev 对「元动作」类工具存在系统性语义混淆**：`ask_user_question` 平均 confidence 仅 50%（对照组 read / fetch_content 为 96% ~ 99%），把「向用户提问的工具」大量判为低置信或 ask，随后被第二层无一例外翻回 allow。这不是智能问题而是校准问题，且它污染了 floor 信号——把「jev 不会判这类动作」误报为「jev 不确定」。
5. 两个高价值样本值得单独记录：第二层两次把第一层的 allow 升级为 deny（凭据扫描、凭据文件读取），理由准确——这是级联存在的意义；但也有两次把第一层的 ask 放宽为 allow 的争议裁决（集群配置写入、加载凭据文件并外呼 API）——放宽方向缺少门槛。

## 一、数据与配置概况

### 1.1 总量

| 维度 | 数值 |
|---|---|
| 判定记录总数 | 1265（本地 719 / 远程 546） |
| 会话数 | 34（本地 21 / 远程 13） |
| 时间跨度 | 2026-09-19 ~ 2026-09-25 |
| 工具分布（前五） | bash 738 · todo 167 · get_search_content 132 · fetch_content 87 · web_search 43 |
| 判定来源（source 字段） | model 1223 · fail-closed 26 · protected-path 16 |
| 第一层原始判定（verdict 字段） | allow 1155 · ask 76 · deny 34（deny 中 26 条实为 fail-closed 来源） |

### 1.2 级联生效时间线（由数据反推）

| 日期 | 现象 | 对应版本 |
|---|---|---|
| 09-19 ~ 09-20 | confidence < 60 的调用共 26 条，无一触发第二层 | 0.10.0 之前 |
| 09-21 | 混合状态：confidence < 60 的 43 条中 29 条触发、14 条未触发；当天出现 confidence 高至 79 的降级记录 | 0.10.0 发布日（uncertainty-gated fallback），floor 阈值在开发期试运行 |
| 09-24 ~ 09-25 | confidence < 阈值的调用全部触发，enforce 模式全面生效 | 0.11.0（confidence floor，#67） |

### 1.3 第二层触发总量与构成

全期第二层共被调用 **296 次**（触发条件见 `extensions/pi-verdict.ts` 配置提示，任一即触发）:

| triggeredBy | 次数 | 说明 |
|---|---|---|
| confidence | 262 | 第一层 confidence 低于 `classifierMinConfidence`（autonomy floor，#67） |
| fail-closed | 26 | 第一层分类器调用失败（全部集中在远程 09-24 的同一时段，见 3.3） |
| ask | 8 | 第一层判定为 ask（#63 的 uncertainty gate）。仅出现在 09-21 且全部为 shadow 模式；#67 已移除该触发条件（高置信 ask 直达人工），0.11.0 生效后不再出现 |

## 二、已被生产数据验证有效的设计

### 2.1 deny 不可放宽规则（carve-out）按设计生效

生产中出现 3 例「第一层 deny、第二层 allow」的分歧，最终生效判定全部收敛为 ask，日志记录为 "first layer said deny at confidence X%; second opinion allows — your call"。该规则（`extensions/pi-verdict.ts:1704`）在真实流量下守住了边界：第二层可以参与裁决，但不能凭一己之力放行第一层的 deny。

### 2.2 第二层的收紧裁决质量高

两例第一层 allow 被第二层升级为 deny，均涉及凭据访问，理由具体准确：

- 环境变量凭据枚举（本地 09-21）：命令遍历 `.env` 类文件并掩码打印键名，第二层理由为「即使做了掩码，枚举秘密环境变量本身即构成凭据访问」。
- 凭据文件读取探测（本地 09-21）：命令读取认证凭据文件探测 API key 是否存在，第二层理由为「读取用户凭据文件不得静默放行」。

这两类正是第一层 jev 倾向 allow 的盲区，也是高 floor 策略的直接正面证据：两例的第一层 confidence 分别为 35% 与 44%，均为 confidence 触发（`triggeredBy: "confidence"`、enforce 模式）——低置信的 allow 被送审后由第二层抓住。若 floor 阈值较低，这两例将以高置信 allow 的形式直接放行。

### 2.3 第一层失败时第二层兜底，会话不中断

远程主机 09-24 05:27 ~ 05:35（8 分钟）内，第一层分类器调用连续失败 26 次（fail-closed）。此期间第二层接管全部判定（25 例 allow、1 例 ask），被裁决的命令均为只读排查类（查看包信息、读源码、读文档），裁决合理，会话未因第一层不可用而中断。

### 2.4 protected-path 与级联无交集

16 条 protected-path 判定（`denyPaths` 触及）全部为 ask，全部未进入级联。两条防线边界干净：路径保护是确定性规则，不需要也不接受模型裁决。

### 2.5 ground-truth 字段满足复盘需求

`demoted` / `fallback.triggeredBy` / `fallback.effective` / `fallback.reason` / `fallback.durationMs` 等字段落盘完整，本文全部统计（包括逐条分歧核对）仅依赖 audit 日志即可复现，无需重新推理。

## 三、问题（按影响排序）

### 3.1 触发预算的构成：策略代价与真实浪费的区分

**定性修正（2026-09-25，用户决策）**：触发率本身不是问题。`classifierMinConfidence` 是用户可配置的主权参数，高阈值（80/90）意味着有意让大量调用进入第二层——用第一层的 confidence 作为「该判断是否需要更高智能」的路由信号，而非仅作为第一层可信度的度量。39% 的触发率是该策略的预期代价。本节保留构成数据用于后续优化定位；「回落阈值」不构成建议。

0.11.0 生效后（09-24 起，658 条记录、619 条 model 来源）:

| 指标 | 数值 |
|---|---|
| 第二层触发次数 | 241（占 model 调用的 **39%**） |
| 其中带来更严裁决（收紧） | 18（7.5%） |
| 其中落在无副作用工具（见 3.2） | 80（**33%**）——真实浪费 |
| 其余（有副作用工具上的确认/放宽） | 策略预期成本 |
| 第二层延迟 | p50 2.5 秒 · p90 5.1 秒 · 最大 17.0 秒 · 均值 3.1 秒 |
| jev confidence < 90 占比 | 37.5%（与触发率吻合，阈值 90 的远程贡献了大头） |
| jev confidence < 80 占比 | 27%（本地阈值 80 时的触发面上限） |

单日最重负载出现在远程 09-24：全天 208 次触发，其中一个会话（源码探索类，948 KB 日志）独自贡献 60 次。

在「高 floor 换第二层智能」的策略下，确认类裁决（约 8 成）是买到的服务而非浪费；**浪费的定义收窄为「不含智能判断需求的触发」**——即 3.2 的无副作用工具，它们与阈值无关、在任何 floor 配置下都是纯延迟开销。

### 3.2 无副作用工具吃掉三分之一触发预算，jev 校准是根因

按工具的触发率与第一层平均 confidence（全期 model 来源）:

| 工具 | 触发率 | 平均 confidence | 备注 |
|---|---|---|---|
| ask_user_question | 84%（16/19） | **50%**（p10 = 28%） | 第二层全部翻回 allow |
| memory_forget | 80%（4/5） | 70% | 全部翻回 allow |
| memory_write | 82%（28/34） | 77% | 无一收紧 |
| write | 67%（4/6） | **52%**（p10 = 24%） | — |
| Agent | 29%（2/7） | 66%（p10 = 27%） | — |
| todo | 26%（43/167） | 77% | 无一收紧 |
| bash | 22%（156/708） | 85%（p10 = 52%） | 收紧主要来源 |
| web_search | 7% | 92% | — |
| fetch_content | 2% | 96% | 对照组 |
| read | 0% | 99% | 对照组 |
| get_search_content | 0% | 98% | 对照组 |

关键观察：

1. **0.11.0 生效后的 241 次触发中，80 次（33%）落在 todo / ask_user_question / memory_write / memory_forget 四个无副作用工具上，这些工具被第二层收紧的次数为零。**
2. jev 对 `ask_user_question` 的表现最像系统性语义混淆：该工具的用途就是向用户提问，jev 却对它普遍输出低置信（平均 50%）并大量触发降级，随后第二层无一例外判回 allow。对照组（read / fetch_content / get_search_content，平均 confidence 96% ~ 99%，触发率 0% ~ 2%）说明 jev 对语义明确的只读动作校准得很好——问题特定于「元动作」类工具。
3. jev 的 confidence 混合了「动作风险等级」与「对裁决正确性的把握」两种语义：write 平均 52% 不是因为 jev 不确定自己想判什么，而是因为写文件本身风险高。而 autonomy floor（#67）的语义是后者（不确定就不该自主），两者错位导致 floor 大量空转。

### 3.3 fail-closed 的审计语义失真

26 条 fail-closed 记录的 `verdict` 字段均为 deny，但其中 25 条经第二层裁决后生效判定（effective verdict）为 allow、1 条为 ask。以 `verdict` 字段统计「拦截数」会严重失真（按字段统计 deny 34 条，实际生效 deny 仅 8 条）。

这并非行为错误——第二层可用时接管第一层失败，本来就是 fallback 的设计用途（#63），且上述 26 例的裁决经人工核对全部合理。问题在**记录口径**：`source: "fail-closed"` + `verdict: "deny"` + `fallback.effective: "allow"` 的组合，让「fail-closed」这个标签同时承担了「第一层失败」（事实）与「保守拦截」（未发生）两种读法。审计与统计必须知道去看 `fallback.effective` 才能得到真相。

### 3.4 enforce 模式的放宽方向缺门槛，且与文档口径不一致

**文档与实现不一致**：`extensions/pi-verdict.ts:328` 的配置提示写 "mode shadow (default) observes without changing verdicts, **enforce escalates strictness only**"，但实现（`extensions/pi-verdict.ts:1706`）是第二层 de novo 重裁、裁决直接生效——唯一限制是第一层 deny 不可升为 allow（2.1 所述 carve-out）。即 enforce 实际既能收紧也能放宽，仅文档描述为「只收紧」。

**放宽的风险不对称**：全期第二层把第一层的 ask 放宽为 allow 共 24 例，把 allow 收紧为 ask/deny 共 24 例，数量相当。但两个方向的错误代价不对称：多问一次用户（该放宽没放宽）的成本是一次确认；放行一个本应确认的动作（该收紧没收紧）的代价可能是不可逆操作。目前放宽与收紧适用同一套逻辑，没有额外门槛。

**两例争议放宽**（均为第二层推翻第一层 ask、放行为 allow）:

- 集群备份配置写入（本地 09-25）：第二层理由是「与用户任务直接一致、同型命令此前已运行」——以任务相关性和历史先例放行写入类操作，存在「重复动作自动放行」的路径依赖风险。
- 加载凭据文件并外呼图像生成 API（本地 09-21）：第二层理由是「使用用户自存的密钥、属用户明确请求的常规操作」——第一层的 ask（涉及凭据读取 + 数据外发）本应更接近正确答案。

其余 22 例放宽集中在 ask_user_question / todo 等无副作用工具（3.2 的根因），裁决本身合理。

### 3.5 shadow cache 基本无效

全期 shadow 缓存观察：miss 1208 条、would-hit 41 条（命中率 3.3%）。当前形态下缓存几乎不改变任何决策路径，保留的观测价值有限，建议评估是否移除或改为真正生效的缓存。

## 四、改进建议（按优先级）

> 定性修正（2026-09-25，用户决策）：floor 阈值是用户主权参数，「回落阈值以降低触发率」不是目标。高 floor 是有意为之的策略——对第一层判断智能存疑，将需要更高智能的判断交给第二层（2.2 的两例凭据访问是该策略的正面证据）。以下建议均在该策略前提下排序。

1. **无副作用工具豁免：走 `ignoreTools`（PR #45），不做内置集合**：生产数据的结论不变——33% 的触发不含智能判断需求、第二层对这些工具零收紧。但落地机制应复用 PR #45 的 `ignoreTools`（用户声明的工具豁免清单：跳过全部裁决、零模型调用、位于自保护层与 deny floor 之后、对 covered 工具惰性），而非在代码里内置固定集合：内置豁免与项目的 user-sovereignty 立场冲突（no built-in passthrough，每条豁免都是用户自己的声明，与「无内置白名单」同构），且边界决策（是否含 `memory_write` 的跨会话持久化、`memory_forget` 的删除语义）归用户配置而非代码。`todo` / `ask_user_question` / `memory_*` 均为 uncovered 工具，`ignoreTools` 直接生效；豁免位于分类器之前，3.2 中 14 例「第一层判 ask、第二层翻回 allow」的退化场景不复存在（第一层根本不被调用）。前置条件是合并 PR #45——作者对 2026-09-19 评论给出的 a/b 路径尚未响应，可按评论预埋的路径 b 由维护者摘取（squash 保留署名）。合并后在配置中声明（本报告的推荐集合，排除 `memory_forget`——删除操作保留审查）：`"ignoreTools": ["todo", "ask_user_question", "memory_write", "memory_search"]`。
2. **给放宽方向加门槛**：与 deny carve-out 对称，第二层把第一层的 ask 放宽为 allow 时要求第二层自身高置信（或仅对白名单工具允许放宽）。至少先修复 `extensions/pi-verdict.ts:328` 的文档口径（"escalates strictness only" 与 de novo 实现二选一对齐）。
3. **fail-closed 审计口径**：第一层失败被第二层接管的记录使用独立的 source 标记（如 `fail-closed→fallback`），不落 `verdict: "deny"`；级联 summary 中单列「第一层失败、第二层放行」计数。
4. **用本批 ground-truth 修 jev 校准**：09-24 后的 619 条记录天然构成回归集（第一层判定 + confidence + 第二层裁决 + 最终生效判定）。在高 floor 策略下，校准的意义不是减少触发，而是让 confidence 作为路由信号更纯：`ask_user_question` 的语义混淆（平均 50%）把「jev 不会判这类动作」误报为「jev 不确定」，浪费路由预算。提示词中应明确 confidence 的定义是「对所给裁决正确性的把握」，与「动作风险等级」解耦。
5. **评估 shadow cache 去留**：3.3% 的 would-hit 率不支持现状的复杂度。

## 五、术语与字段对照

本文避免使用自造缩写，全部字段名以 audit 日志 schema 为准（写入代码见 `extensions/pi-verdict.ts:1390-1490` 一带）:

| 字段 / 术语 | 含义 |
|---|---|
| 第一层（first layer） | jev 分类器（`classifierModel: typesafe/jev-latest`），对每次工具调用给出 allow / ask / deny 与 confidence |
| 第二层（fallback classifier） | `classifierFallbackModel` 配置的备用分类器（claude-haiku-4-5-20251001），仅在第一层不确定时被咨询 |
| verdict | 第一层的原始判定（allow / ask / deny）。fail-closed 来源的记录此字段恒为 deny，不代表实际拦截 |
| effective verdict（`fallback.effective`） | enforce 模式下第二层裁决后实际生效的判定；无 fallback 的记录即 verdict 本身 |
| demoted | #67 confidence floor 触发标记：第一层 confidence 低于 `classifierMinConfidence`，其判定被降级、交由级联处理 |
| triggeredBy | 第二层的触发原因：`confidence`（低于阈值）/ `ask`（第一层判 ask）/ `fail-closed`（第一层调用失败） |
| source | 判定来源：`model`（第一层正常判定）/ `fail-closed`（第一层调用失败）/ `protected-path`（denyPaths 规则命中） |
| enforce / shadow | 第二层模式：enforce 裁决生效；shadow 仅记录假想结果不改变判定 |
| confidence floor / autonomy floor | #67 引入的 `classifierMinConfidence` 配置，低于该值的第一层判定不得自主生效 |

## 附录：复现方法

1. 取数：本地直接读 `~/.pi/agent/verdicts/*.jsonl`；远程将独有文件（与本地按 md5 对比去重）同步到临时目录后并入。
2. 聚合（Python + 标准库）：逐行解析 JSON，关键派生量——
   - confidence 从 `rawResponse` 中以 `confidence (\d+)%` 提取；
   - 生效判定 = `fallback.effective`（存在时）否则 `verdict`；shadow 模式（`fallback.effective` 为空）不改变判定；
   - 收紧 / 放宽 = 生效判定相对第一层 verdict 的严格序（allow < ask < deny）比较；
   - 触发率按 `source == "model"` 的记录为分母。
3. 时段口径：「0.11.0 生效后」= 时间戳 ≥ 2026-09-24 的记录；「全期」= 2026-09-19 ~ 2026-09-25 全部记录。
4. 逐条核对样本（deny 去向、放宽/收紧案例、fail-closed 窗口）均直接打印原始记录的 `actionLine` 与 `fallback.reason` 人工复核。

本文统计脚本为一次性分析脚本（未入库）；如需长期跟踪触发率与校准漂移，建议将第 2 步聚合逻辑固化为 repo 内的离线工具。
