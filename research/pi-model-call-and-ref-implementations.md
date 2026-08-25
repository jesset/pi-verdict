# 调研:Pi 扩展的模型调用 API、配置读取方式与三个权限扩展的实现提取

> 对应 issue: #2(Part of #1)
> 调研日期: 2026-08(以本机安装版本为准: `@earendil-works/pi-coding-agent` + `@earendil-works/pi-ai@0.84.3`)
> 全部结论均核实自一手来源:本机安装的 Pi 官方文档与 dist 类型/实现、三个扩展的 npm 包源码(`npm pack` 解包)与 GitHub 仓库 clone(位于 `/Volumes/RamDisk/pi-research/`)。

## TL;DR

1. **模型调用**:官方 helper 已存在 —— `ctx.modelRegistry.complete(model, context, options)`(内部自动解析凭证),`options.signal` 直接传 `ctx.signal` 即可。"自省"(继承会话模型+凭据)= 传 `ctx.model` 作为 model;`ctx.modelRegistry.getApiKeyAndHeaders(ctx.model)` 可显式取凭证。不需要自己 fetch provider API。
2. **配置读取**:`settings.json` **没有**面向扩展的自定义键读取 API(`ExtensionContext` 上不存在 settings 访问器)。官方方式:扩展自带配置文件(全局 `getAgentDir()` 下、项目 `.pi/` 下用 `CONFIG_DIR_NAME` 拼路径 + `ctx.isProjectTrusted()` 门控)、`pi.registerFlag()/pi.getFlag()` CLI 标志、以及环境变量(`process.env`)。三个参考扩展全部走"自带 JSON 配置文件"路线。
3. **参考实现**:三个扩展的提示词、规则集、缓存/熔断、裁决契约均已逐文件提取(见第三节),文末给出可直接采用的「规则层种子集」。

---

## 一、模型调用机制(子问题 1)

### 1.1 官方 helper:`ctx.modelRegistry.complete()` —— 不需要自己 fetch

`ExtensionContext.modelRegistry` 是 `ModelRegistry` 类的实例,类型声明(本机 `node_modules/@earendil-works/pi-coding-agent/dist/core/model-registry.d.ts:33`):

```typescript
complete<TApi extends Api>(model: Model<TApi>, context: Context, options?: ModelsApiStreamOptions<TApi>): Promise<AssistantMessage>;
```

同文件还声明了凭证解析方法:

- `getApiKeyAndHeaders(model)` → `Promise<ResolvedRequestAuth>`(`{ ok: true; apiKey?; headers?; baseUrl?; env? } | { ok: false; error }`)(`model-registry.d.ts:11-16, 29`)
- `getProviderAuth(provider)` → `Promise<AuthResult | undefined>`("resolves its current API key, headers, base URL, and provider-scoped environment without requiring a loaded model")(`model-registry.d.ts:35`;文档 `docs/extensions.md:995-997`)
- `find(provider, modelId)`、`hasConfiguredAuth(model)`、`getProvider(provider)`(`model-registry.d.ts:27-34`)

**凭证是内部自动解析的,扩展不需要碰 API key。** 实现链:`ModelRegistry.complete()` → `ModelRuntime.complete()` → `stream()` → `prepareRequest()`(`dist/core/model-runtime.js:422-451`),后者调用 `this.getAuth(model, ...)` 解析出 `apiKey/headers/baseUrl/env` 并注入 provider 请求。凭证查找顺序(auth.json → 环境变量 → models.json 自定义 provider)见 `docs/sdk.md:445-448`。

`options`(经 `ModelsApiStreamOptions` → `StreamOptions` → `ProviderRequestOptions`)支持:

- `signal?: AbortSignal`(`@earendil-works/pi-ai/dist/types.d.ts:53`)—— 直接传 `ctx.signal`,Esc 即可取消嵌套模型调用(文档 `docs/extensions.md:1001-1011` 明确列出 "model calls that accept `signal`")
- `cacheRetention?: "none" | "short" | "long"`、`sessionId?: string`(`pi-ai/dist/types.d.ts:128-137`)—— 前缀缓存与 session 亲和
- `reasoningEffort`、`maxTokens`、`temperature`、`timeoutMs` 等

**官方示例**:`examples/extensions/summarize.ts:163-187` 完整演示了扩展内独立模型调用:

```typescript
const model = ctx.modelRegistry.find("openai", "gpt-5.2");
if (!ctx.modelRegistry.hasConfiguredAuth(model)) { /* 降级 */ }
const response = await ctx.modelRegistry.complete(
  model,
  { messages: summaryMessages },
  { reasoningEffort: "high", cacheRetention: "none", sessionId: uuidv7() },
);
// response.content 里取 type === "text" 的块
```

