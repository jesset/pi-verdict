# pi-observational-memory 扩展调研

调研日期：2026-08-27
调研对象：[`elpapi42/pi-observational-memory`](https://github.com/elpapi42/pi-observational-memory)（MIT，本机已安装 v3.0.4）
信息来源：本机安装包源码与 README（`~/.pi/agent/npm/node_modules/pi-observational-memory/`），属一手来源。GitHub 上同名仓库多为 fork，上游为 elpapi42。

---

## TL;DR 结论

**它是一个"会话长期记忆 + 快速压缩"扩展**：在会话进行中用三个后台 LLM 代理持续提炼「观察（Observation）」与「反思（Reflection）」，存入会话账本；到压缩（compaction）时机时，直接渲染已备好的记忆作为摘要，**压缩阶段零模型调用**，从而同时解决"摘要套摘要导致语义漂移"和"压缩卡顿"两个问题。口号是 *"Make Pi sessions feel endless"*。

设计灵感来自 [Mastra 的 Observational Memory 研究](https://mastra.ai/blog/observational-memory)，是对 Pi 扩展系统的独立实现。

---

## 1. 解决什么问题

| 问题 | 机制层面的成因 | 本扩展的对策 |
|---|---|---|
| **语义漂移**：长会话多次压缩后，决策理由、已否决方案、约束条件等细节丢失 | 压缩 = 对旧摘要再摘要，信息逐级衰减 | 把记忆工作提前到会话进行中，以带溯源 ID 的观察/反思条目替代摘要链 |
| **压缩卡顿**：大会话压缩时阻塞数分钟 | 压缩时刻才让模型"重写全部历史" | 记忆已备好，`session_before_compact` 钩子只做纯渲染 |

## 2. 核心概念（V3 记忆模型）

- **观察（Observation）**：带时间戳、相关度分级（`low/medium/high/critical`）的具体事件，如"用户决定把公共 API 从 REST 切到 GraphQL"。每条携带 `sourceEntryIds`（指向原始会话条目的最小支撑集），是可溯源的证据。
- **反思（Reflection）**：从观察中蒸馏出的持久事实，如"用户在用 Next.js 15 + Supabase auth 构建 Acme Dashboard"。携带 `supportingObservationIds`，是稀缺的"定向锚点"而非第二层观察。
- **会话账本（Session Ledger）**：以自定义条目（`om.observations.recorded` / `om.reflections.recorded` / `om.observations.dropped` / `om.folded`）追加写入 Pi 会话文件本身，随分支（branch）走，不另建数据库。
- **recall 工具**：面向 agent 的工具，用 12 位十六进制 ID 精确恢复某条观察/反思的原始证据。明确"不是语义搜索，不是转录浏览器"。

## 3. 架构（已对照源码验证）

```
turn_end ──观察钟到点──> Observer 代理（读对话块 → record_observations）
turn_end ──反思钟到点──> Reflector 代理（蒸馏持久事实 → record_reflections）
反思成功后 ──────────> Dropper 代理（按覆盖证据修剪活跃观察池 → drop_observations）
agent_end ──源条目 token 超阈值且空闲──> 主动触发压缩
session_before_compact ──> 纯渲染记忆（buildCompactionProjection + renderSummary，零模型调用）
```

三个后台代理的系统提示词要点（源码 `src/agents/*/prompts.ts`）：

- **Observer**："这些记录是压缩后助手对过去的唯一记忆"，只对新块产出增量观察，禁止编造 source entry id，无新信息时允许零产出。
- **Reflector**：设"未来代理效用测试"与"抽象门槛"——只有未来运行必须知道的事实（偏好、约束、决策、已完成结论、不变量）才升格为反思；过度反思本身被视为记忆失真。
- **Dropper**：默认保留（KEEP），按"冗余 → 被取代 → 低信号 → 陈旧"优先级提议丢弃；丢弃只移出活跃记忆，不删账本历史。反射覆盖分级（`none/partial/strong`）作为证据而非硬规则。

**压缩摘要的确凿形态**（README 示例）：反思区 + 按时间排序的观察区，各条目带 `[id]`，并附使用说明（冲突时以最新观察为准、已完成工作不重做、需要精确溯源时用 recall）。

## 4. 关键配置（默认值）

| 设置 | 默认 | 含义 |
|---|---|---|
| `observeAfterTokens` | `10000` | 触发一次观察运行的源 token 阈值 |
| `reflectAfterTokens` | `20000` | 触发一次反思运行的源 token 阈值 |
| `compactAfterTokens` | `81000` | 主动压缩的源条目 token 阈值（最新压缩边界之后累计） |
| `compactAfterTokensMode` | `"calibrated"` | `"ratio"` 模式按模型 `contextWindow × compactAfterTokensRatio`（默认 0.68）缩放阈值，适配 1M 等大窗口模型 |
| `observationsPoolMaxTokens` / `...TargetTokens` | `20000` / 半额 | 压缩全量折叠压力 / Dropper 维护的活跃观察池目标 |
| `agentMaxTurns` | `16` | 后台记忆代理共享回合上限 |
| `model` | 会话模型 | 可为记忆工作者单独指定更便宜的模型（含 `thinking` 等级） |
| `passive` | `false` | 关闭全部主动后台工作与自动压缩 |

用户命令：`/om:status`（记忆计数、进度时钟、池压力）、`/om:view` / `/om:view full`（渲染当前可见/完整记忆并复制到剪贴板）。

## 5. 版本注意

**V3 与 V2 完全不兼容**：不读旧设置、不迁移旧记忆，升级后应新开干净会话。V2 的 `observationThresholdTokens` 等键在 V3 下会被静默忽略、回退默认值（设置迁移表见 README）。

## 6. 本机环境现状

- 已通过 `packages` 启用：`npm:pi-observational-memory`（`~/.pi/agent/settings.json`）。
- **未配置任何 `observational-memory` 设置** → 全部走默认值；记忆工作者使用当前会话模型（未指定更便宜的 worker 模型）。
- 本会话工具列表中的 `recall` 工具即由该扩展注册（`src/tools/recall-observation.ts`）。

## 7. 评价

- **定位聪明**：不在压缩时刻做重活，而是用"记账前置 + 压缩时渲染"换连贯性与速度；溯源 ID + recall 让压缩记忆保持可验证，而非黑箱摘要。
- **提示词工程扎实**：三个代理各有明确的产出纪律（增量、抽象门槛、默认保留），对"过度记忆"与"记忆失真"有显式约束。
- **成本代价**：观察/反思是额外的后台模型调用；官方建议为 worker 配置便宜模型（如 OpenRouter 上的 gemini）以控制开销。
- **注意点**：主动压缩阈值默认按 ~128K–200K 上下文模型校准（81K），在大窗口模型上建议切 `"ratio"` 模式；`passive: true` 可随时退化为纯被动模式观察行为。
