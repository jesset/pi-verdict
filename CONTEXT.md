# CONTEXT

本项目的领域术语表。只收录术语定义,不含实现细节与决策记录(决策见 docs/adr/)。

## 术语

### Auto Mode

本产品(pi-verdict)的核心裁决模式:工具调用的权限不由人工逐次批准,也不全然放行(Pi 默认的 YOLO 行为),而是由**规则层 + 模型分类器**自动判定。语义对齐 Claude Code 的 Auto Mode,但方向相反:Claude Code 是"默认提示 → 分类器自动批准",Pi 是"默认放行 → 分类器自动拦截"。命名分层:扩展实体与持久物(包、入口文件、配置文件)用产品名 pi-verdict;运行时接口(CLI flag、`/automode` 命令、env 变量)用功能名 auto-mode 前缀。

### 主开关 (master switch)

Auto Mode 门禁的启用状态:会话内存态,默认开启。有三个操作面——CLI flag(跨会话)、`/automode` 命令(会话内)、toggle 快捷键(会话内,用户可配可禁用)——三者**语义等价**:同一状态的不同入口,不因入口不同而引入额外规则(无运行中限制、无确认弹窗、无持久化写回)。差异仅在反馈:命令显式提示,快捷键静默切换,状态可见性由 footer 始终显示承载。

### 判定管线 (adjudication pipeline)

从 tool_call 到三态裁决的完整判定流程,按序:自保护层 → 内置 floor → 用户 deny → denyPaths ask → 用户 allow → 灰区交分类器;ask 降级(无 UI → deny)与 fail-closed 内建于管线语义。实现形态:`adjudicate(session, call, env) → Verdict` 纯函数——零 UI 依赖的 deep module,表现(notify/confirm/select)由扩展 handler 承担。变更检测(门禁完整性)是管线前置的独立关注点,不属于判定管线。_Avoid_: 裁决管线(全仓统一用「判定管线」)。

### 裁决 (verdict)

对单次工具调用的判定结果。由 `tool_call` 钩子产出,放行则不做干预,拦截则返回 `{ block: true, reason }`。运行时载体为 `Verdict` 值对象(verdict / reason / detail / source / degraded / shadow):`detail` 为 UI-only 明文(受保护路径仅入本地确认框,ADR-0002 零泄漏承诺),`source` 区分 rule / protected-path / classifier / fail-closed,`degraded` 标记 ask 降级产物。

### 规则层 (rule layer)

判定管线的第一段:确定性规则给出硬性 allow 或 deny。由两部分组成:**内置 deny floor**(bash 危险正则 + 文件路径敏感度分级,只做 deny 声明——误报方向安全)与**用户规则**(allow/deny 正则,由用户配置并背书)。内置层不提供白名单(0.2.0 起,安全审计结论:白名单健全性需要 shell AST 分析)。

### 双形匹配

路径类规则判定的归一化纪律:同一目标路径产出**全部规范形**——词法绝对形 + realpath 形;目标尚不存在时,自最近存在祖先的 realpath 逐级重建。规则匹配对每个形逐一测试,任一形命中即生效;词法形位于 cwd 内而真实形出走 cwd 的 symlink 别名不得因此获得「项目内写入」放行(要求全部形位于 cwd 的词法/真实形之内)。自保护层与 denyPaths 自始遵循该纪律;路径敏感度 floor 自 #20 起统一。_Avoid_: 只测词法形的单形匹配(对 symlink 别名整体旁路)。

### 用户规则 (user rules)

`<agentDir>/config/pi-verdict.json` 中用户配置的 allow/deny 正则:deny 优先于 allow,黑名单命中即拦截;匹配目标为 bash 完整命令串 / 文件类工具的绝对路径。`builtinDenyFloor: false` 可整体关闭内置 deny floor(风险自担)。安全声明(「永远放行」)由用户背书而非作者。

### agentDir 自锚定 (agentDir self-anchoring)

