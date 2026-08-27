# pi-verdict

[English](README.md) | **[简体中文](README.zh-CN.md)**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/pi-verdict)](https://www.npmjs.com/package/pi-verdict)
[![pi extension](https://img.shields.io/badge/pi-extension-blueviolet)](https://pi.dev)

**pi-verdict 是 [pi](https://pi.dev) 的 Claude Code 的 Auto mode 式的权限门禁:每次工具调用执行前先过检查——放行、拦截,或先问你。**

- 内置危险规则与你的 allow/deny 规则以零延迟先行裁决明确情形
- 其余交给携带会话上下文的模型分类器
- 任何不确定或失败一律 fail-closed, 绝不静默放行
- 只有几百行的极简代码

## 问题

pi 没有内置的逐次权限确认——每次工具调用都以 pi 进程自身的权限直接执行([pi 安全文档](https://pi.dev/docs/latest/security))。

pi-verdict 补上这道缺失的门禁, 由模型基于上下文和你的意图判定是否可以运行.

## 为什么是三态

**verdict 是裁决,不是开关。** 本品类的分类器大多只输出二值 allow/block。三态有意义的地方在:`ask` 把真正含糊的动作转交人类确认(非交互会话中降级为 `deny`),「不确定」永远不会静默变成「放行」。

## 快速开始

```bash
# 从 npm 安装(已收录 pi 官方包目录: https://pi.dev/packages/pi-verdict)
pi install npm:pi-verdict

# 或直接从源码 —— 试用一次
pi --extension ./extensions/auto-mode.ts

```

- `/automode` —— 显示当前状态:开/关 + 本会话影子缓存统计
- `/automode on`
- `/automode off`
- footer 恒显 `auto mode on`(高亮)/ `auto mode off`(暗色)

| 配置 | 默认 | 说明 |
|---|---|---|
| `--auto-mode` / `--no-auto-mode` | 开 | 总开关 |
| `--auto-mode-model provider/id` | 会话模型 | 分类器模型(默认"自省") |
| `--auto-mode-debug` | 关 | 全量裁决通知 |
| `PI_AUTO_MODE_MODEL` | — | 模型配置的环境变量形式 |
| `PI_AUTO_MODE_DEBUG=1` | 关 | 调试的环境变量形式(flag 优先) |

### 用户规则(`config/pi-verdict.json`)

```json
{
  "allow": ["^ls\\b", "^git (status|log|diff)\\b"],
  "deny":  ["rm ", "docker ", "^/etc/"],
  "builtinDenyFloor": true,
  "classifierModel": null
}
```

- `allow`/`deny` 为 JS 正则数组;**`deny` 优先于 `allow`**,两者都优先于分类器
- 匹配目标:bash = **完整命令串**;文件类工具(read/write/edit/grep/find/ls)= **绝对路径**;其余工具(MCP 等)恒走分类器
- `builtinDenyFloor: false` 可整体关闭内置危险/路径拦截(风险自担;分类器与你的规则仍在)
- `classifierModel: "provider/model-id"` 持久指定分类器模型(如轻量 flash 类);优先级 flag > env > config > 自省;无效值回退会话模型并一次性警告
- spec 支持 pi 原生 `--model` 思考级别后缀:`"zai/glm-5.3-flash:low"` 将分类器思考设为 effort low(无后缀缺省 = 显式关思考,[实测](research/thinking-param-blackhole.md)背书的默认)
- 首次运行自动生成模板 `~/.pi/agent/config/pi-verdict.json`(尊重 `PI_CODING_AGENT_DIR`);修改后新会话生效

为什么没有内置白名单?第三方安全审计(见 [`research/rule-layer-security-audit.md`](research/rule-layer-security-audit.md))证明白名单的健全性需要 shell AST 分析——每条内置「永远放行」都是作者维护的安全声明。因此内置层只做 **deny** 声明(方向健全),allow 声明归你。

需要 pi ≥ 0.84。交互与非交互(`-p`/json/rpc)会话均支持;非交互模式下 `ask` 降级为 `deny`。

## 与品类对比

| | 三态裁决 | 分类器携带上下文 | fail 方向 | 运行时依赖 |
|---|---|---|---|---|
| **pi-verdict** | ✅ allow / ask / deny | ✅ 近期用户意图 + 工具调用 | **closed**(异常/超时/违约 → deny;非交互 ask → deny) | **0** |
| [@czottmann/pi-automode](https://github.com/czottmann/pi-automode) | 规则三态,分类器二态 | ✅ 预算化 transcript | closed | 1 |
| [@zhushanwen/pi-permission](https://www.npmjs.com/package/@zhushanwen/pi-permission) | ✅(outcome) | ❌ 单轮无上下文 | closed(→ ask) | 4 |
| [@gotgenes/pi-permission-system](https://github.com/gotgenes/pi-packages) | ✅ 纯确定性 | —(无内置分类器) | closed | 3 |

完整全景:[`research/pi-permission-landscape.md`](research/pi-permission-landscape.md) · 与最近架构亲缘的收敛分析:[`research/pi-automode-convergence.md`](research/pi-automode-convergence.md)。

诚实地说:pi-automode 与 pi-verdict 在**架构上已收敛**(deny floor → 用户规则 → 分类器,fail-closed——见收敛分析)。这里仍然不同的是:分类器能说 `ask`(运行时人工介入,而非仅由规则预声明)、内置 floor 可以关(`builtinDenyFloor`——用户主权)、零依赖单文件(~700 行,刻意为之)、以及测量的习惯——本仓库每个设计决策都有随库研究背书。

零依赖单文件形态是有意为之——整个扩展就是一个可通读的 [~700 行文件](extensions/auto-mode.ts)。

## 管线

```
tool_call
  │
  ├─ 1. 规则层(确定性,零延迟)
  │     ├─ 内置 deny floor:bash 危险正则(完整命令串)+ 路径敏感度 S0–S5
  │     ├─ 用户规则:deny 优先于 allow(正则,见下)
  │     └─ 无内置白名单 —— 「永远放行」的声明由你自己做
  │
  ├─ 2. 灰区 → 模型分类器(默认继承会话模型 —— "自省")
  │     ├─ 输入:CC 风格 <transcript>(最近 5 条用户消息 + 最近 10 次工具调用,
  │     │        待审动作固定在末尾)—— 用户意图是证据
  │     ├─ 输出契约:<verdict>allow|ask|deny</verdict> 前缀锚定
  │     ├─ 显式关思考(thinkingEnabled: false)+ 两档重试 512→1024
  │     └─ 可用 --auto-mode-model 配置
  │
  └─ 3. 三态裁决
        ├─ allow → 放行
        ├─ deny  → 拦截,理由回传 agent
        └─ ask   → 人工确认(ctx.ui.confirm);非交互模式降级为 deny

  [影子缓存](observe-only,与 2/3 并行,永不改变裁决)
        回放双键 LRU(128)测量 would-be 命中率
```

**fail-closed**:分类器异常 / 超时(15s)/ 输出违反契约 → 拦截,绝不静默放行。

## 证据驱动,不靠直觉

这里的设计决策用测量收敛,实验记录随仓库发布:

- [`research/cache-sim`](research/cache-sim/README.md) —— 回放 1.2k+ 条真实分类器裁决,实测裁决缓存命中率(**3.2%** → 缓存暂缓,改建影子模式遥测)
- [`research/thinking-param-blackhole.md`](research/thinking-param-blackhole.md) —— 思考模型烧尽分类器预算的三层取证,以及为什么修复是 `thinkingEnabled: false`
- [`research/rule-engine-sim`](research/rule-engine-sim/README.md) —— 用 746 条真实 bash 调用实测 tree-sitter 规则引擎移植(**灰区吸收 0 条**)并否决
- [`research/pi-permission-landscape.md`](research/pi-permission-landscape.md) —— 本 README 定位所对照的竞品全景
- [`research/rule-layer-security-audit.md`](research/rule-layer-security-audit.md) —— 规则层第三方安全审计(8/8 复现 → 0.2.0 架构性修复)
- [`research/pi-automode-convergence.md`](research/pi-automode-convergence.md) —— 与 pi-automode 何处真正收敛、何处仍然不同
- [`research/claude-code-classifier-prompts.md`](research/claude-code-classifier-prompts.md) —— Claude Code 分类器设计的结构化还原(基于自托管 Langfuse 观测),本扩展 transcript 契约的血统来源

## 状态与限制

原型质量 —— 可用,未硬化:

- 设计上无内置白名单(见[安全审计](research/rule-layer-security-audit.md)与[用户规则](#用户规则configpi-verdictjson));allow 配置为空时大多数命令进分类器 —— 延迟敏感可 `--auto-mode-model` 指向轻量模型
- AGENTS.md 未作为降权意图证据传入分类器(Claude Code 有此设计)
- 并行灰区调用串行裁决
- 自省意味着会话模型亲自裁决 —— 若延迟/成本敏感,用 `--auto-mode-model` 指向轻量模型(开放问题见 issue tracker)
- 影子缓存按决议仅观察不生效;实测命中率达标后,生效开关是一行改动

**verdict 不是沙箱。** 它在 pi 进程内裁决工具调用;不能遏制恶意代码、不能防护被攻陷的进程、不守护手工 `!` shell 逃逸。需要隔离请用操作系统级沙箱。

命名:三态**裁决(verdict)**是核心概念。UX 保留 `/automode` —— 模式概念上溯 Claude Code 的 auto mode,本项目亦借鉴了其 transcript 设计。

## 开发

```bash
bun install
bun run typecheck
bun test          # 42 个离线桩测试:deny floor / 用户规则 / 审计回归 / 分类器重试 / 影子缓存 / 命令
```

Issue tracker 与决策记录在 GitHub issues(「地图」issue #1 为索引)。

## 许可

[MIT](LICENSE)
