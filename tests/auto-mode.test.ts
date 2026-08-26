/**
 * pi-verdict 扩展桩测试:规则层 / 分类器重试 / 影子缓存 / 命令语义
 * 全部离线:mock ExtensionAPI/ExtensionContext,无网络、无真实模型。
 * 改编自开发期三份冒烟脚本(shadow/retry/command),语义与线上行为一致。
 */
import { describe, test, expect } from "bun:test";
import autoMode from "../extensions/auto-mode.ts";

// ── 桩设施 ──────────────────────────────────────────────

interface Harness {
	handlers: Record<string, any>;
	commands: Record<string, any>;
	notifies: Array<[string, string]>;
	branch: any[];
	ctx: any;
	install: (opts?: { flag?: boolean; debug?: boolean }) => void;
}

function makeHarness(): Harness {
	const handlers: Record<string, any> = {};
	const commands: Record<string, any> = {};
	const notifies: Array<[string, string]> = [];
	let flags: Record<string, unknown> = {};
	let envDebug = false;
	const branch: any[] = [];

	const ctx: any = {
		cwd: "/proj", hasUI: true, signal: undefined, model: { id: "mock/glm" },
		sessionManager: { getBranch: () => branch, getSessionId: () => "s1" },
		modelRegistry: {
			complete: async (_m: any, _req: any, opts: any) => {
				(h as any).calls.push({ maxTokens: opts.maxTokens, thinkingEnabled: opts.thinkingEnabled, reasoning: opts.reasoning });
				const r = (h as any).responses[Math.min((h as any).calls.length - 1, (h as any).responses.length - 1)];
				if (r instanceof Error) throw r;
				return { content: [{ type: "text", text: r.text }], stopReason: r.stopReason ?? "stop" };
			},
			find: () => null, hasConfiguredAuth: () => false,
		},
		ui: {
			notify: (msg: string, level: string) => notifies.push([msg, level]),
			confirm: async () => { (h as any).confirms++; return (h as any).confirmAnswer; },
			setStatus: () => {}, theme: { fg: (_c: string, s: string) => s },
		},
	};

	const h: any = { handlers, commands, notifies, branch, ctx, calls: [], responses: [], confirms: 0, confirmAnswer: true };
	h.install = (opts?: { flag?: boolean; debug?: boolean }) => {
		flags = { "auto-mode": opts?.flag ?? true, "auto-mode-debug": opts?.debug ?? false };
		envDebug = !!opts?.debug;
		const prev = process.env.PI_AUTO_MODE_DEBUG;
		if (envDebug) process.env.PI_AUTO_MODE_DEBUG = "1"; else delete process.env.PI_AUTO_MODE_DEBUG;
		autoMode({
			registerFlag: (n: string, d: any) => { if (!(n in flags)) flags[n] = d.default; },
			getFlag: (n: string) => flags[n],
			on: (e: string, fn: any) => { handlers[e] = fn; },
			registerCommand: (n: string, c: any) => { commands[n] = c; },
		} as any);
		if (prev !== undefined) process.env.PI_AUTO_MODE_DEBUG = prev; else delete process.env.PI_AUTO_MODE_DEBUG;
	};
	return h as Harness;
}

const userMsg = (h: Harness, t: string) => h.branch.push({ type: "message", message: { role: "user", content: t } });
const toolCall = (h: Harness, toolName: string, input: any) => h.handlers.tool_call({ toolName, input }, h.ctx);

// ── 1. 规则层(确定性,零模型调用) ──────────────────────

describe("rule layer", () => {
	test("whitelisted read-only bash → allow, no model call", async () => {
		const h = makeHarness(); h.install();
		await toolCall(h, "bash", { command: "ls -la /proj" });
		expect(h.calls.length).toBe(0);
	});
	test("conditional git subcommand → allow", async () => {
		const h = makeHarness(); h.install();
		await toolCall(h, "bash", { command: "git status && git log --oneline -3" });
		expect(h.calls.length).toBe(0);
	});
	test("danger regex (rm -rf) → deny with reason", async () => {
		const h = makeHarness(); h.install();
		const r = await toolCall(h, "bash", { command: "rm -rf /tmp/anything" });
		expect(r?.block).toBe(true);
		expect(r.reason).toContain("rm-recursive");
		expect(h.calls.length).toBe(0);
	});
	test("write to secret path (S0) → deny", async () => {
		const h = makeHarness(); h.install();
		const r = await toolCall(h, "write", { path: "~/.ssh/authorized_keys", content: "x" });
		expect(r?.block).toBe(true);
	});
	test("write inside CWD → allow", async () => {
		const h = makeHarness(); h.install();
		const r = await toolCall(h, "write", { path: "/proj/src/a.ts", content: "x" });
		expect(r).toBeUndefined();
	});
});

