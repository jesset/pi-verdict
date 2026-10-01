# 调研: Pi 0.87.1 → 0.99.2 升级差异及其对 pi-verdict 工作模式的影响评估

> 调研日期: 2026-10-01（当日两轮：源码级核实 + 随库实测复核）
> 背景: pi 宿主从 0.87.1（2026-09-22）跨到 0.99.2（2026-09-30）经历了一次准 1.0 级大版本（0.99.0）。评估这区间全部变化对 pi-verdict（规则层 + 分类器的 tool_call 权限门）的影响。
> 核实方法: pi.dev/changelog 全文 + pi 源码逐项核实（克隆基线 `earendil-works/pi@0f8740b`，即 v0.99.2 的 main HEAD，2026-10-01）+ npm dist 包逐文件核对（`node_modules/@earendil-works/pi-coding-agent@0.99.2` 与 `pi-ai`，静态证据均给出 dist 路径）+ 本仓库 `extensions/pi-verdict.ts`（0.12.1）、`extensions/jev-adapter.ts` 全文对照 + 沙箱实测（见第五节）。文中源码行号均指克隆基线；dist 路径为同版本发布产物。

## TL;DR

1. **版本范围**：npm 上 0.87.1 之后直接跳 0.99.0，**不存在 0.88–0.98**（跳号直奔 1.0 的发布策略）。区间内实际只有三个版本：0.99.0（2026-09-29，巨量变更）、0.99.1（GPT-6.1 Sol 模型）、0.99.2（MCP 认证与 codemode 描述瘦身）。评估对象基本就是 0.99.0。
2. **核心安全模型未被破坏，且已在源码层面核实**：0.99.0 引入 codemode（模型写 JS 在 QuickJS 沙箱内经 `ctx.executeTool()` 间接调工具）+ MCP 工具默认 codemode 暴露——这是 pi-verdict 威胁模型最大的新变量。但 pi 源码确认嵌套调用走**完整 agent tool pipeline**，官方注释原话："validation, `tool_call`/`tool_result` hooks, and permission checks apply **exactly as for direct calls**"（`src/extensions/codemode/tool.ts` 头注释；实现见 `src/core/nested-tool-calls.ts`）。pi-verdict 的 block 会以 Error 形式回传给沙箱脚本。且 **codemode 默认不启用**（需 `defaultTools: ["+codemode"]` 或 `--tools` 显式开启），默认会话的威胁面不变。
3. **最大定位冲击是 classifier 基建被上游官方化**：pi 内置了 TypeSafe jev classifier（`typesafe/jev-latest` 直连 + `typesafe/jev-1.13` 等，分布在 typesafe / OpenRouter / Cloudflare Workers AI / Vercel AI Gateway / OpenCode Zen）、`ModelRuntime.classify()`（runtime-resolved auth、Never rejects）、llama.cpp 本地分类器、virtual models + 官方 `jev-router.ts` 示例。本仓库 `jev-adapter.ts`（363 行、双 transport 自维护）的运输层价值被大幅吸收；但 pi 官方把 jev 用于 **model routing**，pi-verdict 的核心价值（**权限门管线**：deny floor + denyPaths + 三态裁决 + 审计 + 自保护层）未被吸收。迁移到 `classify()` 还能让 `classifierMinConfidence` 直接消费原生的数值 `confidence`（不再需要 `parseJevConfidence` 文本回读），并顺带消解 2.2 节的同名遮蔽。
4. **API 兼容性已双重验证（源码逐项 + 实测）**：pi-verdict 用到的每一个 pi API（`tool_call` 事件、`registerFlag/Command/Shortcut`、`ctx.modelRegistry.complete/find/hasConfiguredAuth/getProviderAuth`、`ctx.ui.*`、`ctx.sessionManager.getBranch/getSessionId`、`registerProvider`、pi-ai 的 `createProvider/createAssistantMessageEventStream`、`/compat` 子路径）在 0.99.2 中全部保留且签名兼容；扩展加载仍走 jiti（0.99.0 的 Node type stripping 只用于 pi 自身源码运行），源码里的 TS 语法（含 constructor parameter properties）不受影响。**实测（第五节）：devDeps 换 0.99.2 后 typecheck 零错误、252/252 测试通过、干净 agent 目录 headless 实跑扩展加载与 decisions 分类端到端成功。**
5. 需要行动的四个点：① codemode 会话下的拦截冒烟/集成测试；② 评估 jev-adapter → `classify()` 迁移（可删运输层，代价是 omp 兼容路径），迁移决策需一并处置 2.2 节的 `typesafe` 同名遮蔽（接受并记录 / feature-detect 双轨 / 全量迁移）；③ devDeps 0.84.3 → 0.99.2 + CI 版本矩阵（typecheck/test 已实测通过，见第五节）；④ README 更新（codemode/MCP 关系与缓解、可选分类器矩阵、MCP 工具名的 `_` 归一化陷阱）。

