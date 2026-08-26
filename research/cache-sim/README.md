# 裁决缓存收益离线回放(.issue #5 决议依据)

用 Langfuse 中 Claude Code 权限分类器的历史裁决,离线回放「双键 LRU(128) 裁决缓存」的命中率与反事实一致性。**结论:双键命中率仅 3.2%,收益集中于重试/轮询循环,不支持整体显著收益的判断 → 缓存暂缓引入,改以影子缓存实测 pi 自身命中率。**

## 数据与方法

- 数据源:`https://langfuse.已脱敏内部域名`(v4),2026-08-24 → 08-26 窗口,`type=GENERATION` + `max_tokens=64` 特征筛出 CC stage-1 分类器调用 **1,2xx 条 / 2x 会话**(元数据 数百MB 拉取 + 按 id 并行拉 io,零失败)
- 关键结构发现:CC 分类器输入的 transcript 是**追加式 text parts**(每 part 恰好一个条目),待审动作 = `</transcript>` 前最后一个 part,user 消息 = `User: ` 开头的 part —— 条目边界精确,无需启发式切分
- 键设计(对齐 #5 定案):`commandKey` = 待审动作 part 原文;`contextKey` = hash(最近 5 条 User 条目);LRU 128 按会话回放;失败输出(`<block>` 不可解析,47 条)不入缓存(对齐 fail-closed 不入缓存)
- 一致性反事实:历史数据中每次调用都真实发生了,命中时可对比「缓存裁决 vs 实际产出裁决」

## 脚本

- `fetch-io.ts` — 按 id 并发 10 拉取观测 io,落 NDJSON(凭证走 `LANGFUSE_*` 环境变量)
- `simulate.ts` — 双键 LRU 会话级回放:命中率/miss 构成/一致性/节省估算/高频重复动作
- `kinds.ts` — 灰区构成按工具族拆分(MCP vs Bash 的重复率差异)

复现:`npx langfuse-cli api observations list --type GENERATION --from-start-time <t> --fields core,basic,model,usage --limit 500 --all --json` → 过滤 `max_tokens==64` 得 `cand-ids.json` → `bun fetch-io.ts` → `bun simulate.ts`

## 结果(2026-08-26 回放)

| 指标 | 数值 |
|---|---|
| 双键命中率 | **41/1265 = 3.2%** |
| 命令键上界(忽略 context) | 8.2%(contextHash 砍掉 45% 命令级重复) |
| miss 构成 | no-entry 1144(90%)/ context-changed 33 |
| 命中时一致性 | 39/41 一致;**危险分歧(缓存 allow/实际 deny)0**;保守分歧 2 |
| 命中重放分布 | allow 39 / deny 2 |
| 节省(CC 侧口径) | 606s 延迟 + 40K input tokens / 2 天 |

结构性分布:

- 收益集中:**重试/轮询循环**——`Bash sleep 115; cat …` 轮询 ×18(单会话命中率 38%,贡献 44% 全部命中);MCP 验证循环(`browser_snapshot` 23 次 14 重复、`browser_navigate` 15 次 10 重复)
- 按工具族:MCP 调用重复率 ~29%(38/130),Bash 仅 6%(CC 灰区 84% 是一次性 bash)
- 会话级:多数 <3%,最大会话(202 次裁决)0%

对 pi 的外推(偏保守):pi 原型 bash 白名单更厚、**所有 MCP/自定义工具进灰区**,灰区构成更偏高重复的 MCP 类 → pi 实际命中率预期高于 3.2%,需影子缓存实测。

## 附:ai-guard 语义核实(源码 `pi-permission-ai-guard@0.7.0`)

- 「可恢复档」是节流阀:连续 3 deny 仅短路**下一次**调用后清零计数;真保险丝是会话累计 20 deny 硬顶(永不复位)
- 熔断检查在缓存查询**之前**;`contextHash` = sanitized user 消息流哈希(不含工具调用流)——双键设计依据