`<agentDir>` 的解析纪律(#35,双宿主):`PI_CODING_AGENT_DIR` 显式覆盖恒优先;否则从扩展自身安装位置反推——位于 `<home>/<dot-dir>/(agent/)?(plugins/node_modules/<pkg>/)?extensions/` 之下时锚定到 `<home>/<dot-dir>/agent`(覆盖 pi 的 `~/.pi/agent` 与 omp 的 `~/.omp/agent`;omp 插件目录在 18.1+ 与 agent/ 平级(`<dot-dir>/plugins/...`),≤18.0 在其下,两种布局均匹配,配置树恒在 `<dot-dir>/agent/config/`);无从锚定时回退 `~/.pi/agent`(dev checkout)。**禁止**以宿主目录树存在性探测代替自锚定:双宿主并存的机器上,`~/.omp` 的存在不得让 pi 下的运行改道。自保护层的安装副本判定与 S0 凭据 deny 规则随同一锚点覆盖两种宿主形态。

### denyPaths (受保护路径)

用户在 config 中声明的敏感路径列表,是**路径语义声明**:归一化(`~` 展开、词法 resolve、realpath 消解符号链接,realpath 失败降级词法层,macOS/Windows 上大小写折叠)与路径段前缀比对由**工具负责**,提取范围覆盖文件类工具的绝对路径与 bash 命令串中可提取的路径 token。命中即 **ask 终局**(非交互降级 deny),优先于用户 allow、劣后于用户 deny 与内置 floor。与用户规则的 deny(正则黑名单,用户自负归一化假设)相对:同一安全声明,声明更强的通道。路径提取与命中判定全部在本地完成,分类器只见**存在性话术**(不知路径明文、不见命中调用的裁决)。_Avoid_: denyPath(单数)。泛指 "protected paths" 单独出现时易与自保护层的 protected files 混淆——本词条语境优先用全称 "user-declared protected path (denyPaths)" 或中文「受保护路径(用户声明)」。

### 存在性话术 (existence hint)

注入分类器 system prompt 的固定背景句:告知用户配置了受保护路径,擦边行为(拷贝到临时目录再读、打包、间接引用)应从紧裁决。是 denyPaths 泄漏面为零承诺的推论:分类器知道"有",不知道"是什么"。

### 自保护层 (self-protection layer)

判定管线中**不可经任何配置豁免**的内置 deny 规则集,保护对象是门禁自身的完整性(用户规则配置文件与扩展安装副本)。与用户规则相对:后者可自由增删,前者连 `builtinDenyFloor: false` 也不能关闭。语义依据:门禁之内一切写入按定义均由 agent 发起,故受保护路径对工具调用恒 deny;用户在门禁之外(编辑器等)修改不受影响。_Avoid_: 黑名单(该词保留给用户规则的 deny 正则)。

### 变更检测 (tamper detection)

对受保护文件的完整性复核,作为规则层拦截可被绕过(命令混淆、MCP 旁路)时的纵深兜底。会话内:启动时快照,每次裁决前复核;不一致时差分处置——扩展副本被改或无 UI → 从快照**自动还原** + 本会话 fail-closed;仅配置文件被改且有 UI → **确认式**(保留 = 重建基线照常,还原 = 回滚 + fail-closed)。跨会话基线(持久哈希 + 启动比对确认)为二期。

### 灰区 (gray zone)

规则层未给出硬性结论的工具调用,移交模型分类器判定的集合。

### 分类器 (classifier)

对灰区工具调用做风险判定的模型调用。模型**可配置**,默认**自省**。

### 自省 (self-reflection)

分类器的默认模型来源:继承当前会话正在使用的 provider/model 发起裁决调用(而非固定外部模型)。

### 三态裁决 (allow / ask / deny)

裁决的三档取值:规则层或分类器判定安全 → **allow**(自动放行);判定危险 → **deny**(自动拦截,返回 block 与理由);无法确定 → **ask**(转人工确认)。

### ask 降级

无 UI 可用时(非交互模式:`pi -p` / json / rpc)ask 的处置:一律按 deny 处理。是 fail-closed 在无人值守场景的推论。

### fail-closed

任何异常路径(分类器报错、超时、输出无法解析)的默认行为:拦截,绝不静默放行。

### 影子缓存 (shadow cache)

为「是否引入生效裁决缓存」积累实测数据的 observe-only 遥测:每次灰区裁决前后同步回放「双键 LRU(128)」的 would-be 命中(命令键 = 工具+输入+cwd,上下文键 = 最近 5 条 user 行),**只记录永不生效** —— 裁决永远来自模型。只回写真实模型 allow/deny,ask 与 fail-closed 不入;会话内存态,`session_start` 重置。观察口:`/automode` 统计行与 `PI_AUTO_MODE_DEBUG=1` 通知标注。
