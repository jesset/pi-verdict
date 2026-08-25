# 调研报告：Pi（pi-coding-agent）中是否存在类似 Claude Code "Auto Mode" 的模型自动权限分类功能

调研日期：2026-08-25
调研对象：Pi coding agent（Mario Zechner / badlogic 开发）

> 注意：仓库与 npm 包已更名。GitHub 仓库 `badlogic/pi-mono` 现重定向至 **`earendil-works/pi`**；npm 包由 `@mariozechner/pi-coding-agent` 更名为 **`@earendil-works/pi-coding-agent`**（当前版本 0.73.x+，源码 clone 于 /Volumes/RamDisk/pi-mono，HEAD commit a79b373，2026-08-25）。
> 证据：`packages/coding-agent/package.json:2` `"name": "@earendil-works/pi-coding-agent"`；`gh api repos/badlogic/pi-mono` 返回 `full_name: earendil-works/pi`。

---

## 结论速览

| 问题 | 结论 |
|---|---|
| Pi 默认有工具调用确认提示吗？ | **没有**。工具调用默认全部直接执行（"YOLO by default"），无确认、无静态 allowlist |
| Pi 内置模型自动分类判定（Auto Mode）吗？ | **没有**。作者明确拒绝内置任何形式的权限提示与模型预检 |
| 扩展系统能否拦截/审批工具调用？ | **能**。`tool_call` 事件钩子可阻塞、可改参数、可异步执行（可发起模型调用） |
| 有现成的"模型自动审批"扩展吗？ | **有，且不止一个**。最接近 Auto Mode 的是 `@zhushanwen/pi-permission`（auto 模式 = AST + 规则 + AI 风险分类器） |

---

## 1. Pi 的工具调用权限/审批机制

### 1.1 默认行为：完全无审批（YOLO by default）

Pi 的核心设计哲学是**不内置任何权限系统**：工具调用（read/write/edit/bash）默认不经任何确认直接执行。

- `packages/coding-agent/docs/usage.md:308`：
  > "It intentionally does not include built-in MCP, sub-agents, **permission popups**, plan mode, to-dos, or background bash. You can build or install those workflows as extensions or packages…"
- 作者博客《pi: a minimal coding agent》（2025-11-30）"YOLO by default" 一节（https://mariozechner.at/posts/2025-11-30-pi-coding-agent/）：
  > "pi runs in full YOLO mode and assumes you know what you're doing. It has unrestricted access to your filesystem and can execute any command without permission checks or safety rails. **No permission prompts for file operations or commands. No pre-checking of bash commands by Haiku for malicious content.**"
  >
  > （注意：这句明确点名了 Claude Code 用 Haiku 预检 bash 命令的做法，并声明 Pi 不做。作者认为权限机制是 "security theater"，建议用容器隔离代替。）
- `packages/coding-agent/docs/security.md:33`：
  > "Pi does not include a built-in sandbox. Built-in tools can read files, write files, edit files, and run shell commands with the permissions of the pi process."
- 维护者在 issue #6716（"Bash tool has no destructive command guardrails"）中的官方表态（https://github.com/earendil-works/pi/issues/6716）：
  > "This is entirely by design. There are plenty extensions adding various type of guardrails. See 'Yolo by default' here: …"

### 1.2 没有静态 allowlist

核心源码（`src/core/tools/bash.ts` 等）中不存在 allowlist/denylist/确认流程；全仓库 grep `yolo`/`auto-approve`/`classifier` 均无核心实现命中。

### 1.3 注意区分：`--approve` 不是工具调用审批

CLI 的 `-a/--approve` 标志只用于 **project trust**（是否信任项目目录下的 `.pi/` 本地扩展/设置），与逐次工具调用审批无关。
- `packages/coding-agent/docs/settings.md:16`：「Pass `--approve`/`-a` or `--no-approve`/`-na` to override project trust for one run.」
- `packages/coding-agent/docs/usage.md:247`

---

## 2. 是否内置"模型自动分类判定"（Auto Mode 对应物）

**没有。** Pi 核心不含任何由 LLM 对工具调用进行风险分类的逻辑；博客明确把"用 Haiku 预检 bash 命令"列为 Pi 刻意不做的事情（见上文引用）。该能力被刻意留给扩展生态实现。

