/**
 * 裁决缓存收益模拟:用 CC 分类器历史裁决(1,2xx 条)离线回放双键 LRU 缓存。
 * 键设计对齐 #5 ticket 定案:
 *   commandKey = 待审动作条目原文(transcript 最后一个条目 part)
 *   contextKey = hash(最近 5 条 User 条目)
 *   只缓存可解析出 <block>yes/no 的"真实模型裁决"(失败输出不入缓存,对齐 fail-closed 不入缓存)
 */
const ndjson = (await Bun.file("classifier-io.ndjson").text()).trim().split("\n");
const candMeta = new Map(JSON.parse(await Bun.file("cand-ids.json").text()).map((c) => [c.id, c]));

function parseObs(o) {
  let inp = o.input;
  if (typeof inp === "string") { try { inp = JSON.parse(inp); } catch { return null; } }
  if (!Array.isArray(inp)) return null;
  // 找包含 <transcript> 的消息
  for (const m of inp) {
    const parts = Array.isArray(m?.content) ? m.content.filter((p) => p.type === "text").map((p) => p.text ?? "") : null;
    if (!parts) continue;
    const iOpen = parts.findIndex((t) => t.trim() === "<transcript>");
    if (iOpen === -1) continue;
    const iClose = parts.findIndex((t) => t.trim() === "</transcript>");
    if (iClose === -1 || iClose <= iOpen) continue;
    const entries = parts.slice(iOpen + 1, iClose).map((t) => t.replace(/\n$/, ""));
    if (entries.length === 0) continue;
    return { action: entries[entries.length - 1], users: entries.filter((e) => e.startsWith("User: ")) };
  }
  return null;
}

function verdictOf(o) {
  let out = o.output;
  if (typeof out === "string") { try { out = JSON.parse(out); } catch { /* 自由文本 */ } }
  let text = "";
  if (typeof out === "string") text = out;
  else if (out?.content) text = typeof out.content === "string" ? out.content : String(out.content);
  else if (Array.isArray(out)) text = out.map((b) => b?.text ?? "").join("");
  const m = text.match(/^\s*<block>\s*(yes|no)/i);
  return m ? (m[1].toLowerCase() === "yes" ? "deny" : "allow") : null; // CC stage1: yes=拦截 deny, no=放行 allow
}

function hash(s) { let h = 0; for (let i = 0; i < s.length; i++) { h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0; } return "" + h; }

// 按会话分组回放
const bySession = new Map();
for (const line of ndjson) {
  const o = JSON.parse(line);
  const meta = candMeta.get(o.id);
  const sid = meta?.sessionId ?? "_unknown";
  if (!bySession.has(sid)) bySession.set(sid, []);
  bySession.get(sid).push(o);
}

const stats = { total: 0, parsed: 0, verdictNull: 0, hits: 0, missNoEntry: 0, missCtx: 0, cmdOnlyHit: 0 };
const hitVerdicts = { allow: 0, deny: 0 };
const consistency = { agree: 0, cachedAllowActualDeny: 0, cachedDenyActualAllow: 0 };
let savedLatencyMs = 0, savedInputTokens = 0, savedOutputTokens = 0;
const repeatGaps = []; // 命中时的 insert→hit 间隔 ms
const topRepeated = new Map(); // commandKey → hit 次数(采样展示用)
const sessionRows = [];

