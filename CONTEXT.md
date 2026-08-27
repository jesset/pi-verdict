# CONTEXT

本项目的领域术语表。只收录术语定义,不含实现细节与决策记录(决策见 docs/adr/)。

## 术语

### Auto Mode

本项目要构建的 Pi 扩展及其核心模式:工具调用的权限不由人工逐次批准,也不全然放行(Pi 默认的 YOLO 行为),而是由**规则层 + 模型分类器**自动判定。语义对齐 Claude Code 的 Auto Mode,但方向相反:Claude Code 是"默认提示 → 分类器自动批准",Pi 是"默认放行 → 分类器自动拦截"。

### 裁决 (verdict)

对单次工具调用的判定结果。由 `tool_call` 钩子产出,放行则不做干预,拦截则返回 `{ block: true, reason }`。

### 规则层 (rule layer)

判定管线的第一段:确定性规则给出硬性 allow 或 deny。由两部分组成:**内置 deny floor**(bash 危险正则 + 文件路径敏感度分级,只做 deny 声明——误报方向安全)与**用户规则**(allow/deny 正则,由用户配置并背书)。内置层不提供白名单(0.2.0 起,安全审计结论:白名单健全性需要 shell AST 分析)。

### 用户规则 (user rules)

`<agentDir>/config/pi-verdict.json` 中用户配置的 allow/deny 正则:deny 优先于 allow,黑名单命中即拦截;匹配目标为 bash 完整命令串 / 文件类工具的绝对路径。`builtinDenyFloor: false` 可整体关闭内置 deny floor(风险自担)。安全声明(「永远放行」)由用户背书而非作者。

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