### 1.2 "自省"(继承当前会话 provider/model + 凭据)的实现

`ctx.model` 就是当前会话的活动模型(`docs/extensions.md:995-997`;"`ctx.model` is the active model")。因此自省调用的最简形态:

```typescript
pi.on("tool_call", async (event, ctx) => {
  if (!ctx.model) return { block: true, reason: "no active model" };
  const response = await ctx.modelRegistry.complete(
    ctx.model,                                   // 继承会话当前 provider/model
    { messages: [/* 裁决提示 */] },
    { signal: ctx.signal, cacheRetention: "short",
      sessionId: ctx.sessionManager.getSessionId(),
      temperature: 0, maxTokens: 80 },
  );
  // 凭据由 ModelRuntime.prepareRequest 内部解析,无需读取 API key
});
```

如需显式拿凭证(例如绕过 registry 直接调 provider),用 `await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model)` —— 判别联合,必须先 `if (!auth.ok)` narrow 后取 `apiKey/headers/env`(pi-llm-shared `src/call.ts:95-99` 即此用法)。

### 1.3 备选路径(三个参考扩展实际使用的)

| 路径 | 使用者 | 备注 |
|---|---|---|
| `ctx.modelRegistry.complete()` | 官方示例 summarize.ts | **推荐**。凭证内部解析,API 稳定(类方法,非 deprecated) |
| `ctx.modelRegistry.getProvider(id).streamSimple(model, ctx, opts).result()` | pi-permission-ai-guard `src/model-review.ts:78-88`(`createCompleteSimple`) | 非 deprecated;调用方需自行 `getApiKeyAndHeaders` 注入 `apiKey/headers` |
| `completeSimple` from `@earendil-works/pi-ai/compat` | @zhushanwen/pi-llm-shared `src/call.ts:17` | compat 是"临时兼容入口"(`pi-ai/dist/compat.d.ts:1-10` 头注:"This module is deleted with the coding-agent ModelManager migration"),`completeSimple`/`streamSimple` 声明在 `compat.d.ts:65-66` |
| `completeSimple` from `@earendil-works/pi-ai`(包根) | wangzexi/pi-auto-approve `auto-approve.ts:18` | **兼容性风险**:pi-ai@0.84.3 包根已不导出 `completeSimple`(实测 `import()` 后 `typeof === "undefined"`);该扩展写于旧版 pi-ai。新代码勿用 |

关于嵌套调用的计费/记账:若从**自定义工具**内发起嵌套 LLM 调用,可把 `usage` 放进工具结果上报(`docs/extensions.md:1995`);`tool_call` 钩子场景无此通道,仅作提示。

关于并行工具调用:`tool_call` 触发时 `ctx.sessionManager` 已同步到当前 assistant 消息,但不保证包含同批兄弟工具结果(`docs/extensions.md:764-766`)。`tool_call` 处理器抛错会 fail-safe 地 block 该工具(`docs/extensions.md:2904`)。

---

## 二、配置读取(子问题 2)

### 2.1 settings.json 没有扩展自定义键 API

`ExtensionContext` 的完整字段清单(`dist/core/extensions/types.d.ts:209-249`):`ui / mode / hasUI / cwd / sessionManager / modelRegistry / model / scopedModels / thinkingLevel / isIdle() / isProjectTrusted() / signal / abort() / hasPendingMessages() / shutdown() / getContextUsage() / compact() / getSystemPrompt()` —— **没有任何 settings 访问器**。`docs/settings.md` 的 "All Settings" 全表亦无扩展自定义键机制。结论:settings.json 只对 Pi 内置键生效,扩展不应往里面塞自定义配置。

### 2.2 官方认可的四种方式

1. **扩展自带 JSON 配置文件(项目级)** —— 文档唯一明确示范的方式(`docs/extensions.md:958-973`):

   ```typescript
   import { CONFIG_DIR_NAME, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
   const projectConfigPath = join(ctx.cwd, CONFIG_DIR_NAME, "my-extension.json");
   ```

   读取项目级配置前应用 `ctx.isProjectTrusted()` 门控(`docs/extensions.md:976-980`:"Use this before reading project-local extension configuration that should only be honored for trusted projects")。

2. **扩展自带配置文件(全局级)** —— `getAgentDir()` 是官方导出(`dist/index.d.ts:2` re-export;`dist/config.d.ts:77`),返回 Pi agent 目录(默认 `~/.pi/agent`,尊重 `PI_CODING_AGENT_DIR` 环境变量)。扩展在此目录下自建子路径存配置。

3. **CLI 标志** —— `pi.registerFlag(name, { description, type, default })` + `pi.getFlag(name)`(`docs/extensions.md:1633-1648`),适合开关类配置(如 plan-mode 的 `--plan`)。

