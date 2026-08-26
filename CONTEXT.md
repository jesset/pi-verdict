# CONTEXT

本项目的领域术语表。只收录术语定义,不含实现细节与决策记录(决策见 docs/adr/)。

## 术语

### Auto Mode

本项目要构建的 Pi 扩展及其核心模式:工具调用的权限不由人工逐次批准,也不全然放行(Pi 默认的 YOLO 行为),而是由**规则层 + 模型分类器**自动判定。语义对齐 Claude Code 的 Auto Mode,但方向相反:Claude Code 是"默认提示 → 分类器自动批准",Pi 是"默认放行 → 分类器自动拦截"。

### 裁决 (verdict)

对单次工具调用的判定结果。由 `tool_call` 钩子产出,放行则不做干预,拦截则返回 `{ block: true, reason }`。

### 规则层 (rule layer)

判定管线的第一段:确定性规则(正则/AST/路径匹配)对工具调用给出硬性 allow 或 deny。覆盖面上对**所有内置工具**生效,其中 bash 的规则最厚(命令结构分析),文件类工具按路径敏感度判定。

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