---

## 一、版本范围澄清

- npm `@earendil-works/pi-coding-agent` versions 列表：`... 0.87.0, 0.87.1, 0.99.0, 0.99.1, 0.99.2`，无中间版本。GitHub releases 同。
- 时间线：0.87.1（09-22，前沿模型支持）→ 0.99.0（09-29，codemode/MCP/virtual models/classifier/system theme/ChatGPT 登录）→ 0.99.1（09-29，GPT-6.1 Sol）→ 0.99.2（09-30，MCP codemode 描述瘦身 + MCP OAuth 增强 + Anthropic workload federation + `/reload` 支持 defaultTools 增量）。
- 0.99.1 与 0.99.2 对 pi-verdict 无直接影响（模型目录与 MCP 认证层）。

## 二、安全模型影响（高优先级）

### 2.1 codemode + MCP：间接调用面，拦截语义已核实成立

0.99.0 把 codemode、tool_search、MCP 做成内置扩展（`builtin:codemode` 等）。模型可以让 pi 在 QuickJS 沙箱里跑自己写的 JS，脚本通过 `tools.<name>()` / `ctx.executeTool()` 调用工具；MCP 服务器的工具默认以 `codemode` 暴露（不直接声明给模型，脚本经 `searchTools()` 加载）。

**核实结论（源码级）**：

- 嵌套调用走 agent 的 `runToolCall`，**带自己的 hooks**（`src/core/nested-tool-calls.ts` 的 `NestedToolCallRunner.execute` → `host.runToolCall`），`tool_call` 扩展事件照常发射：`src/core/agent-session.ts:623-647` `_beforeToolCall` → `runner.emitToolCall({ type: "tool_call", toolName: toolCall.name, toolCallId, input })`。
- 事件新增**可选**字段 `parentToolCallId`（`src/core/extensions/types.ts:1141-1151`）：codemode 发起的调用带此字段，id 形如 `<父id>/<n>`。pi-verdict 的 handler 只读 `toolName`/`input`，不受影响；这反而是**审计增强的机会字段**（标注裁决来自嵌套调用）。
- `toolName` 仍为裸名（`bash`/`read`/…）；`builtin:` 前缀只出现在错误、诊断、RPC source info 与 bug report 中（changelog 原文），**不影响** `toolKind()` 的分发——`toolKind` 全量命中的前提成立。
- 被拦的嵌套调用以 "Error carrying the tool's error text" 拒绝（codemode/tool.ts 头注释）——pi-verdict 的 `blockedReason()` 文本会进入沙箱脚本的异常，模型经由 "Script error:" 看到，与直接调用被拦的反馈路径等价。
- codemode **默认不启用**：需 `defaultTools` 加 `+codemode` 或 `--tools codemode`；但注意 **配置了 MCP 服务器会自动开启 codemode**（官方 models 文档：codemode "is off unless an MCP server turned it on"；源码：`src/extensions/mcp/config.ts:23-24,60`——mcp.json 顶层 `autoEnableCodemode` 默认 `true`，置 `false` 可关）。因此"默认升级 0.99.2 会话行为不变"仅在不添加 MCP 服务器的前提下成立——一旦 `pi mcp add`，codemode 与 `mcp__*` 工具面即进入会话。配置了 `"exposure": "direct"` 的 MCP 工具不经 codemode 直接声明给模型，同样落入 `tool_call` 门禁。
- 卸载面：`pi config` 的 Built-in section 可 `-builtin:codemode`（写入 `extensions` 设置）；`--no-extensions` 现在也禁内置扩展。

**残留关注点（建议进 README 威胁模型章节）**：