4. **环境变量** —— 扩展是进程内 Node 代码,可直接 `process.env`(官方示例:`examples/extensions/interactive-shell.ts:102,105` 用 `INTERACTIVE_COMMANDS` / `INTERACTIVE_EXCLUDE`)。

### 2.3 参考扩展的实际做法(均验证过)

| 扩展 | 配置位置 | 机制 |
|---|---|---|
| @zhushanwen/pi-permission | `<agentDir>/config/permission-ext-config.json` | `getAgentDir()` 推导;首次运行自动创建默认配置;字段:`mode(yolo/auto/approve/strict)`、`enabled`、`classifier.{enabled,model,timeout,autoApproveLowRisk,autoDenyHighRisk,thinkingLevel}`、`userRules[]`(`src/config.ts:6-14, 44-46`;README) |
| pi-permission-ai-guard | 全局 `<agentDir>/extensions/pi-permission-ai-guard/config.json` + 项目 `<cwd>/.pi/extensions/pi-permission-ai-guard/config.json` | 双层读取、深度合并(项目覆盖全局)、zod 校验;`trustedProject: false` 时跳过项目层(`src/config-loader.ts:50-58, 111-145`);配置非法 → 不注册裁决链路(fail-safe 降级为无自动审查,绝不错判) |
| wangzexi/pi-auto-approve | 无配置文件 | 仅 `/autoapprove` 命令切换内存开关 + `PI_AUTO_APPROVE_DEBUG_REVIEW` 环境变量(`auto-approve.ts:69-71, 224-230`) |

---

## 三、参考实现提取(子问题 3)

调研副本:`/Volumes/RamDisk/pi-research/{pi-permission, pi-llm-shared, pi-permission-ai-guard, pi-auto-approve, pi-packages}`。

### 3.1 `@zhushanwen/pi-permission@1.3.3` —— 三层管道(AST + 规则 + AI 分类器)

**架构**:`checkPermission()` 纯函数主入口(`src/pipeline.ts:411`),四档模式:

- `yolo`:完全放行;`strict`:全部人工审批;
- `approve`:层 1 AST → 层 2 规则(allow 放行 / deny 拒绝 / ask → 人工,无 AI);
- `auto`:层 1 AST → 层 2 规则 → ask 时进层 3「AI 分类器与用户审批**竞速**」(`runLayer3WithRacing`,`pipeline.ts:229`)。

**fail-closed 总原则**:任何异常路径 → ask(auto)或人工,绝不静默放行;headless(json/print)模式下 AI 返回 ask → fail-closed deny(`pipeline.ts:267-281`)。

**层 1 — AST 结构分析**(`src/ast/analyzer.ts`):用 web-tree-sitter 忠实移植 Codex `bash.rs` 的 `try_parse_word_only_commands_sequence`。白名单 11 种 named node(program/list/pipeline/command/command_name/word/string/string_content/raw_string/number/concatenation)+ 6 种标点 token(`&&` `||` `;` `|` `"` `'`);出现任何其他结构(command_substitution/file_redirect/subshell/反引号/重定向等)→ `clean: false` 直接送下游。输入超 65536 字符或解析失败 → fail-closed(`analyzer.ts:31-57`)。产出 `commands: string[][]`(把复合命令拆成逐条 argv)。

**层 2 — 规则匹配**(`src/rules/`):

- **白名单 = 函数判定,不是正则**:`isKnownSafeCommand(argv)`(`builtins.ts:535`)= 50 条无条件安全命令(`BUILTIN_UNCONDITIONAL_SAFE`,`builtins.ts:37-89`:cat/ls/grep/find(注:find 实际在条件组)/head/tail/wc/jq 等)+ 9 条带 argv 级 flag 子检查的条件命令(`builtins.ts:91-101`:base64 禁 `-o/--output` 及合并短 flag 簇含 `o`;find 禁 `-exec/-delete/-fprint*`;rg 禁 `--pre/--hostname-bin/-z`;git 仅 `status/log/diff/show/branch` 只读子命令 + 禁 `-C/-c/--exec-path` 等全局选项;sed 仅 `sed -n {N|M,N}p`;sort/iconv/shuf 禁 `-o`;date 禁 `-s`)。移植自 codex-rs `is_safe_command.rs`。
- **危险规则 = 12 条正则**(`BUILTIN_DANGER_RULES`,`builtins.ts:552-666`):bd-001 `rm` 含递归 flag;bd-002 `sudo`;bd-003 `chmod 777/a+rwx/ugo+rwx`;bd-004 裸设备写(`> /dev/sd*` / `dd of=/dev/*`);bd-005 `git push --force`;bd-006 `git reset --hard`;bd-007 `git clean -f`;bd-008 `git checkout .`;bd-009 `git restore`;bd-010 `curl|wget ... | sh/bash`;bd-011 `gh repo create/delete/rename/archive`;bd-012 `gh release create/delete/edit`。全部 `action: "deny"`,`new RegExp(pattern, "i")` 编译。
- **聚合语义**(`runLayer2`,`pipeline.ts:130-166`):逐 argv 匹配,任一 deny → 整体 deny;全 allow → allow;否则 ask。**C1 补充**:对完整命令串再跑一次 deny 检查,覆盖 AST 按管道拆开后单 argv 看不到的 `curl x | sh`(bd-010)。非 bash 工具:`tool` 字段对 toolName、`pattern` 字段对 path 做 wildcard 匹配(`matchNonBashTool`,`pipeline.ts:85-107`)。
- 用户自定义规则:OpenCode wildcard 语法,last-match-wins。

