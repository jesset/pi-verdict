const ndjson = (await Bun.file("classifier-io.ndjson").text()).trim().split("\n");
function parseAction(o) {
  let inp = o.input;
  if (typeof inp === "string") { try { inp = JSON.parse(inp); } catch { return null; } }
  for (const m of inp ?? []) {
    const parts = Array.isArray(m?.content) ? m.content.filter((p) => p.type === "text").map((p) => p.text ?? "") : null;
    if (!parts) continue;
    const io = parts.findIndex((t) => t.trim() === "<transcript>");
    if (io === -1) continue;
    const ic = parts.findIndex((t) => t.trim() === "</transcript>");
    if (ic <= io) continue;
    return parts[ic - 1].replace(/\n$/, "");
  }
  return null;
}
const kind = {};
const kindRepeat = {};
const seen = new Set();
for (const l of ndjson) {
  const o = JSON.parse(l);
  const a = parseAction(o);
  if (!a) continue;
  const first = a.split(/\s+/)[0];
  const kk = a.startsWith("mcp__") ? first : first;
  kind[kk] = (kind[kk] ?? 0) + 1;
  if (seen.has(a)) kindRepeat[kk] = (kindRepeat[kk] ?? 0) + 1;
  else seen.add(a);
}
console.log("灰区构成(按动作首词) 与 重复出现次数:");
for (const [k, v] of Object.entries(kind).sort((a, b) => b[1] - a[1]).slice(0, 14)) {
  console.log(`  ${v}\t重复 ${kindRepeat[k] ?? 0}\t${k}`);
}
const tot = Object.values(kind).reduce((a, b) => a + b, 0);
const rep = Object.values(kindRepeat).reduce((a, b) => a + b, 0);
console.log(`合计 ${tot},重复 ${rep}`);
