# 规则引擎收益测量:tree-sitter AST 移植 vs 白名单广度(.issue #6 决议依据)

用近 3 天全部真实会话的 bash 工具调用(746 条/1027 次工具调用)交叉回放「本仓库规则层 × pi-permission@1.3.3 的 tree-sitter AST(同版本 wasm + 同款 11 节点白名单)」。**结论:移植收益实测为零且有负作用(灰区 +16%),真实安全洞为零;真靶点是白名单广度与分类器成本结构。**

## 方法

- 数据源:`~/.pi/agent/sessions` 近 3 天全部项目会话,assistant 消息中的 bash toolCall(纯函数回放,无需扩展实际在线)
- 本仓库规则层:从 `extensions/auto-mode.ts` 源码原文提取(Bun.Transpiler 剥类型后 eval),行为与线上一致
- AST 检查:web-tree-sitter@0.26.11 + tree-sitter-bash@0.25.1,复刻 pi-permission `src/ast/analyzer.ts` 的 ALLOWED_KINDS(11 节点)+ ALLOWED_PUNCT(6 标点),fail-closed 语义
- 其白名单:从其 `src/rules/builtins.ts` 源码提取(无条件 50 + 条件 9——**比本仓库的 78+9 更窄**)
- 复现:`cd ~/tmp/ast-lab && npm i web-tree-sitter@0.26.11 tree-sitter-bash@0.25.1 && bun measure.ts`(路径见脚本头)

## 结果(2026-08-26 回放)

| 指标 | 数值 |
|---|---|
| 本层吸收率(746 条 bash) | allow 140(18.8%)/ deny 19(2.6%)/ **gray 590(78.8%)** |
| 移植可吸收的灰区(AST 干净 ∧ 其白名单命中) | **0 条** |
| AST 干净但白名单未覆盖 | 148 条(上限;实际命中为零) |
| 副作用:良性放行被「不干净→送分类器」降级 | 94 条 → 灰区率 78.8% → ~91.8% |
| 重定向到敏感路径(真安全洞) | **0 条** |

94 条「放行 ∧ AST 不干净」逐类审视全为良性:`2>/dev/null` 类 67、变量前缀赋值(`P=… && cat $P/…`)25、heredoc 写项目内文件 2;command_substitution 仅 2 条且良性(`ls -la $(which pi)`)。

## 归因:为什么移植无收益

pi-permission 的架构是「AST 挑结构干净 × 窄白名单(50)」——AST 的作用是让 auto-allow 更挑剔,不是扩大吸收。本仓库流量的灰区大头是**白名单广度**(首词靶点:`head 459/echo 328/grep 291/cd 262/git 170/gh 109/python3 86/sed 67/if·for 96/bun 42`)与**复合语句**(if/for/heredoc 被 naive 切分误切,AST 只会「正确地送分类器」——与现状同去向)。两头都对不上。

## 真靶点(数据指向,未决策)

1. **白名单广度**:gh 只读子集条件化(≈109 条)、sed 引号感知(`sed -n '125,170p'` 因引号失配)、if/for/heredoc 伪段误切修正——粗估可吸收 100–200 条,灰区率 → ~65%
2. **分类器成本结构**:灰区是结构性的(78.8%),`--auto-mode-model` 指向轻量模型一次配置稀释全部成本(自省大模型 3–15s/次 + ~8K tokens vs 轻量 flash 类)
3. 「剥离规则层聚焦分类器」实测否决:负载 ×1.7(590→1027)、失去 19 次零成本 deny 与分类器瘫痪时的唯一在线刹车

## 重议信号

真实流量出现**敏感路径重定向绕过**(如 `echo x > /etc/passwd` 类:规则层放行、危险正则未命中、路径敏感度层不覆盖 bash 重定向)时重开 AST 引入讨论——理论洞存在,3 天流量未出现。
