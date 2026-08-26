# 调研:Pi 工具调用权限自动裁决品类竞品全景(pi-verdict 定位基准)

> ⚠️ 本文为 0.2.0 前快照(pi-verdict 尚有内置白名单)。当前状态对照见 `pi-automode-convergence.md`(2026-08-27,含架构收敛结论与残余差异分级)。

> 对应 issue: #9(README 重写)/ #1
> 调研日期: 2026-08-26。所有数据当日一手采集:npm registry API、GitHub API / README / 源码、本地已解包源码。
> 基准:本仓库 pi-verdict(`extensions/auto-mode.ts`,~590 行单文件、零运行时依赖、三态裁决、fail-closed、影子缓存遥测)——既有事实按任务约定不再复述,仅用于对比。

## TL;DR

1. **品类已分化为三个流派,且头部都不是"模型裁决"**:(a) 确定性权限引擎——`@gotgenes/pi-permission-system`(29.0K 月下载、v27.0.1、纯规则无内置分类器)与 `cc-safety-net`(20.6K 月下载、1,505 stars、无 LLM 的语义解析拦截器,支持 11 个 CLI);(b) CC auto mode 血统的两段式模型裁决——`@czottmann/pi-automode`(2.7K 月下载、96 stars、月内 3 版,活跃度与工程成熟度最高)与停滞的 `r4vi/pi-auto-mode`;(c) 混合管线——`@zhushanwen/pi-permission`(AST+规则+单轮分类器)与已失效的 `wangzexi/pi-auto-approve`。
2. **pi-verdict 的差异化组合成立**:三态分类器语义(竞品分类器几乎全是二态 allow/block,ask 只存在于规则层)、CC 风格 transcript 上下文携带(`<verdict>` 前缀契约)、fail-closed + 非交互 ask→deny、`thinkingEnabled: false`(有本仓库 thinking-param-blackhole 研究背书;对照 czottmann 显式请求 reasoning 档位)、零依赖单文件、影子缓存 observe-only。这个**组合**在品类中没有第二个实现。
3. **但单点均有先行者,README 措辞必须避开"首个/唯一"**:两段式分类器(czottmann/r4vi 已有)、AST 级 bash 分析(zhushanwen/gotgenes 用 tree-sitter,cc-safety-net 自研解析器)、路径敏感度分层(gotgenes 的 directional path 面)、拒绝预算熔断(r4vi 的 3 连拒/20 总拒暂停会话)。pi-verdict 真正独有的资产是**证据驱动叙事**(三份实测研究)与三态×上下文×fail-closed 的组合,应按组合而非单点定位。

---

## 二、全景对比矩阵

下载量区间 2026-07-27 → 2026-08-25(api.npmjs.org)。「分类器」列指 LLM 灰区裁决。

### 表 A:裁决设计