// ── 2. 分类器(重试矩阵 + 参数形态) ─────────────────────

describe("classifier", () => {
	test("success on first try: single call, thinkingEnabled=false, maxTokens=512", async () => {
		const h = makeHarness(); h.install();
		h.responses = [{ text: "<verdict>allow</verdict> fine" }];
		const r = await toolCall(h, "bash", { command: "cargo build" });
		expect(r).toBeUndefined();
		expect(h.calls.length).toBe(1);
		expect(h.calls[0]).toEqual({ maxTokens: 512, thinkingEnabled: false, reasoning: undefined });
	});
	test("empty output (stopReason=length) → retry at 1024, verdict honored", async () => {
		const h = makeHarness(); h.install();
		h.responses = [{ text: "", stopReason: "length" }, { text: "<verdict>deny</verdict> bad" }];
		const r = await toolCall(h, "bash", { command: "cargo build" });
		expect(h.calls.map((c: any) => c.maxTokens)).toEqual([512, 1024]);
		expect(r?.block).toBe(true);
	});
	test("truncated output → retry", async () => {
		const h = makeHarness(); h.install();
		h.responses = [{ text: "<verdict>allow", stopReason: "length" }, { text: "<verdict>allow</verdict> ok" }];
		const r = await toolCall(h, "bash", { command: "cargo build" });
		expect(h.calls.length).toBe(2);
		expect(r).toBeUndefined();
	});
	test("both attempts fail → fail-closed deny with per-attempt diagnostics", async () => {
		const h = makeHarness(); h.install();
		h.responses = [{ text: "", stopReason: "length" }, new Error("gateway boom")];
		const r = await toolCall(h, "bash", { command: "cargo build" });
		expect(r?.block).toBe(true);
		expect(r.reason).toContain("第1次(512t)");
		expect(r.reason).toContain("第2次(1024t)");
	});
	test("ask + interactive confirm → allow; headless → deny", async () => {
		const h = makeHarness(); h.install();
		h.responses = [{ text: "<verdict>ask</verdict> risky" }];
		const r = await toolCall(h, "mcp__x__y", { a: 1 });
		expect(r).toBeUndefined();
		expect(h.confirms).toBe(1);

		const h2 = makeHarness(); h2.install();
		h2.ctx.hasUI = false;
		h2.responses = [{ text: "<verdict>ask</verdict> risky" }];
		const r2 = await toolCall(h2, "mcp__x__y", { a: 1 });
		expect(r2?.block).toBe(true);
	});
});

// ── 3. 影子缓存(observe-only:行为零变化 + 统计正确) ────

function shadowStats(h: Harness): Record<string, number> {
	h.notifies.length = 0;
	h.commands.automode.handler("", h.ctx); // 裸调用 = 只读状态
	const line = h.notifies[0]?.[0].split("\n")[1] ?? "";
	const out: Record<string, number> = { gray: 0, hits: 0, rate: 0, missNoEntry: 0, missCtx: 0, cmdRepeats: 0, dangerous: 0, conservative: 0 };
	const m = line.match(/灰区 (\d+).*命中 (\d+) \(([\d.]+)%\).*无条目 (\d+)\/上下文变 (\d+).*命令重复 (\d+).*危险 (\d+)\/保守 (\d+)/);
	if (m) [out.gray, out.hits, out.rate, out.missNoEntry, out.missCtx, out.cmdRepeats, out.dangerous, out.conservative] =
		[+m[1], +m[2], +m[3], +m[4], +m[5], +m[6], +m[7], +m[8]];
	return out;
}

