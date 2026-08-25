# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/lang/zh-CN/).

## [Unreleased]

### Added

- `extensions/auto-mode.ts`:Auto Mode 扩展原型 —— 在 `tool_call` 钩子上实现「规则层前置 + 模型分类器兜灰区」的三态裁决(allow / ask / deny)(#3)
  - 规则层:bash 无条件/条件白名单 + 危险正则(对完整命令串匹配)+ 文件路径敏感度六级(S0 密钥 ~ S5 CWD 外)
  - 模型分类器:Claude Code 风格 `<transcript>` 精简转录 + `<verdict>` 前缀输出契约;默认"自省"(继承当前会话模型),可用 `--auto-mode-model` / `PI_AUTO_MODE_MODEL` 指定
  - fail-closed:分类器异常/超时(15s)/输出违反契约 → 拦截;非交互模式 ask → 拦截
  - 透明性:`/automode` 开关命令、footer `🛡️ auto` 状态、拦截通知含裁决理由、`PI_AUTO_MODE_DEBUG=1` 全量裁决通知
- `research/claude-code-classifier-prompts.md`:从 Langfuse 还原 Claude Code 权限分类器提示词(数百条样本/24h)(#4)
- `research/pi-model-call-and-ref-implementations.md`:Pi 扩展模型调用/配置 API 调研与三个开源权限扩展实现提取,含规则层种子集(#2)
- `CONTEXT.md`:领域术语表(Auto Mode / 裁决 / 规则层 / 灰区 / 分类器 / 自省 / fail-closed / 三态裁决 / ask 降级)
- `package.json` + `tsconfig.json`:扩展类型检查(`bun run typecheck`)
