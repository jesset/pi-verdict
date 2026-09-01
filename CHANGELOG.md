# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/lang/zh-CN/).

## [Unreleased]

## [0.5.1] - 2026-09-01

### Security

- S-rules (S0–S3) now match case-insensitively and S1 gains the macOS firmlink prefixes (`/private/etc`, `/private/var`): on case-insensitive filesystems (default macOS APFS, Windows) case variants name the same file but previously missed the case-sensitive regexes when the target did not exist (realpath cannot normalize a nonexistent path), and firmlink real spellings silently allowed where the `/etc` spelling went gray. denyPaths comparison folds case on darwin/win32 (linux stays case-sensitive) (#21)
- Path sensitivity floor (S0–S5) and the self-protection write check now match every canonical form of the target path (lexical + realpath, rebuilding from the nearest existing ancestor when the target does not exist yet); the in-cwd write allowance requires all forms to sit inside the session cwd's real path. Fixes a symlink-alias bypass where a single classifier-adjudicated `ln -s` aliasing `~/.ssh` or a `.git/hooks` directory let subsequent reads and cwd-scoped writes through the floor with zero model calls (#20)
- Classifier transcript lines are now line-break-escaped and the tool-call path branch goes through the same sanitize pipeline as commands (zero-width stripping + length cap). A path, command, or user message containing embedded line breaks could previously split its transcript line and forge structural lines — e.g. a fake `User:` line instructing the classifier to allow — and tool arguments are model-generated (steerable by prompt-injected file contents), so the surface was real. The escape covers `\n`, `\r\n`, lone `\r` and the Unicode separators U+2028/U+2029/U+0085, which models may render as breaks (#22)

### Changed

- Documentation alignment (#23): classifier timeout documented as 25s (en/zh READMEs; code and the measured p90 basis say 25s, docs said 15s); the volatile offline-test count removed from the dev section; the Status & limitations sections now state two floor scope boundaries explicitly — bash command strings are matched by the danger regexes only (`cat ~/.ssh/id_rsa` goes to the classifier, not the deterministic S0 deny), and on Windows the built-in floor covers bash-shaped patterns only, PowerShell-native dangerous commands rely on the classifier
## [0.5.0] - 2026-08-31

### Added

- `denyPaths`: user-declared protected paths (#16, [ADR-0002](docs/adr/0002-deny-paths-deterministic-ask.md)):
  - plain-path list in `config/pi-verdict.json`; the tool owns normalization — `~`, `$HOME/`, relative, `..`, symlink spellings all resolve, compared per path segment; anchored once per session, so cwd drift or mid-session symlinks cannot re-anchor the declaration
  - any touch — file tools by their path, bash by path tokens from the command string (heredocs included) — triggers a terminal **ask** the user adjudicates; headless sessions degrade to deny
  - priority: after user `deny`, before user `allow` (not even your own allowlist may touch these); unaffected by `builtinDenyFloor: false`; subject to the master switch
  - the classifier sees only a fixed existence hint — zero path plaintext; the matched path appears solely in the local confirm dialog, never in block reasons or notifications
  - `/automode` shows the active count; the config template gains the field; invalid entries warn once at session start
  - known holes (substitution, base64, script contents, spaces, final-segment globs → classifier vigilance) documented in the README and frozen by regression payloads

### Changed

- Footer status colors: `auto mode on` renders in success green, `auto mode off` in warning yellow (was accent/dim) — an ungated session stays visible at a glance instead of fading into the dim channel. Semantic theme colors adapt to light/dark themes; the `/automode` notifications are unchanged

## [0.4.1] - 2026-08-31

### Changed

- 定位语统一为「极简权限门禁」——README 双语标语、AGENTS.md 与 npm `description` 同步(随本发布生效于 npm registry 与 pi.dev 包目录);「几百行极简代码」要点在特性列表置顶;用户规则小节标题改用完整路径 `~/.pi/agent/config/pi-verdict.json`;「为什么没有内置白名单」段首加粗。纯文档与包元数据表述优化,无代码变更

## [0.4.0] - 2026-08-31

### Added

- 主开关 toggle 快捷键(#15):默认 `ctrl+shift+a` 一键切换 Auto Mode 开/关,静默反馈(footer 始终显示为唯一确认,不弹通知)。`config/pi-verdict.json` 新增 `toggleShortcut` 字段——任意 pi 键组合可重绑,`null`/空串禁用,非法组合会话启动时一次性警告并跳过注册(对齐 `classifierModel` 的降级模式),新会话生效。与 `/automode on|off` 语义等价:运行中生效、无确认弹窗、不持久化写回(扩展运行时从不写自己的受保护配置,ADR-0001「仅用户手编」边界不变);`/automode` 状态输出 Usage 行同步显示当前键位

## [0.3.1] - 2026-08-29

### Changed

- 文档(en/zh README、本文件 0.2.0 条目):移除「第三方安全审计」表述,统一为事实性描述——规则层绕过测试 8 项发现、每项可复现载荷、0.2.0 架构性移除内置白名单

## [0.3.0] - 2026-08-27

### Added

- 自保护层(self-protection layer,ADR-0001):门禁自身文件不可被 agent 侧修改——`config/pi-verdict.json` + 扩展安装副本(运行时 `import.meta.url` 自锚定,覆盖单文件/npm 目录两种安装形态,dev checkout 除外)。write/edit 走 realpath 归一化精确比对(防 symlink 旁路);bash/powershell 命令串覆盖字面量/`~`/`$HOME`/`$PI_CODING_AGENT_DIR` 拼写;读放行;不可经任何配置豁免(`builtinDenyFloor: false` 关不掉,用户 allow 越不过)。`~/.pi/agent/` 全域(mcp.json、skills 等)显式不在保护范围——需要该层保护的用户应经用户规则 deny 正则自表达(ADR-0001 否决项)
- 变更检测(ADR-0001):受保护文件 `session_start` 全文快照,每次裁决前复核,处置按文件差分——扩展副本被改或无 UI → 从内存快照自动还原 + 本会话 fail-closed;交互会话中仅配置文件被改 → `ctx.ui.select` 双选处置,选项文案即动作(Accept = 重建基线会话照常,Decline = 回滚 + fail-closed;关闭对话框取安全侧同 Decline);会话间隙合法手工编辑照旧新会话生效

### Changed

- `builtinDenyFloor: false` 语义收窄:只关闭内置危险正则与路径敏感度拦截,不再能间接关闭自保护层;配置模板 `_hint` 同步说明
- README(en/zh):管线图新增第 0 层;新增「自保护」小节;限制清单补充 bash 子串正则可被混淆、跨会话基线为二期、dev checkout 不受保护的诚实声明;测试计数 42 → 62
- 文档清理:移除根部过时研究笔记(research-pi-auto-mode.md、research.md)
## [0.2.4] - 2026-08-27

### Changed

- package.json `description` 对齐 README 一句话定位(pi.dev catalog 列表页与 npm 搜索结果显示该字段,旧值为高密度技术罗列)
- 文档清理:移除 research/pi-observational-memory.md,README(en/zh)微调

## [0.2.3] - 2026-08-27

### Changed

- 运行时 UI 提示统一英文化:bash 危险规则 reason、路径敏感度 reason、用户规则 reason、分类器失败诊断、影子缓存摘要/标注、notify/confirm 文案、配置模板 `_hint` 与 block reason 前缀;代码注释保持中文,测试断言同步(42 项全过)
- README 开头重写(en/zh):一句话定位(pi 的 Claude Code auto mode 式权限门禁)+ 机制三要点列表;新增「问题 / 为什么是三态」小节,Quick start 上移至品类对比之前;弃用非官方术语 YOLO(pi 文档无此词,问题陈述改用 pi 官方表述并附安全文档链接)

## [0.2.2] - 2026-08-27

### Changed

- package.json 元数据接入 pi 官方包目录(pi.dev/packages):keywords 新增 `pi-package`(目录收录条件,实测对比已收录/未收录包确认)与 `extension`(目录类型标签显示为 extension 而非泛化 package);新增 `pi` manifest 显式声明 `extensions/` 资源(此前依赖约定目录发现);README 安装段同步目录链接
- keywords 新增 `auto-mode`/`automode`(对齐直接对标包 @czottmann/pi-automode 的主流写法,命中 /automode 命令名与仓库名搜索;经评估不引入 claude/claudecode —— 本包为 pi 扩展而非 Claude Code 插件,误导性关键字与诚实定位相悖,且两个直接竞品均未使用)

## [0.2.1] - 2026-08-27

### Added

- 配置文件支持 `classifierModel`(provider/id):分类器模型持久配置;优先级 CLI flag > env > config > 自省;无效值回退会话模型并一次性警告(与非法正则同款「不失效」处置)
- spec 支持 pi 原生思考级别后缀 `provider/id:thinking`(对齐 pi `--model` 语法):`off`(缺省,显式关思考)/`low`/`medium`/`high`/`xhigh`/`max` 经 adaptive effort 送达,`minimal` 映射 `low`;无效后缀警告一次并忽略
- README 基于收敛分析更新定位(#14):诚实框架 + 证据库七份

## [0.2.0] - 2026-08-26

### Changed

- 规则层重构:移除内置 bash 白名单,改为**用户可配置** allow/deny 正则(`<agentDir>/config/pi-verdict.json`,黑名单优先于白名单,首启生成模板);内置危险正则 + 路径敏感度保留为 deny floor(默认开启,`builtinDenyFloor: false` 可整体关闭)
- 分类器超时 15s → 25s(本网关 CC 分类器分布 p90=19.8s,15s 会误杀约 15%,见 `research/cache-sim/`)

### Security

- 规则层绕过测试 8 项发现全部修复(`research/rule-layer-security-audit.md`):V1-V7(内置白名单结构性绕过)由架构重构**结构性消除**——无内置白名单即无短路通道;V8(S0 密钥清单遗漏)扩充 `.netrc/.npmrc/.pypirc/.envrc/.vault-token/.kube/.docker config.json/.gem credentials`;全部 8 攻击载荷进回归测试(36 桩测试)

### Added

- `research/pi-automode-convergence.md`:与 @czottmann/pi-automode 的收敛度对照——架构已收敛(10 项趋同),残余差异分级(本质:floor 可关/极简形态/方法论;可复制:三态 ask/AST 规则/防篡改);战略建议 B 独立实验场+A 上游输送(#14)
- `tests/auto-mode.test.ts`:21 个离线桩测试(规则层/分类器重试矩阵/影子缓存 observe-only/命令语义/debug 标注)——开发期冒烟三件套转正入库
- `.github/workflows/ci.yml`:push/PR 上 typecheck + test(bun)
- `.github/workflows/publish.yml`:v* tag 触发 npm 发布(OIDC trusted publishing + provenance,tag/版本一致性断言,pack 白名单检查)
- `package.json`:npm 发布就绪(去 private、main 入口、files 白名单、peerDeps 可选声明、keywords/repository)
- `research/pi-permission-landscape.md`:权限自动裁决品类竞品全景——7 项目一手调研(czottmann/pi-automode、gotgenes/pi-permission-system、cc-safety-net、r4vi/pi-auto-mode、flaxodev/pi-perms、zhushanwen/pi-permission、wangzexi/pi-auto-approve),定位结论与 README 措辞启示(#10)
- :MIT 许可证(开源准备)

- 影子缓存遥测(observe-only):灰区裁决同步回放双键 LRU(128) 的 would-be 命中率,只记录永不生效,为 #5「是否引入生效缓存」积累实测数据;`/automode` 附带会话统计(命中率/miss 构成/命令重复/反事实分歧),`PI_AUTO_MODE_DEBUG=1` 时通知附 would-hit/miss 标注(#7)
- `--auto-mode-debug` CLI flag:开启全量裁决通知与影子缓存标注,等价并优先于 `PI_AUTO_MODE_DEBUG=1`(pi 配置文件无通用 env 注入机制,flag 为原生开关)

### Fixed

- 分类器灰区系统性 fail-closed(GLM 系思考模型):扩展在 API 层 `complete()` 上传的 `reasoning` 选项并非该层字段(`SimpleStreamOptions` 才有;宽类型 `Model<Api>` 的索引签名使 TS 静默放行,运行时被丢弃)→ 请求不带思考参数 → GLM 按默认 max 档思考烧尽预算/超时。改传 API 原生 `thinkingEnabled: false`(anthropic-messages 栈实测送达 `thinking:{"type":"disabled"}`,GLM 降为 effort low 轻思考+ 两档防御重试(512 → 1024,覆盖空输出/截断/超时/异常与其他 API 长尾)。根因与三层取证:`research/thinking-param-blackhole.md`

### Changed

- README 重写面向 public:英文主文档 + 对等中文 README.zh-CN.md(头部互链);一句话定位(三态裁决)、品类对比轻量表、证据驱动章节(五份研究)、免责声明(非沙箱)、命名说明

- statusline 状态文案明确化:off 态由隐藏改为暗色恒显,双态显示 `auto mode on`(高亮)/ `auto mode off`(暗色)

- `/automode` 命令语义明确化:裸调用改为**只读状态展示**(修复查看即翻转状态的副作用);`/automode on|off` 幂等设定(与现值相同不翻转);未知参数严格拒绝并列出用法,大小写归一化

- `extensions/auto-mode.ts`:Auto Mode 扩展原型 —— 在 `tool_call` 钩子上实现「规则层前置 + 模型分类器兜灰区」的三态裁决(allow / ask / deny)(#3)
  - 规则层:bash 无条件/条件白名单 + 危险正则(对完整命令串匹配)+ 文件路径敏感度六级(S0 密钥 ~ S5 CWD 外)
  - 模型分类器:Claude Code 风格 `<transcript>` 精简转录 + `<verdict>` 前缀输出契约;默认"自省"(继承当前会话模型),可用 `--auto-mode-model` / `PI_AUTO_MODE_MODEL` 指定
  - fail-closed:分类器异常/超时(15s)/输出违反契约 → 拦截;非交互模式 ask → 拦截
  - 透明性:`/automode` 开关命令、footer `🛡️ auto` 状态、拦截通知含裁决理由、`PI_AUTO_MODE_DEBUG=1` 全量裁决通知
- `research/claude-code-classifier-prompts.md`:从 Langfuse 还原 Claude Code 权限分类器提示词(数百条样本/24h)(#4)
- `research/cache-sim/`:裁决缓存收益离线回放——CC 分类器历史裁决(1,2xx 条/2x 会话)双键 LRU 回放,命中率 3.2%、危险分歧 0 例;#5 决议依据与可复现脚本(fetch-io / simulate / kinds)
- `research/rule-engine-sim/`:规则引擎收益测量——746 条真实 bash 调用双引擎交叉回放(tree-sitter AST × 本层),移植收益实测为零、真安全洞为零,真靶点=白名单广度与分类器成本(#6)
- `research/pi-model-call-and-ref-implementations.md`:Pi 扩展模型调用/配置 API 调研与三个开源权限扩展实现提取,含规则层种子集(#2)
- `CONTEXT.md`:领域术语表(Auto Mode / 裁决 / 规则层 / 灰区 / 分类器 / 自省 / fail-closed / 三态裁决 / ask 降级)
- `package.json` + `tsconfig.json`:扩展类型检查(`bun run typecheck`)