**层 3 — AI 分类器**(`src/classifier/`):

- **分类提示词**(`prompt.ts:23-38`,全文):

  ```
  You are a security risk classifier for tool invocations in an AI coding agent.
  Evaluate the given tool invocation for destructive or unsafe operations.

  Reply with ONLY a JSON object (no markdown, no prose before/after):
  {"outcome": "allow" | "deny" | "ask", "risk_level": "low" | "medium" | "high", "reasoning": "one short sentence", "confidence": 0.0-1.0}

  Rules:
  - allow: safe operations (read-only commands, writing to project directory, git status/diff/log, ls, cat, echo, grep, find)
  - deny: clearly destructive AND irreversible (rm -rf /, mkfs, force push to main, drop database, format disk)
  - ask: potentially dangerous or system-wide changes (rm with recursion, sudo, writing to system dirs like /etc, network operations, deleting multiple files)
  - For file writes: allow if writing to user's project/cwd directory; ask if writing to system dirs or sensitive paths (~/.ssh, /etc)
  - confidence = your certainty in the outcome (0.0 = guessing, 1.0 = certain)
  ```

  注释说明刻意保持 ~80 token 以压低首调延迟。user prompt 为 `tool/command/path/cwd(/agent)` 四五行键值(`prompt.ts:41-52`)。
- **风险分级契约**:`ClassifierResult { outcome: allow|deny|ask, risk_level: low|medium|high, reasoning: string, confidence: 0-1 }`。**偏差补丁**(`applyAutoApproveOverrides`,`pipeline.ts:181-201`):`high + allow + autoDenyHighRisk=true` → 强制 deny;`low + allow + autoApproveLowRisk=false` → 强制 ask。即 AI 的 allow 在高风险时不可信。
- **模型解析**:`classifier.model: "auto"` = 取会话 scopedModels 中首个有凭证的可用模型,否则 `provider/model-id` 精确指定;走 `ctx.modelRegistry`(`find` + `hasConfiguredAuth`),不自读 models.json(`src/classifier/model-resolver.ts:12-26, 60-97`;README)。
- **LLM 调用**:经 @zhushanwen/pi-llm-shared `callLLM`(`pi-llm-shared/src/call.ts:88-132`):`completeSimple`(compat 子路径)+ `getApiKeyAndHeaders` 注入凭证;`stopReason: error/aborted` 归一为 `{ok:false, stopReason}`;外层再叠加超时+signal 竞速兜底防永挂(`classifier.ts:92-130`)。所有失败 → fail-closed `{outcome:"ask", risk_level:"medium", confidence:0}`。
- **解析容错**:三层 —— 贪婪正则提取 JSON → `JSON.parse` → 字段枚举校验(confidence clamp [0,1]);任一失败 → fallback ask(`src/classifier/json-parser.ts:1-26`)。
- **竞速语义**(`pipeline.ts:229-403`):AI 与用户审批同时启动;用户先答 → abort AI;AI 先答 allow/deny → 关闭对话框按 AI 结果;AI 答 ask → 转人工(5 分钟超时兜底,fail-closed deny)。

### 3.2 `pi-permission-ai-guard@0.7.0`(kuoruan)—— 上下文精简防注入、裁决缓存、熔断器

**定位**:`@gotgenes/pi-permission-system` 的 Authorizer 链上的一个非终结链环(`src/review-pipeline.ts`;链环契约 `AuthorizerVerdict = allow | deny(reason?) | defer`,见 pi-packages `pi-permission-system/src/authority/authorizer.ts:20-41`)。只在确定性规则引擎判定为 "ask" 时才工作;引擎已 allow/deny → 直接 defer(`review-pipeline.ts:92-103`)。所有失败 → defer(交下一链环/人工),而非 deny。

**上下文精简(防注入核心)**(`src/transcript-stripper.ts:171-249`,`stripTranscript`):按信任等级处理会话条目 ——