| 项目 | 裁决语义 | 管线分层 | fail 方向 | 分类器上下文 | 输出契约 | 模型选择 |
|---|---|---|---|---|---|---|
| **pi-verdict**(基准) | 三态 allow/ask/deny | 规则(白名单78+危险13+路径S0-S5)→ 灰区分类器 | **closed**(异常→deny;非交互 ask→deny) | CC 风格 transcript(近5条 user+10次工具调用) | `<verdict>` 前缀,两档重试 512→1024 | 默认自省(继承会话模型),`--auto-mode-model` 可覆写 |
| @czottmann/pi-automode | 规则层三态;**分类器二态** allow/block | deny 规则→ask 规则→确定性 hard-deny→路径拒绝→三层 allow 档→一 token 保守过滤→结构化复审 | **closed**(模型/解析失败→block) | token 预算化 transcript 选择 | 一 token(0/1)→结构化 JSON;512/1200 双档 | 专配分类器模型(`/automode model`),可请求 reasoning 档 |
| @gotgenes/pi-permission-system | 三态 allow/ask/deny(**纯确定性**) | path 面→CWD 边界面→per-tool→bash 模式,最严者胜 | **closed**(门内部错误→block;不可解析 bash→ask) | **无分类器**(LLM 仅经 authorizerChain 可选挂载) | 无 LLM 契约;链环契约 allow/deny/defer | 可选链环自带(如 pi-permission-model-judge) |
| cc-safety-net | block / allow(解析器) | 语义命令分析(嵌套 wrapper 10 层、解释器单行)→密钥路径保护→规则书 | **closed**(畸形输入 block;Strict 档不可解析即 block) | 无 LLM | 无 | 无 |
| r4vi/pi-auto-mode | 二态(YES/NO→shouldBlock);拒绝后交互三选 | 只读白名单→hard-deny→两段分类器 | **可配置 failOpen,默认 true(fail-open!)** | `<transcript>` 会话分支携带 | 一段 YES/NO;二段 `{"shouldBlock","reason","thinking"}` | 专配模型(`/auto-mode model` 选择器) |
| flaxodev/pi-perms | 无裁决(模式切换) | 危险 bash 正则确认表(按模式) | 无(不拦截即过) | 无 LLM | 无 | 无 |
| @zhushanwen/pi-permission | 三态(outcome 含 ask) | tree-sitter AST→规则→分类器(与人工审批竞速) | **closed**(异常→ask;headless ask→deny) | **单轮无上下文** | JSON 四字段 `{outcome,risk_level,reasoning,confidence}` | `classifier.model:"auto"`(取首个有凭证 scoped 模型)或精确指定 |
| wangzexi/pi-auto-approve | 二态 allow/block | 15 条放行正则→7 条阻止正则→自省复审 | **open**(超时/错误/解析失败→放行) | 完整对话上下文(剔除 toolCall/toolResult,CDATA 包裹命令) | 恰好两键 `{"verdict","reason"}` | 自省(同会话模型),复用主会话前缀缓存 |

### 表 B:工程与运营