1. **裁决成本/延迟放大**：一个 codemode 脚本最多发起 256 个嵌套调用（`NESTED_CALL_LIMITS.maxCalls`，`nested-tool-calls.ts:26-31`）。每个灰区嵌套调用都要过一遍分类器（jev ~1.2s 尚可；LLM 分类器 p90 ≈ 20s 时，脚本里一串嵌套调用会被逐个串行放大）。自省继承会话模型的默认配置下体感最明显。
2. **MCP 工具恒走分类器**：`toolKind()` 对 `mcp__*` 返回 null（既有设计），codemode+MCP 组合使分类器压力常态化；用户唯一豁免面仍是 `ignoreTools`。
3. **MCP 工具名归一化陷阱**：实际工具名是 `mcp__${server}__${tool}` 且**非 `[A-Za-z0-9_]` 字符统一替换为 `_`**（`src/extensions/mcp/tools.ts:87`）。0.99.2 文档允许 namespace 写 `mcp__dev-radius`，但 `ignoreTools` 精确匹配的必须是 `mcp__dev_radius__x` 形态。README 值得写明。
4. codemode 脚本自身可经 `models.classify()` 调分类器（`CodemodeModelRuntime` 暴露 `classify`）——与 pi-verdict 的裁决无共享状态，不构成绕过，但威胁模型叙述中应提及"模型可在沙箱内自评"这一新形态。

### 2.2 同名注册与 provider 冲突：`typesafe` 直连分类器被遮蔽（dist 实证修正）

先说结论：**pi-verdict 与 jev-adapter 自身在 0.99.2 上不受任何影响；被影响的是"同一会话中想使用 pi 内置 `typesafe` 直连分类器的其他扩展/codemode 脚本"——该内置条目在 pi-verdict 加载期间不可达（遮蔽），openrouter / opencode 等 provider 下的 Jev 分类器不受影响。**

无冲突的部分：

- 0.99.0 新增"扩展注册同名 tool/command/flag 替换内置扩展"的警告（#10174）。pi-verdict 注册的 `/automode`、`--auto-mode*`、快捷键与内置无同名。
- jev-adapter 的 openrouter transport（`~typesafe/jev-latest` 走 OpenRouter decisions 端点）与内置 openrouter 目录的 `~typesafe/jev-latest` 分类器分属 chat/classifier 类型，互不干扰。

遮蔽的部分（三步证据链，均在 0.99.2 dist 中核实）：

1. **内置直连条目就是 `jev-latest`，与 adapter 注册的 chat 模型同 provider 同 id**。内置目录（`dist/bundle/chunks/chunk-3YAHQSW6.js`）：`"classifier:jev-latest":{type:"classifier",id:"jev-latest",api:"typesafe-system-one",provider:"typesafe",baseUrl:"https://api.typesafe.ai/v1/"}`。源码出处：生成脚本 `packages/ai/scripts/generate-models.ts:2674-2698` 的 `loadModelsDevClassifierModels()` 硬编码 `id: "jev-latest"`（从 models.dev 拉 metadata）。注意 `jev-1.13` 是 openrouter（`typesafe/jev-1.13`）与 opencode（`jev-1.13(-free)`）目录项的 id，不是直连条目——"slug 不同所以共存"不成立。
2. **native 注册走整条替换，不与 builtins 合并**。jev-adapter 调 `pi.registerProvider(provider)`（pi-ai `createProvider` 产物的 native 形）→ `registerNativeProvider`（`src/core/model-runtime.ts:882-894`）→ `nativeExtensionProviders.set("typesafe", provider)` → `recomposeProvider` → `composeProvider` 的 `base = nativeExtensionProviders.get(id) ?? builtins.get(id)`（`src/core/model-runtime.ts:300-301`）——native 在场时 builtins 永不参与；组合函数 `composeModelProvider` 的 `getAllModels()` 也只从 `getAllProviderModels(base)` 起步叠加 models.json/extension 层（`src/core/provider-composer.ts:523-541`），builtins 模型表全程不被引用；随后 `Models.setProvider`（`packages/ai/src/models.ts:399-402`）执行 `providers.set(id, provider)`，**整条替换该 provider 的模型表，无按类型合并**。最终 store 中 `typesafe` 只剩 adapter 的 chat 形 `jev-latest`（api `jev-decisions`）。
3. **运行时佐证**：干净 agent 目录的 0.99.2 headless 会话（第五节实测 3）中，adapter 注册后 `typesafe/jev-latest` 以 chat 模型身份服务会话并完成 decisions 调用——覆盖方向是 adapter 压内置，而非相反；注册过程无任何警告（0.99 的替换警告只覆盖 tool/command/flag，不覆盖 provider）。

后果与处置：