- **保留(可信)**:`user` 消息;`ask_user_question` 工具结果(用户的结构化答案);
- **删除(不可信)**:assistant 文本(仅提取 tool call 名+参数)、普通 toolResult(注入入口且 token 最重)、compaction/branch_summary(派生上下文,不是用户授权信号)、custom 消息;
- **限额**:最近 5 条用户消息、10 条 tool call、每条 1000 字符(头 60% + 尾 40% 截断)(默认值,`src/config-schema.ts:15-19`);
- **清洗**(`src/utils.ts`):`normalizeText` 去零宽字符(U+200B-200D/2060/FEFF)+ 折叠所有空白为单空格(防止换行伪造提示词分节标题,`utils.ts:116-118`);`redactSecrets` 打码 ~20 类密钥模式(AWS/Anthropic/OpenAI/GitHub/GitLab/Slack/Google/Stripe/PEM 私钥块/Bearer 等,`utils.ts:20-69`)+ `password|token|api_key|...` 键值对(`utils.ts:76-77`);动作文本用 `encodeActionTextForPrompt` = JSON.stringify 转义后内联(`utils.ts:150-152`),保留 shell 空白又不让它生成新的提示词分节。

**裁决提示词**(`src/prompt.ts`):

- system = `SAFETY_RULES`(prompt.ts:34-176)+ 固定 `VERDICT_SECTION`(prompt.ts:179-193,自定义 instructions 只能替换规则部分,输出契约不可覆盖)。
- SAFETY_RULES 按**意图依赖度**分三档:`DENY — Always`(无视意图:密钥/凭证读取、不可逆销毁、敏感数据外发、系统篡改与安全弱化、持久化系统变更、外部代码执行 `curl|bash`/远程包安装、外部监听暴露、破坏性 VCS、资源滥用)、`DENY — Unless`(有明确匹配意图才放行:CWD 外写、环境变更、删除、网络/浏览器交互、外部发布、MCP/skill 副作用)、`ALLOW`(匹配当前任务:CWD 内只读、有限的项目内写入、项目工具链、非破坏本地 VCS)。复合命令逐段评估取最严档;编码/混淆 payload 解不出效果 → defer。
- **裁决 JSON 契约**(VERDICT_SECTION):

  ```json
  {"verdict":"allow"}
  {"verdict":"deny","reason":"<risk; safer alternative if useful>","riskLevel":"low|medium|high|critical"}
  {"verdict":"defer","reason":"<what needs clarification>"}
  ```

  解析失败/字段非法 → defer(`src/verdict.ts:100-126`)。

**裁决缓存**(`src/session-state.ts:114-164`,`VerdictCache`):LRU(默认 128 条),键 = `commandHash`(请求快照:动作上下文 + cwd + 策略路径边界),值携带 `contextHash`(可信意图串联的哈希)。**双哈希都命中才算 hit** —— 同一命令在对话推进后 contextHash 变化会 miss 并重新评审,保证裁决不会跨上下文误用;miss 原因(disabled/no-entry/context-changed)记遥测。defer 不入缓存(`review-pipeline.ts:137-152, 168-174`)。

**熔断器**(`src/session-state.ts:49-99`,`CircuitBreaker`):只对**真实模型裁决**计数(缓存命中与熔断短路不计):deny → 连续计数+1 且总计数+1;allow → 连续计数清零;defer → 不变。两档:连续 3 次 deny 触发(可恢复档,触发后清零给模型机会)+ 会话累计 20 次 deny 触发(硬顶,永不复位);触发后默认返回 `deny`(可配 defer)。默认值见 `src/config-schema.ts:42-46`。

**模型调用**(`src/model-review.ts`):`provider.streamSimple(...).result()`;`AbortSignal.timeout(timeoutMs)` 是唯一中止源(Authorizer 回调拿不到 `ctx.signal`,`model-review.ts:205`);`maxTokens: 512`(`model-review.ts:64`);默认 `timeoutMs: 15000`、模型 `anthropic/claude-haiku-4-5`、`reasoning: "off"`(`config/config.example.json`)。注意一个实测陷阱:Anthropic provider 捕获 abort 后 resolve 空消息(stopReason="aborted")而非 reject,因此空回复要区分 `timeout` vs `empty-reply`(`model-review.ts:146-172`)。

### 3.3 `wangzexi/pi-auto-approve@1.1.0` —— 自省调用路径、裁决 JSON 契约

**三层**(`auto-approve.ts`):

