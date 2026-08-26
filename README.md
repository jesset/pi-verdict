# pi-auto-mode

Pi coding agent 的 **Auto Mode 扩展原型**:工具调用权限由「规则层 + 模型分类器」自动判定,无需人工逐次批准。

> ⚠️ 这是一个**原型**(prototype),用于验证设计,不是生产质量的权限系统。

## 背景

Pi 默认以 YOLO 模式运行:所有工具调用(read/write/edit/bash)不经任何确认直接执行,核心刻意不内置权限系统(见 `research.md`、`research-pi-auto-mode.md`)。Claude Code 的 Auto Mode 用模型分类器自动裁决工具调用权限,减少批准疲劳。本扩展在 Pi 的 `tool_call` 钩子上实现等价能力 —— 方向相反:Pi 默认放行,本扩展自动拦截。

## 管线设计

```
tool_call
  │
  ├─ 1. 规则层(确定性,零延迟)
  │     ├─ bash:危险正则(对完整命令串)→ deny;白名单(逐段 argv 检查)→ allow
  │     ├─ write/edit:路径敏感度分级(S0 密钥/S1 系统/S3 .git 元数据 → deny;CWD 内 → allow)
  │     └─ read/grep/find/ls:S0 密钥路径 → deny,其余 → allow
  │
  ├─ 2. 灰区 → 模型分类器(默认"自省":继承当前会话 provider/model)
  │     ├─ 输入:CC 风格 <transcript> 精简转录(用户消息流 + 工具调用流,
  │     │       不含 assistant 叙述与工具结果),待审查动作固定为最后一行
  │     ├─ 输出契约:<verdict>allow|ask|deny</verdict> 前缀锚定
  │     └─ 参数:maxTokens=512、reasoning=minimal、temperature=0、前缀缓存
  │
  └─ 3. 三态裁决
        ├─ allow → 放行
        ├─ deny  → 拦截,notify 展示理由
        └─ ask   → 人工确认(ctx.ui.confirm);非交互模式降级为拦截

  [影子缓存](#影子缓存遥测observe-only)(observe-only,与 2/3 并行,不影响裁决)
        灰区裁决同步回放双键 LRU(128)的 would-be 命中,只记录不生效
```

**fail-closed**:分类器异常 / 超时(15s)/ 输出违反契约 → 一律拦截。

设计依据(仓库内调研报告):