- `findOfType("classifier","typesafe","jev-latest")` 在 pi-verdict 加载期间返回 null——官方 `jev-router.ts` 示例的该调用会静默回退（示例自身写了 `if (!jev) return TERRA` 兜底）；codemode 脚本的 `models.getModelOfType("classifier","typesafe","jev-latest")` 同理。
- jev-adapter 源码注释 `the typesafe transport ... pi has no typesafe provider` 在 0.99 上**已失效**（pi 现有内置 typesafe provider）。
- 处置选项（对应行动项②）：a) 接受并在 README/security-principles 记录该遮蔽；b) 迁移到 `classify()` 时用 feature-detect 双轨（≥0.99 走原生，旧宿主留 adapter），迁移完成后 adapter 退役、遮蔽自然消解；c) 短期改名 provider id（破坏用户既有 `--auto-mode-model typesafe/jev-latest` 配置，不推荐）。

## 三、上游吸收：classifier 基建官方化（定位影响最大）

0.99.0 内置内容（changelog + 源码核实）：

| 能力 | 细节 | 与 pi-verdict 的关系 |
|---|---|---|
| 内置 jev classifier | `type: "classifier"`、api `typesafe-system-one`；`typesafe/jev-latest`（直连，`TYPESAFE_API_KEY`）、`opencode/jev-1.13(-free)`、`cloudflare-workers-ai/typesafe/jev`，OpenRouter/AI Gateway 目录含 inherited 条目（`~typesafe/jev-latest`、`typesafe/jev-1.13`） | 直连条目与 jev-adapter 的 chat 形 `typesafe/jev-latest` 同 provider 同 id——pi-verdict 加载期间被遮蔽（见 2.2）；其余 provider 下的条目共存 |
| `ModelRegistry.classify()` | `classify(model: ClassifierModel, context: {state, questions}, options) → ClassifierResult`；request-time auth；**Never rejects**（`src/core/model-registry.ts:168-174`） | `ClassifierContext` 与 jev-adapter 的 `buildDecisionsBody` **完全同构**；`ClassifierResult.answers.<q>` 直接带 `{choice, probabilities, confidence}`（`packages/ai/src/types.ts:653-689`） |
| llama.cpp 分类器 | 每个 llama.cpp chat model 附带 classifier，next-token label 概率作答 | 本地零成本分类器成为可选项 |
| virtual models | `registerVirtualModel()` 按请求路由物理模型；官方示例 `jev-router.ts` 用 jev 做路由 | 官方 jev 用途是 **model routing**，与 pi-verdict 的 permission gating 不同域，非替代 |

**判断**：

1. pi 吸收的是"jev/分类器**运输层**"（接入 + 认证 + 目录），不是 pi-verdict 的**判定管线**（deny floor、denyPaths、三态契约、fail-closed 纪律、审计、自保护层、级联门）。README 的差异化叙述应从"接入 jev"前移到"管线本身"。
2. **迁移机会（建议单开 issue 评估）**：`classifyWithModel` 的 jev 分支改走 `ctx.modelRegistry.classify()`：
   - 删掉 jev-adapter 的 transport/usage/流合成（~363 行里的大头）与 `PI_VERDICT_JEV_TRANSPORT` 双通道；
   - auth 免配置（OpenRouter 登录 / `TYPESAFE_API_KEY` / Cloudflare / OpenCode Zen 全部内置）；
   - `classifierMinConfidence` 直接消费原生 `confidence`，`parseJevConfidence` 的文本回读与 floor 取整 hack 可删；
   - fail-closed 语义天然对齐（classify Never rejects，error 走 `stopReason`/`errorMessage`）。
   - **代价**：omp 宿主（无 `registerProvider`，如今也未必有 `classify`）需要保留旧路径或降级说明——双路径维持期会先变复杂再变简单。
3. jev-adapter 现存的已知限制（denyPaths hint 不达 jev、state 被当数据）在 `classify()` 路径下同样存在（协议未变），迁移不解决这些问题。

## 四、API 兼容性核对表（0.99.2 源码逐项验证）

