/** 按 id 并行拉取分类器观测的 io 字段,落盘 NDJSON */
const cands = JSON.parse(await Bun.file("cand-ids.json").text());
const auth = "Basic " + btoa(`${process.env.LANGFUSE_PUBLIC_KEY}:${process.env.LANGFUSE_SECRET_KEY}`);
const base = process.env.LANGFUSE_BASE_URL;

const out = await Bun.file("classifier-io.ndjson").writer();
let done = 0, failed = 0;
const t0 = Date.now();

async function fetchOne(id) {
  const filter = encodeURIComponent(JSON.stringify([{ column: "id", operator: "=", value: id, type: "string" }]));
  const url = `${base}/api/public/v2/observations?type=GENERATION&limit=5&fields=core,io&filter=${filter}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { Authorization: auth }, signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      const row = body.data?.find?.((o) => o.id === id) ?? body.data?.[0];
      if (!row) throw new Error("empty data");
      await out.write(JSON.stringify({ id, sessionId: row.sessionId, traceId: row.traceId, startTime: row.startTime, endTime: row.endTime, input: row.input, output: row.output }) + "\n");
      return true;
    } catch (e) {
      if (attempt === 2) { console.error(`FAIL ${id}: ${e.message}`); return false; }
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
}

const queue = [...cands.map((c) => c.id)];
const CONCURRENCY = 10;
async function worker() {
  while (queue.length > 0) {
    const id = queue.shift();
    const ok = await fetchOne(id);
    if (!ok) failed++;
    if (++done % 100 === 0) console.log(`progress ${done}/${cands.length} (failed ${failed}) ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
await out.end();
console.log(`DONE: ${done} fetched, ${failed} failed, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
