# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/lang/zh-CN/).

## [Unreleased]

### Added

- `research/pi-permission-landscape.md`:权限自动裁决品类竞品全景——7 项目一手调研(czottmann/pi-automode、gotgenes/pi-permission-system、cc-safety-net、r4vi/pi-auto-mode、flaxodev/pi-perms、zhushanwen/pi-permission、wangzexi/pi-auto-approve),定位结论与 README 措辞启示(#10)
- :MIT 许可证(开源准备)

- 影子缓存遥测(observe-only):灰区裁决同步回放双键 LRU(128) 的 would-be 命中率,只记录永不生效,为 #5「是否引入生效缓存」积累实测数据;`/automode` 附带会话统计(命中率/miss 构成/命令重复/反事实分歧),`PI_AUTO_MODE_DEBUG=1` 时通知附 would-hit/miss 标注(#7)
- `--auto-mode-debug` CLI flag:开启全量裁决通知与影子缓存标注,等价并优先于 `PI_AUTO_MODE_DEBUG=1`(pi 配置文件无通用 env 注入机制,flag 为原生开关)

### Fixed

- 分类器灰区系统性 fail-closed(GLM 系思考模型):扩展在 API 层 `complete()` 上传的 `reasoning` 选项并非该层字段(`SimpleStreamOptions` 才有;宽类型 `Model<Api>` 的索引签名使 TS 静默放行,运行时被丢弃)→ 请求不带思考参数 → GLM 按默认 max 档思考烧尽预算/超时。改传 API 原生 `thinkingEnabled: false`(anthropic-messages 栈实测送达 `thinking:{"type":"disabled"}`,GLM 降为 effort low 轻思考+ 两档防御重试(512 → 1024,覆盖空输出/截断/超时/异常与其他 API 长尾)。根因与三层取证:`research/thinking-param-blackhole.md`

### Changed

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
