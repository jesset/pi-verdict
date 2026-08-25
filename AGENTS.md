## 通用

- YOU MUST: 始终使用简体中文回复
- 技术表述必须使用规范的书面化术语，不要自造口语化隐喻（如"盲窗"）；若概念需要简称，用标准术语或首次出现时在括号中标注规范语义
- YOU MUST: 每次有功能改变时总是不要忘记同步更新到相关文档中: CLAUDE.md README.md 等

## Agent skills

### Issue tracker

Issues live as GitHub issues in this repo, managed via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Five default triage labels — `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix` — each label string equal to its role name. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: a root `CONTEXT.md` plus `docs/adr/`. See `docs/agents/domain.md`.

## Git 规范

- 功能分支命名: feat/description-with-dash-seperated-and-MAY-contains-issue-number
- YOU MUST: 在git commit时,总是使用 [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) 的方式
- YOU MUST: 合并到main分支前更新 CHANGELOG, 使用 <https://keepachangelog.com/> 的方式
- YOU MUST: 除非被许可, 不要未经用户允许执行 git commit 提交代码变更

## 工具

- 当需要查看 github 上一些项目的源码的时候, 你总是可以使用本地已经安装了的 github 的cli 工具查看(bash: gh api)
- 当需要临时 git clone 开源项目代码时, 总是使用 /Volumes/RamDisk 代替 /tmp 作为临时目录