1. **Tier 1 自动放行**(15 条正则,`auto-approve.ts:23-40`):`ls/dir/tree`、`cd`、`cat/head/tail/less/more`、`file/stat/wc/du/df`、`grep/rg/ag/ack`、`find/locate/which/whereis/type`、git 只读子命令(status/log/diff/show/branch/tag/stash list/remote/ls-remote/rev-parse/rev-list/describe/whatchanged/shortlog/blame/grep/config --get)、docker 只读、npm/yarn/pnpm 只读(list/info/view/outdated/audit/why)、pip 只读、`echo/printenv/env/whoami/hostname/uname/uptime/id/groups/pwd/date`、`<cmd> --version/--help`。
2. **Tier 2 自动阻止**(7 条正则,`auto-approve.ts:42-50`):`rm -rf /`、`rm -rf /etc|/usr|/var`、fork 炸弹 `:(){ }`、`dd of=/dev/*(非 null)`、`mkfs.*`。
3. **Tier 3 自省审查**:同模型 + 完整对话上下文。

**自省调用路径**(`auto-approve.ts:255-291`):

```typescript
const reviewModel = resolveReviewModel(ctx.modelRegistry, ctx.model);      // ctx.model 经 registry.find 重新解析(行 214-218)
const { systemPrompt, messages } = buildReviewContext(
  ctx.sessionManager, ctx.getSystemPrompt(), command);                      // 复用主会话系统提示+分支消息(行 260)
const auth = await ctx.modelRegistry.getApiKeyAndHeaders(reviewModel);      // 凭据(行 261)
completeSimple(reviewModel, { systemPrompt, messages }, {
  apiKey: auth?.apiKey, env: auth?.env, headers: auth?.headers,
  cacheRetention: "short",                    // 前缀缓存
  sessionId: ctx.sessionManager.getSessionId(),// session 亲和,复用主会话缓存前缀
  signal: ctx.signal,
  temperature: 0, maxTokens: 80,
});
```

`buildReviewContext`(行 122-144):克隆 `sessionManager.getBranch()` 的消息,**剔除 toolResult 与 assistant 的 toolCall 部分**(只留 text/thinking),避免把未闭合工具调用格式喂回模型导致其继续输出 DSML/tool-call;末尾追加一条 user 角色的审查请求(固定规则在前、动态命令在后,利于前缀缓存)。注释明确目标:"same model/prefix segments, favoring cache hit rates"(文件头注,行 5-14)。UI toast 还会显示缓存命中率 `CH = cacheRead/(cacheRead+input)`(行 55-67)。

**审查提示词**(`buildReviewPrompt`,行 96-120):`<safety_review>` XML 包裹 —— instruction(仅本次完成,扮演内部安全审查员,不得继续任务)/rules(`<allow>` 只读低风险或用户明确请求、用户请求的公开网络诊断;`<block>` 破坏性、密钥相关、凭证/私 file 外泄、无明确授权的状态变更、模糊不清)/output_contract/示例;命令放在 `<command><![CDATA[...]]></command>` 中(CDATA 防注入,`toCdata` 转义 `]]>`,行 84-86)。