- `research/claude-code-classifier-prompts.md` —— 从 Langfuse 还原的 Claude Code 分类器提示词与管线(数百条真实样本/24h)
- `research/pi-model-call-and-ref-implementations.md` —— Pi 扩展模型调用 API 与三个开源权限扩展的实现提取(含本扩展规则层种子集来源)
- `research/cache-sim/` —— 裁决缓存收益离线回放(1,2xx 条 CC 裁决,双键命中率 3.2%),缓存暂缓引入的决策依据(#5)

## 使用

```bash
# 临时加载
pi --extension ./extensions/auto-mode.ts

# 或安装到全局扩展目录(自动发现)
cp extensions/auto-mode.ts ~/.pi/agent/extensions/
```

交互模式下:

- `/automode` —— 开关 Auto Mode;footer 显示 `🛡️ auto` 表示生效中;通知尾行附带本会话影子缓存统计
- 拦截时弹出通知,展示裁决理由

配置:

| 方式 | 说明 | 默认 |
|---|---|---|
| `--auto-mode` / `--no-auto-mode` | CLI flag,总开关 | 开 |
| `--auto-mode-model provider/id` | 分类器模型 | 继承会话当前模型(自省) |
| `PI_AUTO_MODE_MODEL` | 同上的环境变量形式 | — |
| `PI_AUTO_MODE_DEBUG=1` | 所有裁决(含放行)都弹通知,灰区裁决附带影子缓存 would-hit/miss 标注 | 关 |

### 影子缓存遥测(observe-only)

为「是否引入生效裁决缓存」(#5 决议:暂缓,先实测)积累本扩展真实数据。每次灰区裁决前后同步回放「双键 LRU(128)」:**只记录,永不生效** —— 裁决永远来自模型,行为与无影子缓存时完全一致。

- 键:`commandKey = hash(toolName + JSON.stringify(input) + cwd)`;`contextKey = hash(最近 5 条 sanitized user 行,与 transcript 同源)`
- 只回写真实模型 allow/deny;ask 与 fail-closed 不入;上下文变更覆写旧条目
- 观察方式:① `/automode` 通知尾行 —— `影子缓存: 灰区 N · 双键命中 H (P%) · miss 无条目 X/上下文变 Y · 命令重复 R · 分歧 危险 D/保守 C`;② `PI_AUTO_MODE_DEBUG=1` 时灰区裁决通知附 `(影子缓存: would-hit allow)` 或 `miss:no-entry` / `miss:context-changed`
- 「分歧」= 命中时缓存裁决与本次模型裁决不一致的反事实计数:危险(缓存 allow/模型 deny)是未来生效缓存的安全风险信号,保守反之
- 会话内存态,`session_start` 重置;LRU 容量 128、键设计等全部硬编码(#5 定案)
- CC 历史数据回放基准:双键命中率 3.2%,收益集中于重试/轮询循环(`research/cache-sim/`)

## 已验证行为(原型手工测试矩阵)

| 场景 | 路径 | 结果 |
|---|---|---|
| `git status` | 规则层条件白名单 | ✅ 放行执行 |
| `rm -rf /tmp/xxx` | 规则层危险正则 | ✅ 拦截,理由回传 agent |
| `touch ./项目内文件` | 灰区 → 分类器 allow | ✅ 放行执行 |
| `touch /tmp/xxx` | 灰区 → 分类器 ask → 非交互降级 | ✅ 拦截 |
| `write ~/.ssh/xxx` | 规则层 S0 密钥路径 | ✅ 拦截 |
| 分类器输出截断/违反契约 | fail-closed | ✅ 拦截 |
| 影子缓存:同键同上下文重复灰区调用 | observe-only | ✅ would-hit 计数,模型仍真实调用,行为不变 |
| 影子缓存:新 user 消息后重放同命令 | observe-only | ✅ miss:context-changed 并覆写 |
| 影子缓存:ask / fail-closed 结果 | observe-only | ✅ 不回写(重放仍 no-entry) |
| 影子缓存:LRU 128 逐出 | observe-only | ✅ 最旧条目出队 |

未自动化验证:交互模式下的 `ask → ctx.ui.confirm` 人工确认弹窗与 `/automode` 开关(需 TUI)。

## 已知限制(原型简化)

- **bash 分段是朴素切分**,不处理引号包裹的 `|`/`&&` 等;无 AST 结构分析(pi-permission 用 tree-sitter,本原型未引入)
- **无生效裁决缓存**;现为影子缓存 observe-only 遥测(#5 决议:暂缓引入,先实测命中率);**无熔断器**(重议信号:deny 风暴成本失控 / 非交互长期运行)
- 影子缓存硬编码全部参数(容量/键设计),无 flag/env 配置(#5 定案);`--auto-mode-model` 中途切换不失效影子键
- **无用户自定义规则**;规则层种子集见 `extensions/auto-mode.ts` 顶部常量
- **未把 AGENTS.md 作为降权意图证据传入分类器**(CC 有该设计,见调研报告)
- 并行工具调用时,同批灰区调用的分类器请求串行执行,会增加延迟
- 分类器默认用会话当前模型(自省),大模型裁决成本高;可用 `--auto-mode-model` 指定轻量模型

## 开发

```bash
bun install        # 安装 typescript + @types/node(仅类型检查用)
bun run typecheck  # tsc --noEmit
```

注意:`tsconfig.json` 的 `paths` 指向本机全局安装的 `@earendil-works/pi-coding-agent` 类型,换机器需调整。