---

## 3. 扩展系统的拦截能力（实现 Auto Mode 的技术基础）

Pi 的扩展 API 提供了 `tool_call` 事件钩子，**完全足以实现模型自动审批**：

- `packages/coding-agent/docs/extensions.md:760` 起的 `#### tool_call` 一节：
  - 触发时机：`tool_execution_start` 之后、工具执行之前，**"Can block."**
  - 处理函数是 async 的，可在其中发起模型调用、`fetch()` 等（`ctx.signal` 支持取消）
  - `extensions.md:774`：返回值控制阻塞——`{ block: true, reason?: string, terminate?: boolean }`
  - `event.input` 可变，可在执行前改写工具参数
  - `extensions.md:2904`：「`tool_call` errors block the tool (fail-safe)」——异常即阻塞，fail-closed
- `extensions.md:19` 把 "Permission gates (confirm before `rm -rf`, `sudo`, etc.)" 列为扩展的典型用途
- 官方示例 `packages/coding-agent/examples/extensions/permission-gate.ts`：用正则匹配危险命令后通过 `ctx.ui.select` 弹确认框（静态规则 + 人工确认，非模型分类）
- 相关 API：`ctx.ui.confirm/select`、`ctx.hasUI`（非交互模式下无 UI 可 fail-closed）、`pi.on("tool_result")` 可改写结果

结论：**扩展可以拦截每一次工具调用、同步/异步判定后放行或阻塞**——模型自动分类判定在机制上完全可实现，且已有多个实现（见下节）。

---

## 4. 现成的"模型自动审批"扩展（重点）

### 4.1 `@zhushanwen/pi-permission` —— 最接近 Claude Code Auto Mode

- npm：`@zhushanwen/pi-permission`（v1.3.3，2026-08-24 更新）；安装 `pi install npm:@zhushanwen/pi-permission`
- 描述（npm README 原文）：「四档权限模式（**yolo / auto / approve / strict**）+ 三层安全管道（AST 结构分析 + 规则匹配 + **AI Classifier**）」
- 其 **auto 模式**即 Auto Mode 对应物：
  1. 层 1 AST 结构分析（tree-sitter-bash，检测 subshell、命令替换、重定向等危险结构）
  2. 层 2 规则匹配（内置 50+9 条安全白名单、12 条危险规则、用户自定义规则，last-match-wins）
  3. 层 3 **AI Classifier**：用 LLM 评估未知命令风险等级（low/medium/high），并与用户审批"竞速"；`autoApproveLowRisk: true`（低风险自动放行）、`autoDenyHighRisk: true`（高风险自动拦截）
- fail-closed 设计：「任何异常路径 → block（绝不静默放行）」
- 仅覆盖 bash 工具调用

### 4.2 `@gotgenes/pi-permission-system` + authorizer 生态

- npm：`@gotgenes/pi-permission-system`（v27.0.1，高频更新）；源码 https://github.com/gotgenes/pi-packages/tree/main/packages/pi-permission-system
- 本体是**确定性**规则引擎：allow/ask/deny 三态，覆盖工具、bash、MCP、skill、路径（含符号链接解析）、cwd 边界等多个层面，「Fails closed」
- 关键：提供 **`authorizerChain` 接缝**——当规则引擎判定为 `ask` 时，先咨询已注册的"逐案裁决链"（可注册模型裁决器），再决定是否弹出人工提示。README 原文：
  > "The optional `authorizerChain` field names registered case-by-case decision links (**e.g. a light model judge**) to consult when a request lands on `ask`, ahead of the interactive prompt."
