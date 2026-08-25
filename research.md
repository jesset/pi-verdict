# Pi coding agent 是否有类似 Claude Code Auto Mode 的功能?

> 研究问题:Pi 中是否存在类似 Claude Code "Auto Mode" 的功能或插件 —— 即**工具调用权限由模型自动分类判定**。

## TL;DR 结论

**没有。** Pi 既没有内置的 Auto Mode,也没有现成的插件/包实现它。但 Pi 的扩展机制(`tool_call` 钩子)提供了**自行构建**该功能所需的全部原语。

关键区别在于架构的"默认值"是反过来的:

| | Claude Code | Pi |
|---|---|---|
| 默认行为 | 执行前**提示用户**批准 | **直接执行**,无提示 |
| Auto Mode 的含义 | 用分类器**自动批准**安全调用,减少 93% 的批准疲劳 | (无此概念) 若要实现,应是"用分类器**自动拦截**危险调用" |
| 实现位置 | 核心内置的权限模式系统 | 由扩展(`tool_call` 钩子)自行实现 |

因此,把 Claude Code 的 Auto Mode "照搬"到 Pi 在语义上不成立 —— Pi 根本没有"逐次工具调用提示"这个环节可以去"自动批准"。等价物是一个**自动门禁扩展**:用模型对每次 `tool_call` 做分类,决定放行还是 `block`。

---

## 一、参考点:Claude Code Auto Mode 是什么

来自 Anthropic 工程博客与官方文档的描述:

- Claude Code 有**权限模式**(permission modes):Manual(逐次提示)、Plan(只读探索)、acceptEdits(自动接受文件编辑)、**Auto**(分类器自动判定)。
- Auto Mode 的核心:用户配置信任的仓库/存储桶/域名,设置默认的 allow / block 规则;然后由**分类器**对每次工具调用判定是否需要询问,从而"在提高安全性的同时减少批准疲劳"(用户原本会批准 93% 的提示)。
- 即:模型/分类器**逐次**对工具调用做权限分类 —— 安全的自动放行,可疑的才提示。

## 二、Pi 的实际设计(基于官方文档)

### 1. Pi 明确把"权限弹窗 / plan mode"排除在核心之外

`docs/usage.md` → "Design Principles" 原文:

> Pi keeps the core small and pushes workflow-specific behavior into extensions, skills, prompt templates, and packages.
> **It intentionally does not include built-in MCP, sub-agents, permission popups, plan mode, to-dos, or background bash.** You can build or install those workflows as extensions or packages, or use external tools such as containers and tmux.

→ 没有"permission popups"、没有"plan mode"作为内置功能。Auto Mode(本质是一种权限判定机制)自然也不在核心里。

### 2. Pi 没有内置沙箱,工具默认以用户权限直接执行

`docs/security.md`:

> Pi is a local coding agent. It runs with the permissions of the user account that starts it... **Pi does not include a built-in sandbox.** Built-in tools can read files, write files, edit files, and run shell commands with the permissions of the pi process.

→ 没有"逐次工具调用需要批准"的机制,因此也不存在"自动批准"的对象。

### 3. Pi 唯一的"权限类"内置机制是 Project Trust,但它管的是"输入加载",不是工具调用

`docs/security.md` / `docs/settings.md`:

- `defaultProjectTrust`: `"ask"` / `"always"` / `"never"` —— 控制**是否加载项目本地的 settings / 扩展 / skills / packages**,是"输入侧防护"。
- 明确写道:**"It is not a sandbox and it does not restrict what the model can ask tools to do after you start working in a directory."**

→ 与"工具调用权限分类"无关。

### 4. settings.json 里没有 permission mode / auto mode 类配置

通读 `docs/settings.md`,与工具/权限相关的设置只有:

- `defaultTools`:启动时启用哪些内置工具(`read`/`bash`/`edit`/`write`/`grep`/`find`/`ls`)。
- CLI:`--tools`(白名单)、`--exclude-tools`、`--no-builtin-tools`、`--no-tools`。
- `defaultProjectTrust`:项目信任。

没有任何 `permissionMode` / `autoMode` / `allowRules` / `blockRules` 字段。CLI 也没有 `--permission-mode` 标志(对照 Claude Code 的 `--permission-mode auto`)。

### 5. CHANGELOG 全文检索:无 auto-mode 特性,只有 plan-mode **示例扩展**

在 `CHANGELOG.md` 检索 `auto.?mode|plan.?mode|permission mode|auto.?approve|acceptEdits`,命中的全是:

- `plan-mode` **示例扩展**(Claude Code 风格的只读探索模式)的修复与增强 —— 例如 issue #5957、#5940、#3240、#746、#694,以及 "#4221: New example hook: plan-mode.ts"。
- 以及若干"Token Plan""Coding Plan"等**模型套餐**名称(与权限无关)。

→ 没有任何 auto-mode 相关的变更记录。

## 三、现有扩展/示例:最接近的东西是什么?

Pi 把这些工作流推给扩展。`examples/extensions/` 下与权限/模式相关的示例:

