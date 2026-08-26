# pi 上游提报草稿(P1/P3)

> 目标仓库:`earendil-works/pi`(monorepo,包 `packages/coding-agent` @ 0.84.3)
> 用途:稍后人工编辑、修订后按官方模板提交。**提交前必读**下方「提交须知」。
> 事实来源:pi-verdict 仓库 `research/thinking-param-blackhole.md`(2026-08-26 取证)

## 提交须知(来自 CONTRIBUTING.md,硬约束)

- [ ] 必须用官方 issue 模板(bug.yml):What happened / Steps to reproduce / Expected behavior / version
- [ ] 一屏以内;**用自己的口吻改写**(明令禁止 LLM 生成文本冒充人写;若保留 AI 辅助,须跟一条明确标注 AI 的评论)
- [ ] 新贡献者 issue 会被**自动关闭**;维护者每日审阅 auto-closed 队列,达标才 reopen;`lgtmi`/`lgtm` 可解锁后续
- [ ] 周五至周日不保证审阅(2026-08-26 为周三,工作日队列)
- [ ] 重复检索结论:#8156(openai-codex 通道的镜像问题,auto-closed/no-action)是同族最近判例,草稿 1 已引用
- [ ] 勿在获得维护者 `lgtm` 前提 PR

---

## 草稿 1(主报,P1:per-call "off" 语义)

**Title:**

```
anthropic-messages lane: per-call reasoning: "off" is truthy → adaptive effort "high" instead of disabled; thinkingLevelMap.off never consulted for the string form
```

**What happened?**

`SimpleStreamOptions.reasoning` is typed `ThinkingLevel`, which includes `"off"`. On the anthropic-messages lane, passing the string `"off"` to `streamSimple`/`completeSimple` does not disable thinking — it takes the adaptive branch at effort **high** (code-derived from 0.84.3 dist, see repro):

- `streamSimple` gates on `if (!options?.reasoning)` — the string `"off"` is truthy, so any `forceAdaptiveThinking` model takes the adaptive branch
- `mapThinkingLevelToEffort`'s switch has no `"off"` case → `default: return "high"`
- Omitting `reasoning` (undefined) correctly yields `thinkingEnabled: false` → `thinking: {"type":"disabled"}` (when `thinkingLevelMap?.off !== null`) — this half we confirmed on the wire via proxy logs

So `"off"` and `undefined` — nominally the same level — diverge, and `thinkingLevelMap.off` (the per-model "cannot disable" gate) is never consulted for the string form.

This is not custom-provider-only: built-in adaptive Claude models (opus-4-6→5, sonnet-4-6/5 ship `compat.forceAdaptiveThinking` with maps like `{xhigh,max}` — no `off:null`) hit the same path, and for them disabling is supported. For models that genuinely cannot disable (e.g. `claude-fable-5` with `off:null`), `"off"`→high is defensible clamping — the gate just never gets a say.

**Steps to reproduce**

On 0.84.3, call the simple API on any anthropic-messages model with `compat.forceAdaptiveThinking` (built-in adaptive Claude, or a custom anthropic-compatible provider) with `reasoning: "off"` and inspect the request body: `thinking: {"type":"adaptive"}` + `output_config: {"effort":"high"}`. Same call with `reasoning` omitted: `thinking: {"type":"disabled"}`. (Code path: `dist/api/anthropic-messages.js` — `streamSimple` + `mapThinkingLevelToEffort`. We verified the omission→disabled half on the wire; the off→high half is from reading the shipped dist.)

Context from our debugging (separate issue, extension-side): a permission-classifier making small `max_tokens: 512` calls on a thinking model got empty answers (`stopReason: length`) whenever the request carried no thinking parameter — the provider defaulted to max effort.

**Expected behavior**

Either `"off"` normalizes to the omission path (consistent with the agent session, which passes `reasoning: undefined` for `thinkingLevel === "off"`, and with the azure openai-responses adapter), or `"off"` is excluded from `SimpleStreamOptions.reasoning`'s type and documented as session-level only. If deliberate (like `resolveGoogleThinkingLevel`'s `off → "high"`), the divergence across lanes deserves a doc note — related: #8156 reports the mirror-image gap on the openai-codex lane.

Ecosystem signal: `@zhushanwen/pi-llm-shared`'s `callLLM` wrapper (used by the published `pi-permission` extension) already normalizes `off` → omit before calling `completeSimple`, apparently for this exact reason — the quirk is being worked around independently in the wild.

Happy to PR whichever direction maintainers prefer.

**Version:** 0.84.3

---

## 草稿 2(次报,P3:扩展层 API 缺口;建议获 lgtmi 后再提)

**Title:**

```
Extension ModelRegistry.complete() silently drops SimpleStreamOptions fields (reasoning) — consider exposing completeSimple
```

**What happened?**

`ctx.modelRegistry.complete()` is typed `ModelsApiStreamOptions<TApi>` (per-API options; `AnthropicOptions` has no `reasoning` — that field belongs to `SimpleStreamOptions`, mapped by `streamSimple`). Extensions holding a generic `Model<Api>` get the fallback type `StreamOptions & Record<string, unknown>`, whose index signature swallows unknown-property checks — so `reasoning: "minimal"` typechecks and is silently dropped at runtime. The extension-facing `ModelRegistry` doesn't expose `completeSimple`, so there is no supported way for an extension to request a per-call thinking level.

**Expected behavior**

Expose `completeSimple` on the extension-facing registry, or document the API-layer/simple-layer distinction. This cost us a day of debugging (writeup available on request); happy to share details.

**Version:** 0.84.3

---

## 附:跨适配器 "off" 行为对照(自留参考,勿贴入 issue)

| 通道 | 字符串 "off" 的命运 | map.off 门槛 |
|---|---|---|
| anthropic-messages(simple 层,任一 forceAdaptiveThinking 模型) | adaptive @ **high**(switch default,代码推导) | **被绕过** |
| ├ 内置 opus-4-6→5/sonnet-4-6/5(map 无 off:null,可禁用) | 同上——真 bug:应发 disabled | 省略路径生效,字符串路径绕过 |
| ├ 内置 fable-5(off:null,不可禁用) | off→high 属合理 clamp;UI 亦不提供 off | 两路径均不发 disabled(正确) |
| └ 自定义 provider(内部网关后的 GLM,map 无 off 键) | 同上;GLM 侧 disabled→effort low(BigModel 表) | 省略→disabled 线上实证送达 |
| anthropic-messages(省略 reasoning) | `thinking:{type:"disabled"}` | 生效(off !== null 才发;GLM 线上实证) |
| google-generative-ai | `"high"`(**刻意**,resolveGoogleThinkingLevel) | 不适用 |
| azure openai-responses / openai-codex | 规范化为 undefined / 折叠后不发 reasoning 字段 | codex 通道不可达(#8156) |
| 生态 workaround:@zhushanwen/pi-llm-shared callLLM | 内部 off→omit 后再调 completeSimple(已作为生态佐证写入 issue 草稿) | 规避 |
| agent session(主循环) | off → undefined 传入 | 间接生效 |