| pi-verdict 依赖 | 0.99.2 状态 | 证据 |
|---|---|---|
| `pi.on("tool_call")` 返回 `{block, reason}` | ✅ 保留；事件 union 新增可选 `parentToolCallId`；`input` 可变（既有机能） | `agent-session.ts:623-647`、`extensions/types.ts:1141-1213` |
| `pi.registerFlag / getFlag / registerCommand / registerShortcut` | ✅ 签名一致 | `extensions/types.ts:1628-1646` |
| `pi.registerProvider`（native 形） | ✅ 保留 | `extensions/loader.ts:216`、`model-registry.ts:196-205` |
| `ctx.modelRegistry.complete` | ✅ 保留 | `model-registry.ts:137-142` |
| `ctx.modelRegistry.find / hasConfiguredAuth / getProviderAuth` | ✅ 保留 | `model-registry.ts:65-72,109-112` |
| `ctx.sessionManager.getBranch / getSessionId` | ✅ 保留 | `session-manager.ts:249-255,1152,1469` |
| `ctx.ui.notify / confirm / select / setStatus` | ✅ 签名一致 | `extensions/types.ts:151-166` |
| `ctx.ui.theme.fg("success"/"warning")` | ✅ 语义色保留（system 主题为默认后仍从终端调色板派生这些键） | `theme.ts:62-64,361` |
| `ctx.cwd / model / hasUI / signal` | ✅ 保留 | `extensions/types.ts:331-352` |
| pi-ai `createProvider / createAssistantMessageEventStream / Context / SimpleStreamOptions` | ✅ 保留 | `models.ts:1034`、`utils/event-stream.ts:108` |
| `@earendil-works/pi-ai/compat` 子路径 | ✅ 保留 | `packages/ai/package.json:22` |
| 扩展加载（jiti） | ✅ 不变；0.99.0 的 Node type stripping 仅用于 pi 自身 | `extensions/loader.ts:2,49,569` |

区间外但同在升级路径上的 0.86.0 breaking（`Context` → 归一化 `TranscriptContext`、`ToolCall.arguments` JSON-only、`user_bash` fail-closed）：jev-adapter 的 `extractState` 只按 `role === "user"` 读 `messages`，与归一化语义兼容；pi-verdict 不用 `user_bash`。

## 五、随库实测（2026-10-01，RamDisk 沙箱）

沙箱：`/Volumes/RamDisk/pi-verdict-099`（本仓库除 node_modules 外的全量副本，devDependencies 置为 `@earendil-works/pi-coding-agent@0.99.2`）+ `/Volumes/RamDisk/pi-099-agent`（`PI_CODING_AGENT_DIR` 指向的干净 agent 目录，无全局扩展/设置干扰）。三组结果：

1. **typecheck**：`bun run typecheck`（tsc 7.0.2，strict）**零错误**——第四节核对表的静态结论得到编译级确认。
2. **测试**：`bun test` **252/252 通过**（0 fail，830 断言）。
3. **运行时 headless 冒烟**：`pi -p -e <repo>/extensions/pi-verdict.ts -e <repo>/extensions/jev-adapter.ts`，`PI_VERDICT_JEV_TRANSPORT=typesafe`——扩展正常加载、provider 注册无报错、会话选中 `typesafe/jev-latest` 并完成一次真实 decisions 分类调用（返回 `<verdict>allow</verdict> jev: allow 81%`）。注：沙箱内 env 存在 `TYPESAFE_API_KEY`，这是无登录状态下唯一可用凭据的 provider，故 headless 默认模型选择落在它上——adapter 端到端可用性由此得到验证；交互会话中 `model_select` 守卫（"decisions model 不能驱动会话"警告）不受影响。

未覆盖（后续行动项①）：codemode 开启会话中嵌套调用被拦时的 block 回传体感、`parentToolCallId` 在审计制中的可观测性、MCP 工具调用的分类器兜底实跑。复现：`cd /Volumes/RamDisk/pi-verdict-099 && bun run typecheck && bun test`（沙箱在 RamDisk 上，重启后需重建：rsync 仓库 → 改 devDeps → `bun install`）。

## 六、次要影响与机会