| 示例 | 机制 | 是否 = Auto Mode? |
|---|---|---|
| `permission-gate.ts` | `on("tool_call")` + 正则匹配 `rm -rf`/`sudo`/`chmod 777` + `ctx.ui.confirm` 人工确认 | ❌ 规则匹配 + 人工确认,无模型分类 |
| `protected-paths.ts` | `on("tool_call")` 按路径拦截写操作 | ❌ 纯规则 |
| `confirm-destructive.ts` | `session_before_switch`/`session_before_fork` 人工确认 | ❌ 会话级,非工具调用级 |
| `plan-mode/` | 禁用 edit/write + bash 只读白名单 + `/plan` 命令 + 进度 widget | ❌ 这是 **Plan Mode**(只读探索),不是 Auto Mode |
| `minimal-mode.ts` / `timed-confirm.ts` / `tool-override.ts` | UI / 超时确认 / 工具改写 | ❌ 均非模型分类 |

`permission-gate.ts` 的核心代码(典型范式):

```ts
pi.on("tool_call", async (event, ctx) => {
  if (event.toolName !== "bash") return undefined;
  const command = event.input.command as string;
  const isDangerous = dangerousPatterns.some((p) => p.test(command));
  if (isDangerous) {
    if (!ctx.hasUI) return { block: true, reason: "..." };
    const choice = await ctx.ui.select(`⚠️ Dangerous command:\n\n  ${command}\n\nAllow?`, ["Yes", "No"]);
    if (choice !== "Yes") return { block: true, reason: "Blocked by user" };
  }
  return undefined;   // 不 block = 放行
});
```

**这些示例全部是"规则 + 人工确认"或"规则拦截",没有一个用模型/分类器自动判定。** 也没有任何已安装的包实现它(已安装的 pi-* 包为 `pi-mcp-adapter`、`pi-observational-memory`、`pi-tool-display`、`pi-tps-meter`、`pi-web-access`、`pi-workspace-history`,均与权限判定无关)。

## 四、Pi 构建 Auto Mode 的可行路径(机制已具备)

`docs/extensions.md` → `tool_call` 钩子提供了所需的全部原语:

- 在工具**执行前**触发,**可 block**。
- `event.toolName`(`"bash"`/`"read"`/`"write"`/`"edit"`/...)、`event.toolCallId`、`event.input`(可变,能就地改写工具参数)。
- 返回 `{ block: true, reason?: string, terminate?: boolean }` 即可拦截。
- 处理器是 `async`,可 `await` 任意逻辑 —— 包括调用一个 LLM 分类器。
- 多个处理器按扩展加载顺序链式叠加;后续处理器能看到前者的改动。

因此一个"Pi Auto Mode 扩展"的实现轮廓是:

```ts
pi.on("tool_call", async (event, ctx) => {
  // 1. 取出工具与参数(可对 bash 取 command、对 write 取 path 等)
  // 2. 命中硬性 block 规则 → 直接 block(类似 permission-gate)
  // 3. 命中硬性 allow 规则 → 直接放行
  // 4. 灰区 → 调用分类器模型(可用 fetch 调外部,或复用 Pi 的 provider)
  //    给它:工具名、参数、项目信任上下文、组织 allow/block 规则
  //    分类为 safe / risky / dangerous → 对应 放行 / 提示 / block
  // 5. (可选) ctx.hasUI 为 false 时走纯自动策略,避免卡死非交互模式
});
```

这与 Claude Code Auto Mode 的"分类器 + allow/block 规则 + 信任上下文"三件套在**能力上等价**,只是方向相反:Claude 是"默认提示 → 分类器自动批准",Pi 是"默认放行 → 分类器自动拦截"。

## 五、结论

1. **内置:没有。** Pi 在设计上明确不含 permission popups / plan mode / 权限模式系统,因此没有 Auto Mode 的内置对应物(`docs/usage.md` Design Principles)。
2. **现成插件:没有。** 官方示例与已安装包里最接近的是 `permission-gate.ts`(规则+人工确认)和 `plan-mode/`(只读模式),都不是"模型自动分类工具调用权限"。CHANGELOG 也无相关记录。
3. **可自行构建:可以,且原语齐全。** `tool_call` 钩子能在执行前拦截/改写任意工具调用,并支持 `async` 调用模型分类器。要实现"Pi 版 Auto Mode",应做成一个扩展:硬规则 + 模型分类器对灰区判定,语义上是"自动门禁/自动拦截"而非"自动批准"。

### 主要参考来源(Pi 本地文档)

- `docs/usage.md` — Design Principles(明确不含 permission popups / plan mode)
- `docs/security.md` — 无内置沙箱;Project Trust 是输入侧防护而非工具调用限制
- `docs/settings.md` — 无 permissionMode/autoMode 配置项
- `docs/extensions.md` — `tool_call` 钩子:`{ block: true, reason }`、`event.input` 可变、async 处理器
- `examples/extensions/permission-gate.ts` — 规则+人工确认范式
- `examples/extensions/plan-mode/` — Claude Code 风格只读 Plan Mode(非 Auto Mode)
- `CHANGELOG.md` — 仅有 plan-mode 示例扩展记录,无 auto-mode 记录