- 基于该接缝的模型裁决器实现：
  - **`@gotgenes/pi-permission-model-judge`**（第一方参考实现）：用小模型审查 `external_directory` 类 ask，自动 deny 疑似笔误的路径并给出解释。**deny-first 设计，只自动拒绝、永不自动放行**（"this extension only ever _removes_ a hand-denial, never grants access"）——因此它不是完整 Auto Mode。
  - **`pi-permission-ai-guard`**（npm）：「Token-optimized LLM permission reviewer」，用精简后的对话上下文（剥离 assistant 文本与工具结果以防注入）让轻量模型裁决**所有 surface 的 ask 请求**，带裁决缓存与熔断器，fail-safe defer（模型不确定则回落到人工提示）。
  - **`@mzwing/pi-permission-auto-review`**（npm）：「Codex-style automatic approval reviews」，复用 OpenAI Codex 的 `codex-auto-review` 模型与 Codex Guardian 的 policy 文本（policy_template.md/policy.md）对权限请求做自动审查。

### 4.3 `wangzexi/pi-auto-approve`（GitHub，中文文档）

- 仓库：https://github.com/wangzexi/pi-auto-approve；安装 `pi install git:github.com/wangzexi/pi-auto-approve`
- 三层防护：1) 正则白名单自动放行（`ls`/`git status` 等）；2) 正则黑名单自动阻止（`rm -rf /`、`mkfs.` 等）；3) **同模型自省审查**——用当前会话同一模型、复用主会话前缀（利于 prompt 缓存命中）对命令做风险裁决，返回 `{"verdict":"allow"|"block"}`；通过的命令不注入任何审批痕迹
- 通过 `/autoapprove` 命令开关

### 4.4 其他相关（静态规则型，非模型分类）

- 社区讨论 #3373（https://github.com/earendil-works/pi/discussions/3373）中 @prateekmedia 的 "Permission" 扩展：approve once/always/never 弹窗，类 Claude Code 传统权限提示，非模型分类
- `pi-permission`（npm）：分层权限控制扩展
- 官方示例 `examples/extensions/permission-gate.ts`：正则 + 人工确认

---

## 5. 两类机制的区分（按调研要求明确）

| 机制 | Pi 中的形态 |
|---|---|
| 无人值守/全放行开关（yolo） | **Pi 的默认且唯一的内置行为**（核心无任何审批），扩展 `@zhushanwen/pi-permission` 的 `yolo` 档也是此语义 |
| 静态 allow/deny 规则 + 人工确认 | 非内置；由扩展实现（`@gotgenes/pi-permission-system`、`permission-gate.ts`、@prateekmedia 的 Permission 等） |
| **模型自动分类判定（Auto Mode 对应物）** | **核心没有**；由第三方扩展实现：`@zhushanwen/pi-permission`（auto 档，AI 风险分类 low/medium/high + 自动放行/拦截）、`pi-permission-ai-guard`、`@mzwing/pi-permission-auto-review`、`wangzexi/pi-auto-approve` |

---

## 6. 证据来源清单

一手源码（clone 于 /Volumes/RamDisk/pi-mono，HEAD a79b373）：
- `packages/coding-agent/docs/usage.md:308`（不内置 permission popups）
- `packages/coding-agent/docs/security.md:33`（无内置 sandbox）
- `packages/coding-agent/docs/settings.md:16`、`docs/usage.md:247`（`--approve` 仅为 project trust）
- `packages/coding-agent/docs/extensions.md:19, 760-820, 2904, 2942`（tool_call 钩子可阻塞、fail-safe、permission-gate 示例）
- `packages/coding-agent/examples/extensions/permission-gate.ts`
- `packages/coding-agent/package.json:2`（包名 @earendil-works/pi-coding-agent）

网络来源：
- 作者博客：https://mariozechner.at/posts/2025-11-30-pi-coding-agent/ （"YOLO by default" 一节）
- 设计表态 issue：https://github.com/earendil-works/pi/issues/6716
- 社区扩展讨论：https://github.com/earendil-works/pi/discussions/3373
- `@gotgenes/pi-permission-system` README：https://github.com/gotgenes/pi-packages/tree/main/packages/pi-permission-system
- `@gotgenes/pi-permission-model-judge` README：https://github.com/gotgenes/pi-packages/tree/main/packages/pi-permission-model-judge
- npm：`@zhushanwen/pi-permission`、`pi-permission-ai-guard`、`@mzwing/pi-permission-auto-review`、`pi-permission`（`npm view <pkg> readme`）
- GitHub：https://github.com/wangzexi/pi-auto-approve 、https://github.com/zefi-dev/pi-auto-approve