describe("shadow cache (observe-only)", () => {
	test("rule verdicts never enter the shadow stats", async () => {
		const h = makeHarness(); h.install();
		await toolCall(h, "bash", { command: "ls" });
		expect(shadowStats(h).gray).toBe(0);
	});
	test("repeat gray call: would-hit counted, model still called (never short-circuits)", async () => {
		const h = makeHarness(); h.install(); userMsg(h, "任务");
		h.responses = [{ text: "<verdict>allow</verdict> ok" }];
		const r1 = await toolCall(h, "bash", { command: "cargo build" });
		const r2 = await toolCall(h, "bash", { command: "cargo build" });
		const s = shadowStats(h);
		expect(s.gray).toBe(2);
		expect(s.hits).toBe(1);
		expect(h.calls.length).toBe(2); // observe-only:模型两次都真实调用
		expect(r1).toBeUndefined(); // 行为零变化:两次都放行
		expect(r2).toBeUndefined();
	});
	test("new user message → context-changed miss and overwrite", async () => {
		const h = makeHarness(); h.install(); userMsg(h, "任务");
		h.responses = [{ text: "<verdict>allow</verdict> ok" }];
		await toolCall(h, "bash", { command: "cargo build" });
		userMsg(h, "新指令");
		await toolCall(h, "bash", { command: "cargo build" });
		expect(shadowStats(h).missCtx).toBe(1);
	});
	test("ask and fail-closed never enter the cache", async () => {
		const h = makeHarness(); h.install();
		h.responses = [{ text: "<verdict>ask</verdict> risky" }];
		await toolCall(h, "mcp__x__y", { a: 1 });
		await toolCall(h, "mcp__x__y", { a: 1 });
		expect(shadowStats(h).missNoEntry).toBe(2);
	});
	test("divergence counter: cached allow vs model deny on hit", async () => {
		const h = makeHarness(); h.install(); userMsg(h, "任务");
		h.responses = [{ text: "<verdict>allow</verdict> ok" }];
		await toolCall(h, "bash", { command: "cargo build" });
		h.responses = [{ text: "<verdict>deny</verdict> bad" }];
		const r2 = await toolCall(h, "bash", { command: "cargo build" });
		expect(r2?.block).toBe(true); // observe-only:行为仍是模型裁决(拦截)
		expect(shadowStats(h).dangerous).toBe(1);
	});
	test("LRU(128) evicts the oldest entry", async () => {
		const h = makeHarness(); h.install(); userMsg(h, "任务");
		h.responses = [{ text: "<verdict>allow</verdict> ok" }];
		for (let i = 0; i < 129; i++) await toolCall(h, "mcp__e__t", { i });
		await toolCall(h, "mcp__e__t", { i: 0 });   // evicted → no-entry
		await toolCall(h, "mcp__e__t", { i: 128 }); // recent → hit
		const s = shadowStats(h);
		expect(s.missNoEntry).toBeGreaterThanOrEqual(130);
		expect(s.hits).toBe(1);
	});
});

// ── 4. /automode 命令语义(显式 on/off + 只读状态) ───────

describe("/automode command", () => {
	test("bare call is read-only status with stats and usage", async () => {
		const h = makeHarness(); h.install();
		h.commands.automode.handler("", h.ctx);
		expect(h.notifies[0][0]).toContain("开启");
		expect(h.notifies[0][0]).toContain("影子缓存");
		expect(h.notifies[0][0]).toContain("用法");
	});
	test("on/off are idempotent, annotated (未变化) when same", async () => {
		const h = makeHarness(); h.install();
		await h.commands.automode.handler("on", h.ctx);
		expect(h.notifies.at(-1)![0]).toContain("已开启(未变化)");
		await h.commands.automode.handler("off", h.ctx);
		expect(h.notifies.at(-1)![0]).toContain("已关闭");
		await h.commands.automode.handler("OFF", h.ctx);
		expect(h.notifies.at(-1)![0]).toContain("已关闭(未变化)"); // 大小写归一化
	});
	test("off actually disables gating", async () => {
		const h = makeHarness(); h.install();
		await h.commands.automode.handler("off", h.ctx);
		const r = await toolCall(h, "bash", { command: "rm -rf /tmp/x" });
		expect(r).toBeUndefined(); // 关闭后危险命令也不再拦
	});
	test("unknown arg → warning with usage", async () => {
		const h = makeHarness(); h.install();
		await h.commands.automode.handler(" of", h.ctx);
		expect(h.notifies.at(-1)![0]).toContain("未知参数");
		expect(h.notifies.at(-1)![1]).toBe("warning");
	});
});

// ── 5. debug 通知标注 ───────────────────────────────────

describe("debug annotations", () => {
	test("--auto-mode-debug: allows notify with shadow would-hit tag", async () => {
		const h = makeHarness(); h.install({ debug: true });
		h.responses = [{ text: "<verdict>allow</verdict> ok" }];
		await toolCall(h, "bash", { command: "cargo build" });
		await toolCall(h, "bash", { command: "cargo build" });
		const allowNotifies = h.notifies.filter(([m]) => m.includes("allow(分类器)"));
		expect(allowNotifies.length).toBe(2);
		expect(allowNotifies[1][0]).toContain("would-hit");
	});
});
