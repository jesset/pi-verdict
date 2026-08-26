# pi-verdict

[English](README.md) | **[简体中文](README.zh-CN.md)**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/pi-verdict)](https://www.npmjs.com/package/pi-verdict)
[![pi extension](https://img.shields.io/badge/pi-extension-blueviolet)](https://pi.dev)

> Pi 默认以 YOLO 模式运行:所有工具调用不经确认直接执行。
> **verdict 给每次调用一个三态裁决 —— `allow / ask / deny`。**
> 确定性规则先行;灰区交给携带会话上下文的模型分类器;任何失败路径一律 fail-closed。

**verdict 是裁决,不是开关。** 本品类的分类器大多只输出二值 allow/block。三态有意义的地方在:`ask` 把真正含糊的动作转交人类确认(非交互会话中降级为 `deny`),「不确定」永远不会静默变成「放行」。

## 与品类对比

| | 三态裁决 | 分类器携带上下文 | fail 方向 | 运行时依赖 |
|---|---|---|---|---|
| **pi-verdict** | ✅ allow / ask / deny | ✅ 近期用户意图 + 工具调用 | **closed**(异常/超时/违约 → deny;非交互 ask → deny) | **0** |
| [@czottmann/pi-automode](https://github.com/czottmann/pi-automode) | 规则三态,分类器二态 | ✅ 预算化 transcript | closed | 1 |
| [@zhushanwen/pi-permission](https://www.npmjs.com/package/@zhushanwen/pi-permission) | ✅(outcome) | ❌ 单轮无上下文 | closed(→ ask) | 4 |
| [@gotgenes/pi-permission-system](https://github.com/gotgenes/pi-packages) | ✅ 纯确定性 | —(无内置分类器) | closed | 3 |

完整全景:[`research/pi-permission-landscape.md`](research/pi-permission-landscape.md)。零依赖单文件形态是有意为之——整个扩展就是一个可通读的 [~590 行文件](extensions/auto-mode.ts)。

## 管线

```
tool_call
  │
  ├─ 1. 规则层(确定性,零延迟)
  │     ├─ bash:危险正则(完整命令串)→ deny;白名单(逐段 argv 检查)→ allow
  │     ├─ write/edit:路径敏感度 S0–S5(密钥/系统/.git 元数据 → deny;CWD 内 → allow)
  │     └─ read/grep/find/ls:密钥路径 → deny,其余 → allow
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

## 快速开始

```bash
# 从 npm 安装(首发版本发布后可用)
pi install npm:pi-verdict

# 或直接从源码 —— 试用一次
pi --extension ./extensions/auto-mode.ts

# 或全局安装(自动发现)
cp extensions/auto-mode.ts ~/.pi/agent/extensions/
```

- `/automode` —— 只读状态:开/关 + 本会话影子缓存统计
- `/automode on` / `/automode off` —— 幂等设定;未知参数严格拒绝并列出用法
- footer 恒显 `auto mode on`(高亮)/ `auto mode off`(暗色)
- `pi --auto-mode-debug` —— 全量裁决通知(含放行),附影子缓存标注

| 配置 | 默认 | 说明 |
|---|---|---|
| `--auto-mode` / `--no-auto-mode` | 开 | 总开关 |
| `--auto-mode-model provider/id` | 会话模型 | 分类器模型(默认"自省") |
| `--auto-mode-debug` | 关 | 全量裁决通知 |
| `PI_AUTO_MODE_MODEL` | — | 模型配置的环境变量形式 |
| `PI_AUTO_MODE_DEBUG=1` | 关 | 调试的环境变量形式(flag 优先) |

需要 pi ≥ 0.84。交互与非交互(`-p`/json/rpc)会话均支持;非交互模式下 `ask` 降级为 `deny`。

## 证据驱动,不靠直觉

这里的设计决策用测量收敛,实验记录随仓库发布:

- [`research/cache-sim`](research/cache-sim/README.md) —— 回放 1.2k+ 条真实分类器裁决,实测裁决缓存命中率(**3.2%** → 缓存暂缓,改建影子模式遥测)
- [`research/thinking-param-blackhole.md`](research/thinking-param-blackhole.md) —— 思考模型烧尽分类器预算的三层取证,以及为什么修复是 `thinkingEnabled: false`
- [`research/rule-engine-sim`](research/rule-engine-sim/README.md) —— 用 746 条真实 bash 调用实测 tree-sitter 规则引擎移植(**灰区吸收 0 条**)并否决
- [`research/pi-permission-landscape.md`](research/pi-permission-landscape.md) —— 本 README 定位所对照的竞品全景
- [`research/claude-code-classifier-prompts.md`](research/claude-code-classifier-prompts.md) —— Claude Code 分类器设计的结构化还原(基于自托管 Langfuse 观测),本扩展 transcript 契约的血统来源

## 状态与限制

原型质量 —— 可用,未硬化:

- bash 分段是朴素切分(无引号/AST 感知);AST 移植方案已[实测否决](research/rule-engine-sim/README.md),真实流量出现敏感路径重定向绕过时重议
- 暂无用户自定义规则;规则种子集在 `extensions/auto-mode.ts` 顶部
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
bun test          # 21 个离线桩测试:规则层 / 分类器重试 / 影子缓存 / 命令语义
```

Issue tracker 与决策记录在 GitHub issues(「地图」issue #1 为索引)。

## 许可

[MIT](LICENSE)