for (const [sid, obs] of bySession) {
  obs.sort((a, b) => (a.startTime < b.startTime ? -1 : 1));
  const lru = new Map(); // commandKey → { ctx, verdict, t }
  const firstSeen = new Map(); // commandKey → time(命令键上界用)
  const cmdOnlySeen = new Set();
  let sTotal = 0, sHits = 0, sSavedTok = 0;
  for (const o of obs) {
    stats.total++;
    const p = parseObs(o);
    if (!p) continue;
    stats.parsed++;
    const meta = candMeta.get(o.id);
    const t = new Date(o.startTime).getTime();
    const latency = new Date(o.endTime).getTime() - t;
    const inTok = meta?.usage?.input ?? meta?.usage?.inputTokens ?? 0;
    const outTok = meta?.usage?.output ?? meta?.usage?.outputTokens ?? 0;
    const cmdKey = p.action;
    const ctxKey = hash(p.users.slice(-5).join("\0"));
    // 命令键上界(不考虑 context 变化)
    if (cmdOnlySeen.has(cmdKey)) stats.cmdOnlyHit++;
    else cmdOnlySeen.add(cmdKey);
    const v = verdictOf(o);
    if (v === null) { stats.verdictNull++; continue; } // 失败输出:不入缓存也不查缓存? —— 查缓存照常(生产上失败也先查),这里简化:继续查
    // LRU 查询
    const e = lru.get(cmdKey);
    if (!e) {
      stats.missNoEntry++;
      lru.set(cmdKey, { ctx: ctxKey, verdict: v, t });
      if (lru.size > 128) lru.delete(lru.keys().next().value);
    } else if (e.ctx !== ctxKey) {
      stats.missCtx++;
      lru.delete(cmdKey); lru.set(cmdKey, { ctx: ctxKey, verdict: v, t }); // 覆写为最新上下文
    } else {
      stats.hits++; sHits++;
      hitVerdicts[e.verdict]++;
      // 反事实一致性:缓存裁决 vs 本次实际裁决
      if (e.verdict === v) consistency.agree++;
      else if (e.verdict === "allow" && v === "deny") consistency.cachedAllowActualDeny++;
      else consistency.cachedDenyActualAllow++;
      repeatGaps.push(t - e.t);
      savedLatencyMs += latency; savedInputTokens += inTok; savedOutputTokens += outTok; sSavedTok += inTok;
      const k = cmdKey.slice(0, 70); topRepeated.set(k, (topRepeated.get(k) ?? 0) + 1);
      // LRU refresh
      lru.delete(cmdKey); lru.set(cmdKey, { ctx: ctxKey, verdict: v, t: e.t });
    }
    sTotal++;
  }
  sessionRows.push({ sid, total: sTotal, hits: sHits, inTok: sSavedTok });
}

const pct = (n, d) => (d ? (100 * n / d).toFixed(1) + "%" : "-");
repeatGaps.sort((a, b) => a - b);
const q = (p) => repeatGaps.length ? repeatGaps[Math.min(repeatGaps.length - 1, Math.floor(p * repeatGaps.length))] : 0;

console.log("=== 总量 ===");
console.log(`观测总数 ${stats.total},可解析 ${stats.parsed},无/失败输出(不入缓存) ${stats.verdictNull},会话数 ${bySession.size}`);
console.log("\n=== 双键缓存命中率 ===");
console.log(`命中 ${stats.hits} / 可解析 ${stats.parsed} = ${pct(stats.hits, stats.parsed)}`);
console.log(`miss: no-entry ${stats.missNoEntry}, context-changed ${stats.missCtx}`);
console.log(`命令键上界(忽略 context): ${stats.cmdOnlyHit} = ${pct(stats.cmdOnlyHit, stats.parsed)}`);
console.log("\n=== 命中时缓存裁决分布 ===");
console.log(`replay allow ${hitVerdicts.allow}, replay deny ${hitVerdicts.deny}`);
console.log("\n=== 反事实一致性(命中时 缓存裁决 vs 实际裁决) ===");
console.log(`一致 ${consistency.agree}, 危险分歧(缓存allow/实际deny) ${consistency.cachedAllowActualDeny}, 保守分歧(缓存deny/实际allow) ${consistency.cachedDenyActualAllow}`);
console.log("\n=== 节省估算(命中跳过的调用) ===");
console.log(`延迟合计 ${(savedLatencyMs / 1000).toFixed(1)}s, 输入 token ${savedInputTokens.toLocaleString()}, 输出 token ${savedOutputTokens.toLocaleString()}`);
console.log(`insert→命中 间隔: p50=${(q(0.5)/1000).toFixed(1)}s p90=${(q(0.9)/1000).toFixed(1)}s max=${(repeatGaps[repeatGaps.length-1]/1000||0).toFixed(1)}s`);
console.log("\n=== 高频重复动作 top10 ===");
for (const [k, c] of [...topRepeated.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log(`  ×${c}  ${k.replace(/\n/g, "⏎")}`);
console.log("\n=== 每会话命中 ===");
for (const r of sessionRows.sort((a, b) => b.hits - a.hits).slice(0, 10)) console.log(`  ${r.sid.slice(0, 14)} 裁决 ${r.total}, 命中 ${r.hits} (${pct(r.hits, r.total)}), 省输入tok ${r.inTok.toLocaleString()}`);