- **virtual models**：`ctx.model` 可能是 virtual model——`resolveClassifier` 自省回退把它喂给 `complete()` 的行为未经验证；jev-router 用户（session model 为 virtual）是真实场景。建议 README 已知限制加一句，或在 `resolveClassifier` 对 virtual model 做 find 回退。
- **`/reload` 语义扩展（0.99.2）**：新增 `defaultTools` 工具可热生效；pi-verdict 的配置仍"新会话生效"。文档对齐说明即可，无需改代码（`/reload` 重载扩展时 pi-verdict 本来就会走 install 路径重建）。
- **`defaultTools` 的 `+name/-name` 语法**：README 安装示例可顺带展示与 pi-verdict 的组合（如同时开 codemode 的最小配置）。
- **APIS_WITHOUT_TEMPERATURE**：OpenAI Codex provider 改名 legacy、默认模型换 `gpt-6.1-sol`、Sign in with ChatGPT 成为 OpenAI 主通道——api id 集合暂不需要动，但 OpenAI 新通道的 temperature 行为建议实测一次（#47 的自愈机制已覆盖）。
- **system 主题默认化**：footer 的 success/warning 双态观感建议冒烟看一眼（语义键名未变，纯视觉）。
- **llama.cpp 分类器**：README 可选分类器矩阵新增"本地 llama.cpp（零成本、离线）"一行。
- **TypeScript 7.0 / ES2024**：pi 自身构建链变化，扩展侧无感（jiti）。

## 七、建议行动（按优先级）

1. **devDeps 升级（已验证，可直接做）**：0.84.3 → 0.99.2，`bun run typecheck` + `bun test` 已在沙箱全过（第五节）；手动会话补充项：规则 deny / 分类器 allow/ask / toggle 快捷键 / footer 双态观感（system 主题默认后）。
2. **codemode 拦截验证**：`defaultTools: ["+codemode"]` 会话里让模型经脚本发 `bash rm -rf /tmp/x` 与 MCP 调用，确认 block 回传与 `parentToolCallId` 可观测；顺手验证嵌套调用的裁决延迟体感。可先手动，再固化为集成测试。
3. **jev-adapter → `classify()` 迁移评估**（单开 issue）：范围、omp 双路径策略、`classifierMinConfidence` 改原生 confidence、审计记录 `thinking: null` 语义保留；同时处置 2.2 节 `typesafe` 遮蔽（推荐 feature-detect 双轨，迁移完成后 adapter 退役）。
4. **README/文档**：新增"pi 0.99 codemode/MCP 与 pi-verdict"小节（拦截等价性、`-builtin:codemode` 缓解、256 嵌套上限的成本提示）；`ignoreTools` 的 MCP 工具名 `_` 归一化说明；可选分类器矩阵（+ llama.cpp、+ 内置 jev-1.13）；virtual model 已知限制。
5. **CI 版本矩阵**：0.99.x 加入测试面（0.84.3 与 0.99.2 双跑 typecheck/test），peer 范围 `>=0.84.0` 可维持不变。

## 附录：核实清单

- changelog 全文（pi.dev/changelog 第 1 页，覆盖 0.99.2 → 0.80.10；`?page=2` 起为更早版本，不在范围）。
- npm versions 与 GitHub releases 交叉确认跳号。
- 源码阅读（`earendil-works/pi@0f8740b`）：`core/nested-tool-calls.ts`、`core/agent-session.ts`（tool hooks）、`core/extensions/types.ts`（事件 union、UI、注册 API）、`core/model-registry.ts`、`core/model-runtime.ts`、`extensions/codemode/tool.ts`、`extensions/mcp/tools.ts`、`extensions/loader.ts`、`modes/interactive/theme/theme.ts`、`packages/ai/src/types.ts`（Classifier 契约）、`packages/ai/src/models.ts`、`packages/ai/scripts/generate-models.ts`（内置 jev 目录条目）。
- dist 包静态核对（npm 发布产物，与源码基线同版本）：`dist/core/model-runtime.js`（`registerNativeProvider`/`recomposeProvider`/`composeProvider`）、`dist/core/provider-composer.js`（`applyExtension` 对 config 形 `models` 的全量替换语义——适用于 config 形注册，native 形走 2.2 的整条替换路径）、`@earendil-works/pi-ai/dist/models.js`（`setProvider` 无合并）、`dist/core/nested-tool-calls.js`（`maxCalls: 256`）、`dist/core/extensions/loader.js`（jiti）、内置目录条目 `"classifier:jev-latest"`（chunk-3YAHQSW6）、`dist/core/extensions/types.d.ts`（`parentToolCallId`）、`dist/extensions/mcp/tools.js`（`mcp__${server}__${tool}` 归一化）。
- 随库实测（第五节）：typecheck / 252 测试 / headless 冒烟，沙箱 `/Volumes/RamDisk/pi-verdict-099`。
- 本仓库：`extensions/pi-verdict.ts`（0.12.1 全文）、`extensions/jev-adapter.ts` 全文、`package.json`。