**裁决 JSON 契约**(行 106-109、146-176):**恰好两个键** `{"verdict":"allow"|"block","reason":"..."}`(键集合严格校验 `keys.length===2`);`extractFirstJsonObject` 用括号配平扫描提取首个 JSON 对象(容忍 ```json 围栏);reason 空或 verdict 非枚举 → 无效。

**失败策略 = fail-OPEN(与另两个扩展相反)**:30 秒超时 → 放行 + toast 警告(行 293-296);`stopReason==="error"` → 放行(行 300-303);解析失败 → 放行(行 308-315);catch 兜底 → 放行(行 317-320)。仅非交互模式(`!ctx.hasUI`)与无模型/无凭证时 block(行 250-252, 261-265)。

**兼容性注意**:`import { completeSimple } from "@earendil-works/pi-ai"`(行 18)在 pi-ai@0.84.3 包根已不存在(实测 undefined),该扩展依赖旧版 pi-ai 的包根导出;参照实现时应改用 `ctx.modelRegistry.complete()` 或 compat 子路径。

### 3.4 附:Authorizer 链缝(gotgenes/pi-permission-system)

若走"权限系统 + 链环"生态而非独立 `tool_call` 钩子:`@gotgenes/pi-permission-system` 定义 `Authorizer.authorize(details, query, log) → Promise<allow|deny|defer>`(`pi-packages/packages/pi-permission-system/src/authority/authorizer.ts:20-41`),defer = 交下一链环;终结链环(LocalUserAuthorizer 等)不可 defer。第三方扩展经 `getPermissionsService().registerAuthorizer(name, fn)` 注册链环(ai-guard `src/extension.ts:136`),`query.checkPermission(...)` 提供确定性引擎的当前判定(门控平价)。这是 ai-guard 选择的集成方式,与 pi-permission / pi-auto-approve 的"独立 tool_call 钩子"方式二选一。

---

## 四、规则层种子集(供原型直接采用)

以下清单从三个扩展的实现中提取合并,可直接作为 pi-auto-mode 原型的规则层初值。

### 4.1 Bash 无条件白名单(只读/无副作用,直接放行)

源自 pi-permission `BUILTIN_UNCONDITIONAL_SAFE`(50 条)+ pi-auto-approve Tier 1 补充:

```
arch basename cat cd cksum cmp column comm cut diff dirname du df echo expand
expr false file fold grep groups head id jq ls md5sum nl paste printenv ps pwd
readlink realpath rev seq sha256sum shasum stat tail tr true tsort uniq uname
uptime wc whereis who whoami which
```

补充(命令前缀正则):`tree`、`less/more`、`rg/ag/ack`、`locate/type`、`hostname/env`、`date`(禁 `-s/--set`)、`<任意命令> --help|-h`、`<python|node|uv|tsx|npx> --version|-v`。

### 4.2 Bash 条件白名单(argv 级 flag 检查)

| 命令 | 放行条件 | 禁止 flag |
|---|---|---|
| `git` | 仅 `status/log/diff/show/branch` 且参数只读 | 全局:`-C -c -p --config-env --exec-path --git-dir --namespace --paginate --super-prefix --work-tree`;子命令:`--output --ext-diff --textconv --exec`;`branch` 仅 `--list/-l/--show-current/-a/-r/-v*/--format=` |
| `find` | 默认 | `-exec -execdir -ok -okdir -delete -fls -fprint -fprint0 -fprintf` |
| `rg` | 默认 | `--pre --hostname-bin --search-zip -z` |
| `base64` `sort` `iconv` `shuf` | 默认 | `-o/--output`(含合并短 flag 簇如 `-fo` 中的 `o`) |
| `sed` | 仅 `sed -n {N|M,N}p [file]`(argv≤4) | 其他一切形式 |
| `date` | 默认 | `-s/--set`(含短 flag 簇含 `s`) |
| `npm/yarn/pnpm` | 仅 `list/info/view/outdated/audit/why/config list` | 其他子命令 |
| `pip/pip3` | 仅 `list/show/freeze/search` | 其他子命令 |
| `docker/podman` | 仅 `ps/images/inspect/logs/stats/info/version/history/top/diff` | 其他子命令 |

### 4.3 Bash 危险模式(直接 deny,正则,`i` flag)

取自 pi-permission `BUILTIN_DANGER_RULES`(12 条)+ pi-auto-approve Tier 2(7 条),按主题归并:

1. **递归删除**:`\brm\b.*(\s-(?:[a-zA-Z]*r)|--recursive)`;根/系统目录特化:`\brm\s+(-rf?|--recursive)\s+(/|/etc|/usr|/var)(?:\s|$)`(后者属于"灾难级",建议永不可被配置降级)
2. **提权**:`\bsudo\b`
3. **权限弱化**:`\bchmod\b.*(777|a\+rwx|ugo\+rwx|ugo=rwx)`;可补 `chmod` setuid(`\bchmod\b.*\b[ug]\+s\b`)
4. **裸设备写**:`(>\s*/dev/(sd|hd|nvme|mmcblk|vd|xvd)[a-z0-9]+|of=/dev/(sd|hd|nvme|mmcblk|vd|xvd)[a-z0-9]+)`;`\bmkfs\.`
5. **破坏性 VCS**:`\bgit\s+push\s+.*(-f\b|--force\b)`;`\bgit\s+reset\s+--hard\b`;`\bgit\s+clean\b.*(\s-(?:[a-zA-Z]*f)|--force)`;`\bgit\s+checkout\s+(--\s+)?\.\s*($|[;&|])`;`\bgit\s+restore\b`
6. **远程代码执行**:`\b(curl|wget)\b.*\|\s*(ba)?sh\b`
7. **GitHub 远端变更**:`\bgh\s+repo\s+(create|delete|rename|archive)\b`;`\bgh\s+release\s+(create|delete|edit)\b`
8. **fork 炸弹**:`:\(\)\s*\{`

注意两条工程细节(来自 pi-permission 注释):短 flag 簇前必须锚定空白(`\s-`),否则 `.*` 回溯会把 `--verbose` 等长选项中的字母误当短 flag;管道类模式(`curl|sh`)必须对**完整命令串**检查,AST 拆分后的单 argv 看不到 `|`。

### 4.4 文件路径敏感度分级(read/write/edit 工具的 path 匹配)

综合 pi-permission 提示词规则与 ai-guard SAFETY_RULES:

| 级别 | 路径 | 默认动作 |
|---|---|---|
| S0 密钥/凭证(读取即高危) | `~/.ssh/**`、`~/.aws/**`、`~/.gnupg/**`、`**/.env*`、`**/*credentials*`、`**/id_rsa*`、`**/*.pem`、`**/*_history`、`~/.config/gh/**`、`~/.pi/agent/auth.json` | deny(读取)/ deny(写入) |
| S1 系统配置 | `/etc/**`、`/usr/**`、`/var/**`、`/System/**`、`/etc/sudoers*`、`**/authorized_keys` | deny(写入);读取转 ask/AI |
| S2 用户配置(持久化入口) | `~/.bashrc` `~/.zshrc` `~/.profile`、shell RC、`~/.gitconfig`、`crontab`、`~/Library/LaunchAgents/**`、`~/.config/systemd/**` | 写入 ask/deny;读取允许(非密钥部分) |
| S3 仓库元数据 | `.git/hooks/**`、`.git/config`、`.gitmodules` | 写入 deny(可执行代码入口) |
| S4 项目内(CWD) | `join(ctx.cwd, "**")` | 写入允许(有界、匹配任务意图);`..`/symlink 逃逸视同 CWD 外 |
| S5 CWD 外普通文件 | 其他 | 写入 ask;读取非密钥 → ask 或交 AI defer |

### 4.5 AI 裁决层的可直接复用件

- **裁决契约**:三态 `{outcome|verdict: allow, deny|block, ask|defer}` + `risk_level` + 简短 `reason`,严格 JSON;解析三层容错(提取 JSON → parse → 枚举校验),解析失败 fail-closed(pi-permission)或 fail-open(pi-auto-approve)——**原型建议 fail-closed 到 ask**。
- **缓存**:(commandHash, contextHash) 双键 LRU;defer 不入缓存。
- **熔断**:连续 N 次 deny 触发可恢复档 + 会话累计 M 次硬顶;触发返回 deny。
- **偏差补丁**:高风险时 AI 的 allow 不可信(high+allow → deny),低风险但不许自动放行时(low+allow → ask)。
- **提示词防注入**:可信/不可信内容分区;不可信文本去零宽字符、折叠空白、密钥打码、JSON 转义内联;命令放 CDATA;system prompt 保持精简(成本/延迟)但输出契约不可被自定义指令覆盖。

---

## 五、证据清单(一手来源)

本机安装(`~/.bun/install/global/node_modules/`):

- `@earendil-works/pi-coding-agent/docs/extensions.md` —— tool_call(70-73, 760-776)、ctx.modelRegistry(995-999)、ctx.signal(1001-1011)、ctx.cwd 项目配置(958-973)、ctx.isProjectTrusted(976-980)、registerFlag/getFlag(1633-1648)、错误处理(2904)
- `@earendil-works/pi-coding-agent/docs/settings.md` —— 全部内置设置键(无扩展自定义键)
- `@earendil-works/pi-coding-agent/docs/sdk.md:445-448` —— 凭证查找顺序
- `dist/core/model-registry.d.ts:11-35` —— `complete` / `getApiKeyAndHeaders` / `getProviderAuth` 类型
- `dist/core/model-runtime.js:422-451` —— `prepareRequest` 凭证注入实现
- `dist/core/extensions/types.d.ts:209-249` —— ExtensionContext 完整字段(无 settings 访问器)
- `dist/config.d.ts:77` + `dist/index.d.ts:2` —— `getAgentDir()` 官方导出
- `@earendil-works/pi-ai/dist/types.d.ts:53, 128-137` —— StreamOptions 的 signal/cacheRetention/sessionId
- `@earendil-works/pi-ai/dist/compat.d.ts:1-10, 65-66` —— compat 临时入口与 completeSimple 声明
- `examples/extensions/summarize.ts:163-187` —— 官方 `modelRegistry.complete` 示例
- `examples/extensions/interactive-shell.ts:102-105` —— 环境变量配置示例

参考扩展(调研副本在 `/Volumes/RamDisk/pi-research/`):

- `@zhushanwen/pi-permission@1.3.3`(npm pack):`src/pipeline.ts`、`src/rules/builtins.ts`、`src/ast/analyzer.ts`、`src/classifier/{prompt,classifier,json-parser,model-resolver}.ts`、`src/config.ts`、README
- `@zhushanwen/pi-llm-shared@0.4.1`(npm pack):`src/call.ts`、`src/resolve.ts`
- `pi-permission-ai-guard@0.7.0`(npm pack):`src/{review-pipeline,transcript-stripper,prompt,session-state,model-review,verdict,config-loader,config-schema,utils,extension}.ts`、`config/config.example.json`
- `wangzexi/pi-auto-approve@1.1.0`(github clone):`auto-approve.ts`、README.md
- `gotgenes/pi-packages`(github clone):`packages/pi-permission-system/src/authority/authorizer.ts`