| 项目 | 规则层能力 | 模式/UX | 配置面 | 依赖/体量 | 测试 | 缓存/遥测 | 月下载 | 活跃度(截至 08-26) | 许可 |
|---|---|---|---|---|---|---|---|---|---|
| **pi-verdict** | 白名单78+危险正则13+路径敏感度 S0-S5 | /automode on\|off;footer;--auto-mode-debug | CLI flag + JSON(见仓库) | **0 运行时依赖**;~590 行单文件 | 仓库测试 | 影子缓存遥测(observe-only)+三份实测研究 | 未发布 npm | 本仓库 | MIT |
| @czottmann/pi-automode | CC permissions.deny/ask/allow + hard-deny + deniedPaths glob(符号链接解析、递归 grep/find 域检查) | 8 条 /automode 子命令;状态行 `AM● a: d: ca: cd:`;`automode_inspect` 只读 agent 工具+配套 skill;ADR 文档 | 全局+项目 local(受信后)+env;**共享项目文件不可削弱策略(防篡改)** | 1 依赖(unbash);262KB | 10 个测试文件(含分类器路由/暂存解析与缓存/符号链接) | 分类器缓存;拒绝计数器;可观测日志 | 2,725 | v1.13.0(08-25);6-14 首发,17 版;当日仍有 push | MIT |
| @gotgenes/pi-permission-system | tree-sitter bash 门;**方向性 path 面**(读/写分离);MCP/skill 粒度门;隐藏被禁工具;子代理集成 | 行内热键审批对话框(y/s/n/r 双击确认);会话级批准;事件广播 | 全局+项目(受信门控)+每 agent frontmatter;后匹配胜 | 3 依赖(tree-sitter×2+zod);1.37MB;144 个 src 文件 | **147 个测试文件** | review-log(gate_error 等)审计 | **28,976** | v27.0.1(08-24);5-03 首发,186 版 | MIT |
| cc-safety-net | 语义解析(重排 flag/wrapper/单行解释器逃逸检测);密钥保护(SSH/.env/.aws/凭证库,跨工具);SHA-256 锁定的规则书 | Standard/Strict/Paranoid 预设;status/doctor/explain/logs/gui CLI;Web GUI | 规则书(用户/项目)+预设 | 1 依赖(zod);1.76MB;跨 11 CLI | CI+codecov(README 徽章) | **本地 JSONL 审计日志(脱敏,默认 30 天)** | 20,563 | v2.2.2(08-25,当日 3 版);2026-01 首发,37 版 | MIT |
| r4vi/pi-auto-mode | 只读白名单(合并 .claude settings allowlists)+hard-deny;**拒绝预算**(3 连拒/20 总拒→暂停会话) | footer;拒绝历史 widget;拒绝后三选(阻止/放行一次/关自动模式并放行);系统提示注入 | auto-mode.example.json | 0 依赖(但 peer 锁旧 @mariozechner/* 命名空间);50KB;1,171 行单文件 | 有 CI(publish.yml);测试未见 | 拒绝计数/历史 | 6x | v0.1.2(**2026-05-16,停滞 3 个月**) | MIT |
| flaxodev/pi-perms | 硬编码危险 bash 正则表(rm -rf/sudo/git push/curl\|sh/DDL 等) | **Shift+Tab 四模式循环**(normal/accept edits/plan/bypass)+footer 指示;跨重启持久化;/perms | 无配置文件 | 0 依赖;单文件 extensions/index.ts | 未见 | 无 | 未上 npm(npm `pi-perms` 属 Mearman) | 仓库 08-25 有 push,但无 npm 发布通道 | MIT |
| @zhushanwen/pi-permission | tree-sitter AST(11 节点白名单,Codex bash.rs 移植)+50 无条件/9 条件安全命令+12 危险正则+**TUI 规则编辑器** | 四模式 yolo/auto/approve/strict;statusline 调色 | `<agentDir>/config/permission-ext-config.json`(首启自动生成) | 4 依赖 + 3 peer;568KB | **25 个测试文件**(本地实测 find 计数) | 无缓存 | 1,326 | v1.3.3(08-24);8 月连发 3 版 | MIT |
| wangzexi/pi-auto-approve | 15 放行 + 7 阻止正则 | /autoapprove 开关;toast 显示缓存命中率 | 仅 env 调试变量 | 单文件;依赖旧 pi-ai 包根导出(**pi-ai@0.84.3 已失效,实测 undefined**) | 未见 | 缓存命中率 toast | 不在 npm(404) | 仓库 06-20 后无 push;**运行时已坏** | 未标(仓库无 LICENSE 检出) |

---

## 三、逐项目要点(核心机制 + 来源)

### 3.1 @czottmann/pi-automode(用户点名重点)

- CC auto mode 的独立重实现;明确免责:「It is not a sandbox」「不守护用户 `!`/`!!` 命令」。README 自承 CC 真实分类器私有,本包实现的是"已文档化的优先级与配置行为"。(源:github.com/czottmann/pi-automode README)
- 15 步裁决流:deny 规则→ask 规则(接受后**强制过分类器**)→确定性 hard-deny(shell profile/authorized_keys/cron/TLS 弱化/self-modification)→路径拒绝(含符号链接别名与递归搜索域)→三层 allow 档(CWD 内/permissions.allow/只读工具)→**一 token 保守过滤**(安全则过,畸形即 block)→结构化复审。**默认 fail-closed**。(源:docs/automode-classifier-flow.md)
- 与 pi-verdict 的三处正面对照:(1) 分类器二态 vs 三态;(2) `classifierReasoningLevel` 显式**请求** reasoning(low≈Codex Auto Review)vs pi-verdict `thinkingEnabled:false` 显式关思考(有 thinking-param-blackhole 研究支撑);(3) 配置防篡改(共享项目文件只能加严不能放宽)领先。
- 工程成熟度标杆:`automode_inspect` 只读 agent 工具 + 配套诊断 skill、状态行遥测、8 条子命令、ADR、npm Trusted Publishing + provenance、10 个测试文件。1 个运行时依赖(unbash,bash AST 解析)。
- 维护活跃度:6-14 首发,8 月 2.7K 月下载、96 stars、v1.13.0(08-25)、当日 push。(源:npm API、GitHub API)

### 3.2 @gotgenes/pi-permission-system(品类下载量头部)

- MasuRii/pi-permission-system 的深度 fork;**纯确定性权限引擎,无内置 LLM 分类器**;LLM 裁决只能经 `authorizerChain` 可选挂载(第一方参考实现 pi-permission-model-judge「deny-first 审查器」;第三方 pi-permission-ai-guard 也走此缝)。(源:gotgenes/pi-packages packages/pi-permission-system README)
- 四层最严者胜:path 横切面(读写方向分离 path_read/path_write)→ external_directory(CWD 边界,方向性)→ per-tool 模式 → bash 模式(tree-sitter 解析;`bash -c`/`eval`/`sudo`/`env`/`xargs`/`find -exec` 等间接包装一律 ask)。v16 起 bash 门 fail-closed,门内部错误→block 并记 gate_error 审计。
- 独有能力:agent 启动前**隐藏被禁工具**;MCP 服务器/工具与 skill 名粒度门;与 pi-subagents 原生集成(子代理 ask 上浮父会话);事件总线广播。
- 规模:144 src 文件 / 147 测试文件 / 3 依赖 / 1.37MB / 186 个版本(5-03 起)。项目配置须项目受信后才加载(不受信仓库不能放宽全局策略)。
- 与 pi-verdict 差异一句话:它是「不请模型的最严门」,pi-verdict 是「规则未尽处让模型带着上下文裁决」——前者赢在确定性与覆盖面,后者赢在灰区分辨率。

### 3.3 cc-safety-net(跨 CLI 生态,非 pi 原生)

- 定位:跨 11 个编码 CLI(Claude Code/Codex/Cursor/Gemini CLI/OpenCode/Pi 等)的 PreToolUse 拦截器;**无 LLM**,靠语义命令解析:flag 重排、shell wrapper(嵌套 10 层)、解释器单行(`python -c` 内 `os.system("rm -rf /")`)均不可逃逸;能区分 `git checkout -b`(放)与 `git checkout --`(拦)。(源:github.com/kenryu42/cc-safety-net README)
- **Pi 端集成形态是进程内扩展**(`pi install npm:cc-safety-net`),非 hook 子进程;但 Pi 适配器只把内建 `bash` 工具按 shell 命令分析,其他工具仅做受保护路径检查,不支持自定义 Shell 工具——覆盖面窄于 pi 生态原生扩展。(源:ccsafetynet.com/docs/installation Pi 节)
- fail-closed:畸形 hook 输入即拦;Strict 档不可解析即拦;**配置损坏不拦**(回退保护性默认并上报)——与 pi-verdict 的方向一致但对配置错误宽容。
- 运营最重:三档预设、SHA-256 锁定规则书、本地脱敏 JSONL 审计(默认 30 天)、doctor/explain/logs/gui 全套 CLI、中英日三语文档站。1,505 stars、2026-01 首发(品类最早)。
- 与 pi-verdict 差异一句话:它是「无模型的跨 CLI 拦截网」,与灰区模型裁决互补而非同类;其密钥保护与审计日志是 pi-verdict 影子缓存遥测可对标的产品化样板。

### 3.4 r4vi/pi-auto-mode(npm: pi-auto-mode——本仓库曾用名的占位者)

- lghupan/cc-automode 的 pi 移植:只读白名单(并合并 `.claude/settings*.json` 的 allowlists)→确定性 hard-deny→**两段分类器**(一段 YES/NO 保守过滤,"Err toward YES if uncertain";二段 `{"shouldBlock","reason","thinking"}` JSON)。两段均携带 `<transcript>`(取自 sessionManager.getBranch)。(源:github.com/r4vi/pi-auto-mode README + extensions/auto-mode.ts:585-658)
- **`failOpen` 默认 true**(源码 :53,异常路径 :1085-1096)——品类中唯一默认放行的活跃实现,README 未声明此默认。
- 拒绝预算:3 连拒/20 总拒→自动暂停会话(源码 :828-832);拒绝后交互三选(阻止/放行一次/关自动模式并放行)。
- 现状:v0.1.2(05-16)后停滞,61 月下载,peer 依赖仍锁旧 `@mariozechner/*` 命名空间。**命名撞车是本仓库 README 必须处理的现实**:npm `pi-auto-mode` 与本仓库曾用名同名但属他人。

### 3.5 flaxodev/pi-perms(注意与 Mearman/pi-perms 的命名冲突)

- CC 式权限模式切换器:Shift+Tab 循环 normal/accept edits/plan/bypass 四模式,footer 彩色指示,跨重启持久化;/perms 选择器。「危险 bash」为硬编码正则表(rm -rf、sudo、git push、npm publish、curl|sh、DDL 等),无 AST、无 LLM、无 fail 语义。(源:github.com/flaxodev/pi-perms README)
- **npm `pi-perms` 与它无关**:该包名属 Joseph Mearman(Mearman/pi-perms,Apache-2.0,v2.1.0 于 05-12 后停滞),是另一个项目——从 `.agents/permissions.json` 加载跨 agent 策略、deny→ask→allow 评估、基于 agent-perms 库的纯规则薄封装。(源:npm view pi-perms maintainers/repository;github.com/Mearman/pi-perms README)
- 与 pi-verdict 差异一句话:模式切换与自动裁决正交(plan/bypass 是会话姿态,不是逐调用裁决),可共存;它补齐的是 pi 缺失的 CC 快捷键体验。

### 3.6 @zhushanwen/pi-permission@1.3.3(本地源码核验)

- 四模式(yolo/auto/approve/strict)× 三层管线:tree-sitter AST(11 节点白名单,Codex bash.rs 忠实移植;>65536 字符或解析失败→fail-closed)→规则(50 无条件+9 条件安全命令、12 危险正则、用户规则+TUI 编辑器)→分类器(**单轮无上下文**,JSON 四字段契约,autoDenyHighRisk 可把 high+allow 强制改判 deny;与人工审批**竞速**,用户先答即 abort AI)。(源:本地解包 `~/tmp/pi-permission-pkg/package`,及本仓库 research/pi-model-call-and-ref-implementations.md §3.1)
- fail-closed:一切异常→ask;headless 下 ask→deny。无缓存。
- 本地核验补正:运行时依赖 4 个(tree-sitter-bash、web-tree-sitter、@zhushanwen/pi-extension-logger、@zhushanwen/pi-llm-shared)+3 个 peer;`*.test.*` 文件实测 **25 个**(src/__tests__ 15 + 子目录 10)。
- 与 pi-verdict 差异一句话:它是「AST 最重、模型最轻」的混合(分类器单轮盲判),pi-verdict 反之(轻规则、重上下文分类)——两者在管线重心上互为镜像。

### 3.7 wangzexi/pi-auto-approve(复用本仓库既有提取)

- 三层:15 放行正则→7 阻止正则→自省复审(同会话模型+完整对话上下文,剔除 toolCall/toolResult 防格式串扰,命令用 CDATA 包裹,`cacheRetention:"short"`+sessionId 复用主会话前缀缓存,toast 显示命中率)。契约恰好两键 `{"verdict","reason"}`。(源:research/pi-model-call-and-ref-implementations.md §3.3;github.com/wangzexi/pi-auto-approve)
- **fail-open**:30s 超时/错误/解析失败一律放行(仅无 UI 或无模型时 block)——与 pi-verdict 方向相反。
- 已死亡:不在 npm(404),仓库 06-20 后无 push,且 `completeSimple` 导入在 pi-ai@0.84.3 包根已不存在(既有提取实测)。
- 与 pi-verdict 差异一句话:品类中唯一 fail-open 且唯一做过"分类器复用主会话缓存前缀"的实验品,两者分别成为 pi-verdict 的反面教材与缓存设计参照。

---

## 四、对 #9 README 的启示

**定位话术**

1. 主关键词避开「auto mode」:npm `pi-auto-mode` 是 r4vi 的停滞包,`@czottmann/pi-automode` 是活跃强者,SEO 与心智都被占;「permission」被 pi-permission/pi-permission-system 占。**verdict(裁决)是空位命名,且三态语义自带解释**——#9 的命名段落方向正确,应升格为定位主轴:「大多数竞品的分类器只会二值 allow/block;verdict 是裁决,不是开关」。
2. 一句话定位建议骨架:「Pi 默认 YOLO。verdict 给每次工具调用一个三态裁决:allow / ask / deny——规则先行,灰区交给带完整上下文的分类器,任何失败都 fail-closed。」(与 #9 要求 1 一致,已验证不与任何竞品表述撞车)
3. 抄两段成熟的免责话术:czottmann 的「It is not a sandbox」与 cc-safety-net 的「Why not just use a sandbox?」——品类头部都显式声明非安全边界,pi-verdict README 应同等声明,这是品类共识而非示弱。

**该强调**(按证据强度排序)

4. 组合而非单点:「三态 × transcript 上下文 × fail-closed × 零依赖单文件」四件套无第二个实现——表 A 可直接裁剪成 README 轻量对比表(建议只留:三态?/携带上下文?/fail 方向/运行时依赖 4 列)。
5. 证据驱动品牌:三份实测研究是全品类独有资产(竞品 README 无一附实测数据);cache-sim 的命中率数据、thinking-param 的三层取证、rule-engine-sim 的移植否决,分别回答竞品无法回答的「为什么默认这样配」。czottmann 的「Known limits」诚实段是范本,pi-verdict 可以用研究链接替代口头承认。
6. `thinkingEnabled: false` 值得写成一行卖点:对照 czottmann 显式请求 reasoning(其文档自承高推理档会烧尽 512/1200 token 导致 fail-closed),pi-verdict 的选择有 blackhole 研究背书——但表述为「我们测过」而非点名贬低。

**该避免**

7. 不用「首个/唯一/lightweight 之首」类最高级:cc-safety-net 2026-01 已存在,gotgenes 5 月起发了 186 版;「零依赖单文件」可说,「最轻」不可说(r4vi 50KB 更小)。
8. 不引用下载量/stars 对比(未发布 npm,数据上必输),不用「比 X 更安全」式点名攻击。
9. 不把 fail-open 竞品当靶子:wangzexi 已失效,r4vi 默认 failOpen 但可配置——攻击点会过时;只正面陈述自己的 fail-closed 语义(含非交互 ask→deny,这一细节竞品 README 均未强调)。
10. 不暗示规则覆盖面领先:白名单 78 条 vs zhushanwen 59 条安全命令+AST、gotgenes 四层门——规则规模不是差异化,分辨率(灰区三态)才是。

---

## 尾注:数据与来源

- 采集日期:2026-08-26(npm 下载量窗口 2026-07-27 → 2026-08-25;GitHub pushed_at / stars 为当日快照)。
- npm registry:`npm view <pkg>` 与 api.npmjs.org/downloads——@czottmann/pi-automode、@gotgenes/pi-permission-system、cc-safety-net、@zhushanwen/pi-permission、pi-auto-mode(r4vi)、pi-perms(Mearman)。
- GitHub README / docs(github.com):
  - czottmann/pi-automode(README、docs/automode-classifier-flow.md、docs/configuration.md)
  - gotgenes/pi-packages(packages/pi-permission-system/README.md、git trees 计数)
  - kenryu42/cc-safety-net(README)+ ccsafetynet.com/docs/installation(Pi 集成节)
  - r4vi/pi-auto-mode(README、extensions/auto-mode.ts@master 源码 1,171 行)
  - flaxodev/pi-perms、Mearman/pi-perms、wangzexi/pi-auto-approve(README)
- 本地源码:`~/tmp/pi-permission-pkg/package`(@zhushanwen/pi-permission@1.3.3 npm tarball 解包,依赖与测试数当日复核)。
- 本仓库复用:research/pi-model-call-and-ref-implementations.md §3.1(zhushanwen)、§3.3(wangzexi)、§3.4(gotgenes Authorizer 链缝)。
