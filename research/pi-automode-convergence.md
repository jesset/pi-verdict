# pi-automode 收敛性对照:pi-verdict@0.2.0 vs @czottmann/pi-automode 当前状态

采集日期 2026-08-27;对照源为 czottmann/pi-automode `main@718aa4f`(v1.13.0 + 当日 2 个提交,最新提交 2026-08-26 13:46 UTC:#30 分类器流式超时执行)。pi-verdict 侧以 0.2.0 基准事实为准,未重新调研。

## 1. TL;DR

1. **决策思路已无本质区别**:「确定性危险 floor → 用户规则 → 确定性 allow 快路径 → 分类器兜底 → 全路径 fail-closed」这一核心架构,czottmann 自 2026-06-14 v1.0.0 起即是定式,pi-verdict 0.2.0 在移除白名单后独立收敛到同一形态。
2. **剩余差异不在架构而在三层**:ask 的语义位置(分类器三态 vs 规则层+二态分类器)、规则引擎工程深度(unbash AST vs 正则)与诊断/防篡改配套——三项均「可复制」;真正「抄不走」的只有零依赖单文件形态与证据驱动方法论。
3. **独立项目存续判断**:价值主要剩方法论叙事 + 两个未被上游采用的实验特性(三态 ask、影子缓存遥测);定位应从「架构差异化」收缩为「实验场 + 证据库」,并行评估向上游输送特性。

## 2. 收敛点清单(架构级趋同)

| # | 收敛点 | czottmann(路径) | pi-verdict(路径) |
|---|---|---|---|
| 1 | deny-first 总体管线形态 | v1.0.0(06-14)首发即有 | 0.2.0(08 月)移除白名单后到达 |
| 2 | 确定性危险 floor 先于模型 | v1.0.0:TLS 弱化/profile/authorized_keys/cron/self-edit | 0.2.0:bash 危险正则 14 条 + 路径敏感度 S0-S5 |
| 3 | 无内置确定性白名单 | `permissions.allow` 默认 `[]`;内置 allow 仅作为分类器 prompt 中的 soft-deny 例外(仅覆盖 soft-deny,永不覆盖 hard-deny) | 0.2.0 整体移除(审计结论:健全性需 shell AST) |
| 4 | floor 压过一切 allow 路径 | hard-deny 检查位于三层 allow 档之前,不可被 allow 规则越过 | floor 位于用户 allow 之前 |
| 5 | 分类器证据 = user 文本 + 工具调用输入,排除工具结果与助手散文 | token 预算化选择(各 4000,保首末 user 消息,标注省略) | 固定窗口(最近 5 user 消息 + 10 工具调用,待审动作末尾) |
| 6 | 有界输出 + 严格解析契约 | 一 token `0/1` 保守门 → 严格 JSON `{decision,tier,reason}`,畸形即 block | `<verdict>allow|ask|deny</verdict>` 前缀契约,畸形即 deny |
| 7 | 重试与超时 | detailed 重试 1 次(512/1200 双档);每请求 20s,今日起覆盖流式 | 512→1024 两档重试;25s |
| 8 | 分类器默认 = 会话模型,可专配 | `classifierModel` else `ctx.model`;`/automode model` 持久化 | 默认自省会话模型;`--auto-mode-model` |
| 9 | 只读工具路由可配 | `classifyReadOnlyTools`(默认 false = 只读快路径) | 无特例,一律 gray→分类器(等价于对方开启该开关) |
| 10 | 全路径 fail-closed | 文档明示默认姿态;模型缺失/鉴权失败/解析失败/超时/动作超上下文均 block | 同(超时/解析失败→deny) |

## 3. 残余差异表

分级:**本质**(结构性,难复制)/ **可复制**(构成当前实质行为差异,但对方能抄)/ **表面**(参数级)。

| # | 维度 | pi-verdict@0.2.0 | czottmann 当前 | 分级 |
|---|---|---|---|---|
| 1 | ask 语义位置 | 分类器三态:模型可发起 ask,运行时人工确认;非交互降级 deny | 分类器二态 allow/block;ask 仅规则层(UI confirm),接受后强制过分类器并禁用全部 allow 档;「用户明示授权」被建模为 detailed 复审中的 `explicit_intent` 允许档 | 可复制(双向:对方加 ask 枚举 / 我方加 ask 规则层均为小改),但当前是**最尖锐的哲学分歧**:运行时人类介入由模型发起 vs 人类介入仅由用户预声明的规则触发 |
| 2 | 规则匹配语法 | 正则;bash=完整命令串,文件工具=绝对路径 | glob + unbash AST:bash 多命令需结构全覆盖、重定向需显式覆盖、`bash -c`/`eval` 字面脚本穿透分析、符号链接/大小写/Unicode 归一化、递归 grep/find 域检查;畸形 deny/ask 规则 fail-closed | 可复制(需引入 AST 依赖或自研);当前为工程深度实质差距 |
| 3 | 规则防篡改 | 无 | hard-deny 编辑自身安全控制文件(`.pi` 设置、extensions 目录、自身配置),含符号链接与大小写变体绕过检测(#24/#25) | 可复制 |
| 4 | floor 可选性 | `builtinDenyFloor:false` 可整体关闭(用户主权取向) | floor 不可关,仅能整体停用;可选性全在 allow 方向 | **本质(哲学)**:对方大概率拒绝此设计;这是我方少数「抄不走」点 |
| 5 | thinking 处理 | `thinkingEnabled:false` 显式关闭 | 缺省则服务器默认;可配 low..max(`clampThinkingLevel`);文档自承高档可烧尽 512/1200 token 导致 fail-closed | 可复制(双向);当前实质行为差异,我方有 blackhole 研究背书 |
| 6 | 缓存 | 影子缓存 observe-only 遥测(LRU128 命中率/分歧计数),无生效缓存 | **无决策缓存**;`cacheRetention:"short"` + 稳定会话哈希 ID 是供应商 prompt 缓存亲和(成本优化)。委托书所称「分类器缓存」经源码核验为此,非裁决缓存 | 双方均无裁决缓存;我方独有「生效前数据积累」方法,可复制 |
| 7 | 诊断与观测 | `--auto-mode-debug`、`/automode on\|off` | `automode_inspect` 只读 agent 工具(注册源校验防冒名)+ 配套诊断 skill;JSONL 观测日志(ccusage 兼容,`classifierIo` 原始 I/O);12 条拒绝历史;状态行 `AM● a: d: ca: cd:` | 可复制 |
| 8 | 工程形态 | ~700 行单文件 / 0 依赖 / 36 桩测试 / 双语 README | 多文件 ~6700 行 / 1 依赖(unbash) / 10 测试文件 / ADR×2 / 6 份 docs / npm Trusted Publishing + provenance | **本质**(极简是价值观,非功能) |
| 9 | 维护活跃度 | npm 刚发 0.2.0 | 06-14 首发,2.5 个月 14 版,3 名外部贡献者,97 stars,采集当日仍有提交 | 表面(现状差距,可变) |
| 10 | 方法论叙事 | 证据驱动研究五份入库;白名单移除有安全审计结论支撑 | 「CC auto mode for pi」行为复刻 + ADR 记录 | **本质(不可复制)**,但非功能差异 |

## 4. 对定位的启示

- **README 对比表必须重写**:`pi-permission-landscape.md` 的对比表基于 0.2.0 前快照(「白名单 78+危险正则 13」)。移除白名单后,任何「我方 floor/白名单更厚」的暗示已反向不成立——对方 floor 更厚且不可关、规则引擎更深。差异化叙事收缩为四点:三态 ask(landscape 已确认全品类独有)、`builtinDenyFloor` 可关、零依赖单文件、影子缓存 + 证据库。
- **collaboration 评估(对 czottmann,对照 landscape 的候选分析方式)**:
  - **A. 向上游输送特性**:三态 ask(对方 JSON 契约加 `ask` 枚举 + 非交互降级 block 即可)、影子缓存遥测、`thinkingEnabled:false` 的研究证据。成本低;接受度取决于对方哲学——ask 规则层 + 强制复审可能是刻意设计(模型不发起询问,人类只在用户预声明处介入)。
  - **B. 保持独立,定位「实验场 + 证据库」**:pi-verdict 作为特性试验台,成熟特性输送上游;极简形态维持低成本存续。
  - **C. 合并/归档**:对方工程成熟度与社区已赢,合并即放弃方法论资产;仅作为退出选项。
  - 判断:**B 为主、A 并行,C 仅作退出**。「独立项目价值主要剩方法论叙事 + 两个实验特性」这一结论成立,不必护短。

## 5. 尾注

- 采集日期:2026-08-27;对照源状态:`main@718aa4f`(v1.13.0 + 2 提交,含 #30 流式超时)。
- 来源:gh api 仓库元数据与 releases;`README.md`;`docs/automode-classifier-flow.md`(15 步裁决流);`docs/configuration.md`;`CHANGELOG.md`;`extensions/auto-mode/{classifier,constants,extension,hard-deny,package}.ts`(classifier.ts 754 行、extension.ts 946 行逐段核验);`package.json`(仅 1 运行时依赖 unbash@4.0.10)。
- 一处对委托书的更正:czottmann 无「分类器(决策)缓存」,其缓存机制为供应商 prompt 缓存亲和(源码 `cacheRetention:"short"` + `classifierCacheSessionId`)。
- 顺带实证:本次采集中本机 pi-verdict floor 成功拦截了作用于 RamDisk 的 `rm -rf` 命令,deny floor 工作正常。
