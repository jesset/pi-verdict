## 通用

- YOU MUST: 始终使用简体中文回复
- Language convention: code comments, docs, CHANGELOG entries and release notes are written in English; Chinese only in README.zh-CN.md. Do not mass-rewrite existing Chinese content — convert when a file is touched anyway
- 技术表述必须使用规范的书面化术语，不要自造口语化隐喻（如"盲窗"）；若概念需要简称，用标准术语或首次出现时在括号中标注规范语义
- YOU MUST: 功能变更须同步文档:README.md / README.zh-CN.md / CHANGELOG.md(`[Unreleased]`)/ 术语变化时 CONTEXT.md / 架构决策时 docs/adr/ / 配置模板 `_hint` 文案

## 项目

本仓库是 **pi-verdict**:pi 的极简权限门禁扩展(规则层 + 模型分类器)。涉及领域术语或设计决策时,先读 `CONTEXT.md`(术语表)与 `docs/adr/`;设计结论优先以 `research/` 的随库实测背书(测量习惯)。

### 门禁自指(ADR-0001)

本扩展的安全边界由它自己守护,开发工作流随之受限:

- agent 不可写 `<agentDir>/config/pi-verdict.json` 与 `<agentDir>/extensions/` 下的安装副本——自保护层恒 deny,不可经任何配置豁免
- 实测新版本 = 用户在终端 `cp extensions/auto-mode.ts ~/.pi/agent/extensions/` 后重启 pi(agent 代劳会被拦);改用户规则同理,仅用户手工编辑

### 发布

- 发布序列:`chore(release): bump version` 提交 + 附注 tag + GitHub Release;`gh release` 命令被内置 deny floor 终局拦截,由用户在终端执行
- npm 上架全自动:GitHub Release published → `.github/workflows/publish.yml`(tag/版本双验证 + typecheck + 测试 + npm@11 trusted publishing)

## Agent skills

### Issue tracker

Issues live as GitHub issues in this repo, managed via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Five default triage labels — `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix` — each label string equal to its role name. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: a root `CONTEXT.md` plus `docs/adr/`. See `docs/agents/domain.md`.

## Git 规范

- 功能分支命名: feat/description-with-dash-separated-and-MAY-contains-issue-number
- YOU MUST: 在git commit时,总是使用 [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) 的方式
- YOU MUST: 合并到main分支前更新 CHANGELOG, 使用 <https://keepachangelog.com/> 的方式
- YOU MUST: 除非被许可, 不要未经用户允许执行 git commit 提交代码变更

## 工具

- 当需要查看 github 上一些项目的源码的时候, 你总是可以使用本地已经安装了的 github 的cli 工具查看(bash: gh api)
- 当需要临时 git clone 开源项目代码时, 总是使用 /Volumes/RamDisk 代替 /tmp 作为临时目录
