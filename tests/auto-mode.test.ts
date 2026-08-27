/**
 * pi-verdict 扩展桩测试:内置 floor / 用户规则优先级 / 分类器重试 / 影子缓存 / 命令语义
 * 全部离线:mock ExtensionAPI/ExtensionContext,无网络、无真实模型。
 * 用户规则经 PI_CODING_AGENT_DIR 指向临时目录的真实 JSON 配置驱动(非注入 mock)。
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import autoMode, { buildProtectedSet, isProtectedWritePath } from "../extensions/auto-mode.ts";

// ── 桩设施 ──────────────────────────────────────────────

const TMP_AGENT = fs.mkdtempSync(path.join(os.tmpdir(), "pi-verdict-test-"));
let config: { allow: string[]; deny: string[] } = { allow: [], deny: [] };

interface Harness {
	handlers: Record<string, any>;
	commands: Record<string, any>;
	notifies: Array<[string, string]>;
	branch: any[];
	ctx: any;
	calls: any[];
	responses: any[];
	confirms: number;
	confirmAnswer: boolean;
	findMap: Record<string, any> | undefined;
	install: (opts?: { flag?: boolean; debug?: boolean; modelFlag?: string }) => void;
}

function makeHarness(): Harness {
	const handlers: Record<string, any> = {};
	const commands: Record<string, any> = {};
	const notifies: Array<[string, string]> = [];
	let flags: Record<string, unknown> = {};
	const branch: any[] = [];
	const h: any = { handlers, commands, notifies, branch, calls: [], responses: [], confirms: 0, confirmAnswer: true, selects: 0, selectIndex: 0, findMap: undefined };

	const ctx: any = {
		cwd: "/proj", hasUI: true, signal: undefined, model: { id: "mock/glm" },
		sessionManager: { getBranch: () => branch, getSessionId: () => "s1" },
		modelRegistry: {
			complete: async (_m: any, _req: any, opts: any) => {
				h.calls.push({ model: _m?.id, maxTokens: opts.maxTokens, thinkingEnabled: opts.thinkingEnabled, effort: opts.effort });
				const r = h.responses[Math.min(h.calls.length - 1, h.responses.length - 1)];
				if (r instanceof Error) throw r;
				return { content: [{ type: "text", text: r.text }], stopReason: r.stopReason ?? "stop" };
			},
			find: (p: string, id: string) => h.findMap?.[`${p}/${id}`] ?? null,
			hasConfiguredAuth: () => true,
		},
		ui: {
			notify: (msg: string, level: string) => notifies.push([msg, level]),
			confirm: async () => { h.confirms++; return h.confirmAnswer; },
			select: async (_t: string, options: string[]) => { h.selects++; return h.selectIndex === null ? undefined : options[h.selectIndex]; },
			setStatus: () => {}, theme: { fg: (_c: string, s: string) => s },
		},
	};
	h.ctx = ctx;

	h.install = (opts?: { flag?: boolean; debug?: boolean; modelFlag?: string }) => {
		flags = { "auto-mode": opts?.flag ?? true, "auto-mode-debug": opts?.debug ?? false, ...(opts?.modelFlag ? { "auto-mode-model": opts.modelFlag } : {}) };
		const prev = process.env.PI_AUTO_MODE_DEBUG;
		if (opts?.debug) process.env.PI_AUTO_MODE_DEBUG = "1"; else delete process.env.PI_AUTO_MODE_DEBUG;
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

beforeAll(() => { process.env.PI_CODING_AGENT_DIR = TMP_AGENT; });
afterAll(() => { delete process.env.PI_CODING_AGENT_DIR; });

function setConfig(cfg: { allow?: string[]; deny?: string[]; builtinDenyFloor?: boolean; classifierModel?: string | null }, invalid?: string[]): void {
	config = { allow: cfg.allow ?? [], deny: cfg.deny ?? [] };
	const p = path.join(TMP_AGENT, "config", "pi-verdict.json");
	fs.mkdirSync(path.dirname(p), { recursive: true });
	const raw: Record<string, unknown> = { ...config };
	if (cfg.classifierModel !== undefined) raw.classifierModel = cfg.classifierModel;
	if (cfg.builtinDenyFloor !== undefined) raw.builtinDenyFloor = cfg.builtinDenyFloor;
	// 非法正则测试:把 invalid 条目直接混入 allow 数组
	if (invalid) raw.allow = [...config.allow, ...invalid];
	fs.writeFileSync(p, JSON.stringify(raw));
}

const userMsg = (h: Harness, t: string) => h.branch.push({ type: "message", message: { role: "user", content: t } });
const toolCall = (h: Harness, toolName: string, input: any) => h.handlers.tool_call({ toolName, input }, h.ctx);

// ── 1. 内置 deny floor(不可覆盖)+ 无内置白名单 ─────────

describe("built-in deny floor", () => {
	test("danger regex (rm -rf) → deny, zero model calls", async () => {
		setConfig({});
		const h = makeHarness(); h.install();
		const r = await toolCall(h, "bash", { command: "rm " + "-rf /tmp/x" }); // 拼接防测试文件被危险正则误拦
		expect(r?.block).toBe(true);
		expect(r.reason).toContain("rm-recursive");
		expect(h.calls.length).toBe(0);
	});
	test("floor NOT overridable by user allow", async () => {
		setConfig({ allow: ["^rm"] });
		const h = makeHarness(); h.install();
		const r = await toolCall(h, "bash", { command: "rm " + "-rf /tmp/x" });
		expect(r?.block).toBe(true);
		expect(h.calls.length).toBe(0);
	});
	test("no built-in whitelist: ls → gray → classifier", async () => {
		setConfig({});
		const h = makeHarness(); h.install();
		h.responses = [{ text: "<verdict>allow</verdict> ok" }];
		const r = await toolCall(h, "bash", { command: "ls -la" });
		expect(r).toBeUndefined();
		expect(h.calls.length).toBe(1); // 无白名单:进分类器
	});
	test("write to S0 secret path → deny", async () => {
		setConfig({});
		const h = makeHarness(); h.install();
		const r = await toolCall(h, "write", { path: "~/.ssh/authorized_keys", content: "x" });
		expect(r?.block).toBe(true);
	});
	test("write inside CWD → rule allow, zero model calls", async () => {
		setConfig({});
		const h = makeHarness(); h.install();
		const r = await toolCall(h, "write", { path: "/proj/src/a.ts", content: "x" });
		expect(r).toBeUndefined();
		expect(h.calls.length).toBe(0);
	});
});

// ── 2. 用户规则(黑名单优先于白名单) ─────────────────────

describe("user rules (deny > allow > gray)", () => {
	test("user allow matches full command string → zero-latency allow", async () => {
		setConfig({ allow: ["^ls\\b", "^git (status|log|diff)\\b"] });
		const h = makeHarness(); h.install();
		const r = await toolCall(h, "bash", { command: "git status && git log --oneline -3" });
		expect(r).toBeUndefined();
		expect(h.calls.length).toBe(0);
	});
	test("user deny beats user allow", async () => {
		setConfig({ allow: ["^git"], deny: ["push"] });
		const h = makeHarness(); h.install();
		const r = await toolCall(h, "bash", { command: "git push origin main" });
		expect(r?.block).toBe(true);
		expect(r.reason).toContain("user deny rule");
	});
	test("user deny beats path-based rule allow (directory semantics)", async () => {
		setConfig({ deny: ["^/proj/"] });
		const h = makeHarness(); h.install();
		const r = await toolCall(h, "write", { path: "/proj/a.ts", content: "x" });
		expect(r?.block).toBe(true);
	});
	test("user rules do not apply to uncovered tools (MCP stays gray)", async () => {
		setConfig({ allow: [".*"] });
		const h = makeHarness(); h.install();
		h.responses = [{ text: "<verdict>allow</verdict> ok" }];
		const r = await toolCall(h, "mcp__x__y", { a: 1 });
		expect(r).toBeUndefined();
		expect(h.calls.length).toBe(1);
	});
	test("invalid regexes are skipped, valid ones still apply", async () => {
		setConfig({ allow: ["^ls\\b"] }, ["[unclosed"]);
		const h = makeHarness(); h.install();
		const r = await toolCall(h, "bash", { command: "ls -la" });
		expect(r).toBeUndefined();
		expect(h.calls.length).toBe(0); // 合法条目仍生效
	});
	test("builtinDenyFloor: false disables the whole built-in deny floor (risk accepted by user)", async () => {
		setConfig({ builtinDenyFloor: false });
		const h = makeHarness(); h.install();
		h.responses = [{ text: "<verdict>deny</verdict> floor off" }];
		const r = await toolCall(h, "bash", { command: "rm " + "-rf /tmp/x" }); // 危险正则被关
		expect(h.calls.length).toBe(1);        // 交分类器
		expect(r?.block).toBe(true);           // 分类器裁决仍生效
	});
	test("builtinDenyFloor: false downgrades S0 path deny to gray (never to allow)", async () => {
		setConfig({ builtinDenyFloor: false });
		const h = makeHarness(); h.install();
		h.responses = [{ text: "<verdict>deny</verdict> floor off" }];
		const r = await toolCall(h, "write", { path: "~/.ssh/authorized_keys", content: "x" });
		expect(h.calls.length).toBe(1);        // gray 而非 deny → 分类器
		expect(r?.block).toBe(true);
	});
	test("builtinDenyFloor default true keeps the floor", async () => {
		setConfig({ allow: ["^rm"] });
		const h = makeHarness(); h.install();
		const r = await toolCall(h, "bash", { command: "rm " + "-rf /tmp/x" });
		expect(r?.block).toBe(true);           // 默认开:floor 仍优先于用户 allow
		expect(h.calls.length).toBe(0);
	});

	test("first run generates config template", () => {
		fs.rmSync(path.join(TMP_AGENT, "config"), { recursive: true, force: true });
		setConfig({});
		const h = makeHarness(); h.install(); // 触发 loadUserRules → 生成模板
		const p = path.join(TMP_AGENT, "config", "pi-verdict.json");
		expect(fs.existsSync(p)).toBe(true);
	});
});

// ── 3. 安全审计回归(8/8 载荷,#12) ─────────────────────

describe("security audit regression (all payloads must NOT be rule-allowed)", () => {
	const payloads: Array<[string, string, any]> = [
		["V1 cat private key", "bash", { command: "cat ~/.ssh/id_rsa" }],
		["V2 redirect to authorized_keys", "bash", { command: "echo evil > ~/.ssh/authorized_keys" }],
		["V3 newline hides second command", "bash", { command: "ls\nbash /tmp/evil.sh" }],
		["V4 env prefix", "bash", { command: "env npx -y evil-pkg" }],
		["V5 rg --pre", "bash", { command: "rg --pre=sh pattern" }],
		["V6 sort -o rc file", "bash", { command: "sort -o ~/.bashrc payload.txt" }],
		["V7 git --output=", "bash", { command: "git log --format=x --output=~/Library/LaunchAgents/x.plist" }],
	];
	for (const [name, tool, input] of payloads) {
		test(`${name} → reaches classifier (gray)`, async () => {
			setConfig({});
			const h = makeHarness(); h.install();
			h.responses = [{ text: "<verdict>deny</verdict> audit payload" }];
			const r = await toolCall(h, tool, input);
			expect(h.calls.length).toBe(1); // 未被规则层短路
			expect(r?.block).toBe(true);    // 分类器裁决生效
		});
	}
	test("V8 read ~/.npmrc → S0 deny (list expanded)", async () => {
		setConfig({});
		const h = makeHarness(); h.install();
		const r = await toolCall(h, "read", { path: "~/.npmrc" });
		expect(r?.block).toBe(true);
		expect(h.calls.length).toBe(0);
	});
});

// ── 3.5 分类器模型解析(flag > env > config > 自省) ─────

describe("classifier model resolution", () => {
	test("config classifierModel is used when flag/env absent", async () => {
		setConfig({ classifierModel: "zai/flash" });
		const h = makeHarness(); h.install();
		h.findMap = { "zai/flash": { id: "glm-4-flash" } };
		h.responses = [{ text: "<verdict>allow</verdict> ok" }];
		await toolCall(h, "bash", { command: "cargo build" });
		expect(h.calls[0].model).toBe("glm-4-flash");
	});
	test("invalid config model falls back to session model with one-time warning", async () => {
		setConfig({ classifierModel: "nope/missing" });
		const h = makeHarness(); h.install();
		h.responses = [{ text: "<verdict>allow</verdict> ok" }, { text: "<verdict>allow</verdict> ok" }];
		await toolCall(h, "bash", { command: "cargo build" });
		await toolCall(h, "bash", { command: "cargo build" });
		expect(h.calls[0].model).toBe("mock/glm"); // 回退自省
		const warns = h.notifies.filter(([m, l]) => l === "warning" && m.includes("nope/missing"));
		expect(warns.length).toBe(1); // 仅一次
	});
	test("pi-native thinking suffix: zai/flash:low → effort low (adaptive)", async () => {
		setConfig({ classifierModel: "zai/flash:low" });
		const h = makeHarness(); h.install();
		h.findMap = { "zai/flash": { id: "glm-4-flash" } };
		h.responses = [{ text: "<verdict>allow</verdict> ok" }];
		await toolCall(h, "bash", { command: "cargo build" });
		expect(h.calls[0].model).toBe("glm-4-flash");
		expect(h.calls[0].thinkingEnabled).toBe(true);
		expect(h.calls[0].effort).toBe("low");
	});
	test("suffix minimal maps to effort low; no suffix stays explicit off", async () => {
		setConfig({ classifierModel: "zai/flash:minimal" });
		const h = makeHarness(); h.install();
		h.findMap = { "zai/flash": { id: "glm-4-flash" } };
		h.responses = [{ text: "<verdict>allow</verdict> ok" }, { text: "<verdict>allow</verdict> ok" }];
		await toolCall(h, "bash", { command: "cargo build" });
		expect(h.calls[0].effort).toBe("low"); // minimal → low(anthropic effort 无 minimal)
		setConfig({ classifierModel: "zai/flash" });
		h.handlers.session_start?.({}, h.ctx); // 重载配置
		h.findMap = { "zai/flash": { id: "glm-4-flash" } };
		await toolCall(h, "bash", { command: "cargo build" });
		expect(h.calls[1].thinkingEnabled).toBe(false); // 无后缀 = 显式关思考
		expect(h.calls[1].effort).toBeUndefined();
	});
	test("invalid suffix warned once and ignored", async () => {
		setConfig({ classifierModel: "zai/flash:ultra" });
		const h = makeHarness(); h.install();
		h.findMap = {}; // 真实注册表找不到 flash:ultra 这样的 id
		// 后缀 ultra 非法 → 忽略后缀,specPart = zai/flash:ultra 注册表查无 → 回退自省 + 警告
		h.responses = [{ text: "<verdict>allow</verdict> ok" }];
		await toolCall(h, "bash", { command: "cargo build" });
		expect(h.calls[0].model).toBe("mock/glm");
		expect(h.notifies.some(([m, l]) => l === "warning" && m.includes("ultra"))).toBe(true);
	});

	test("CLI flag beats config", async () => {
		setConfig({ classifierModel: "zai/flash" });
		const h = makeHarness(); h.install({ modelFlag: "prov/flagged" });
		h.findMap = { "zai/flash": { id: "glm-4-flash" }, "prov/flagged": { id: "flagged-model" } };
		h.responses = [{ text: "<verdict>allow</verdict> ok" }];
		await toolCall(h, "bash", { command: "cargo build" });
		expect(h.calls[0].model).toBe("flagged-model");
	});
});

// ── 4. 分类器(重试矩阵 + 参数形态) ─────────────────────

describe("classifier", () => {
	test("success on first try: single call, thinkingEnabled=false, maxTokens=512", async () => {
		setConfig({});
		const h = makeHarness(); h.install();
		h.responses = [{ text: "<verdict>allow</verdict> fine" }];
		const r = await toolCall(h, "bash", { command: "cargo build" });
		expect(r).toBeUndefined();
		expect(h.calls.length).toBe(1);
		expect(h.calls[0]).toEqual({ model: "mock/glm", maxTokens: 512, thinkingEnabled: false });
	});
	test("empty output → retry at 1024, verdict honored", async () => {
		setConfig({});
		const h = makeHarness(); h.install();
		h.responses = [{ text: "", stopReason: "length" }, { text: "<verdict>deny</verdict> bad" }];
		const r = await toolCall(h, "bash", { command: "cargo build" });
		expect(h.calls.map((c: any) => c.maxTokens)).toEqual([512, 1024]);
		expect(r?.block).toBe(true);
	});
	test("both attempts fail → fail-closed deny with per-attempt diagnostics", async () => {
		setConfig({});
		const h = makeHarness(); h.install();
		h.responses = [{ text: "", stopReason: "length" }, new Error("gateway boom")];
		const r = await toolCall(h, "bash", { command: "cargo build" });
		expect(r?.block).toBe(true);
		expect(r.reason).toContain("attempt 1 (512t)");
		expect(r.reason).toContain("attempt 2 (1024t)");
	});
	test("ask + interactive confirm → allow; headless → deny", async () => {
		setConfig({});
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

// ── 5. 影子缓存(observe-only:行为零变化 + 统计正确) ────

function shadowStats(h: Harness): Record<string, number> {
	h.notifies.length = 0;
	h.commands.automode.handler("", h.ctx); // 裸调用 = 只读状态
	const line = h.notifies[0]?.[0].split("\n")[1] ?? "";
	const out: Record<string, number> = { gray: 0, hits: 0, rate: 0, missNoEntry: 0, missCtx: 0, cmdRepeats: 0, dangerous: 0, conservative: 0 };
	const m = line.match(/gray (\d+).*hits (\d+) \(([\d.]+)%\).*no-entry (\d+)\/ctx-changed (\d+).*repeats (\d+).*dangerous (\d+)\/conservative (\d+)/);
	if (m) [out.gray, out.hits, out.rate, out.missNoEntry, out.missCtx, out.cmdRepeats, out.dangerous, out.conservative] =
		[+m[1], +m[2], +m[3], +m[4], +m[5], +m[6], +m[7], +m[8]];
	return out;
}

describe("shadow cache (observe-only)", () => {
	test("rule verdicts never enter the shadow stats", async () => {
		setConfig({});
		const h = makeHarness(); h.install();
		await toolCall(h, "write", { path: "/proj/a.ts", content: "x" }); // 规则 allow(路径层)
		expect(shadowStats(h).gray).toBe(0);
	});
	test("repeat gray call: would-hit counted, model still called (never short-circuits)", async () => {
		setConfig({});
		const h = makeHarness(); h.install(); userMsg(h, "任务");
		h.responses = [{ text: "<verdict>allow</verdict> ok" }];
		const r1 = await toolCall(h, "bash", { command: "cargo build" });
		const r2 = await toolCall(h, "bash", { command: "cargo build" });
		const s = shadowStats(h);
		expect(s.gray).toBe(2);
		expect(s.hits).toBe(1);
		expect(h.calls.length).toBe(2); // observe-only:模型两次都真实调用
		expect(r1).toBeUndefined();
		expect(r2).toBeUndefined();
	});
	test("new user message → context-changed miss and overwrite", async () => {
		setConfig({});
		const h = makeHarness(); h.install(); userMsg(h, "任务");
		h.responses = [{ text: "<verdict>allow</verdict> ok" }];
		await toolCall(h, "bash", { command: "cargo build" });
		userMsg(h, "新指令");
		await toolCall(h, "bash", { command: "cargo build" });
		expect(shadowStats(h).missCtx).toBe(1);
	});
	test("ask and fail-closed never enter the cache", async () => {
		setConfig({});
		const h = makeHarness(); h.install();
		h.responses = [{ text: "<verdict>ask</verdict> risky" }];
		await toolCall(h, "mcp__x__y", { a: 1 });
		await toolCall(h, "mcp__x__y", { a: 1 });
		expect(shadowStats(h).missNoEntry).toBe(2);
	});
	test("LRU(128) evicts the oldest entry", async () => {
		setConfig({});
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

// ── 6. /automode 命令语义(显式 on/off + 只读状态) ───────

describe("/automode command", () => {
	test("bare call is read-only status with stats and usage", async () => {
		setConfig({});
		const h = makeHarness(); h.install();
		h.commands.automode.handler("", h.ctx);
		expect(h.notifies[0][0]).toContain("Auto Mode: on");
		expect(h.notifies[0][0]).toContain("shadow cache");
		expect(h.notifies[0][0]).toContain("Usage");
	});
	test("on/off are idempotent, annotated (未变化) when same", async () => {
		setConfig({});
		const h = makeHarness(); h.install();
		await h.commands.automode.handler("on", h.ctx);
		expect(h.notifies.at(-1)![0]).toContain("enabled (unchanged)");
		await h.commands.automode.handler("off", h.ctx);
		expect(h.notifies.at(-1)![0]).toContain("disabled");
		await h.commands.automode.handler("OFF", h.ctx);
		expect(h.notifies.at(-1)![0]).toContain("disabled (unchanged)"); // 大小写归一化
	});
	test("off actually disables gating", async () => {
		setConfig({});
		const h = makeHarness(); h.install();
		await h.commands.automode.handler("off", h.ctx);
		const r = await toolCall(h, "bash", { command: "rm " + "-rf /tmp/x" });
		expect(r).toBeUndefined(); // 关闭后危险命令也不再拦
	});
	test("unknown arg → warning with usage", async () => {
		setConfig({});
		const h = makeHarness(); h.install();
		await h.commands.automode.handler(" of", h.ctx);
		expect(h.notifies.at(-1)![0]).toContain("unknown argument");
		expect(h.notifies.at(-1)![1]).toBe("warning");
	});
});

// ── 7. debug 通知标注 ───────────────────────────────────

describe("debug annotations", () => {
	test("--auto-mode-debug: allows notify with shadow would-hit tag", async () => {
		setConfig({});
		const h = makeHarness(); h.install({ debug: true });
		h.responses = [{ text: "<verdict>allow</verdict> ok" }];
		await toolCall(h, "bash", { command: "cargo build" });
		await toolCall(h, "bash", { command: "cargo build" });
		const allowNotifies = h.notifies.filter(([m]) => m.includes("allow (classifier)"));
		expect(allowNotifies.length).toBe(2);
		expect(allowNotifies[1][0]).toContain("would-hit");
	});
});

// ── 8. 自保护层(ADR-0001:不可豁免的 deny) ─────────────

describe("self-protection layer (ADR-0001)", () => {
	const CFG = () => path.join(TMP_AGENT, "config", "pi-verdict.json");

	test("write to pi-verdict.json → deny, zero model calls", async () => {
		setConfig({});
		const h = makeHarness(); h.install();
		const r = await toolCall(h, "write", { path: CFG(), content: "{\"deny\":[],\"allow\":[\".*\"]}" });
		expect(r?.block).toBe(true);
		expect(r.reason).toContain("self-protection");
		expect(h.calls.length).toBe(0);
	});
	test("edit to pi-verdict.json → deny", async () => {
		setConfig({});
		const h = makeHarness(); h.install();
		const r = await toolCall(h, "edit", { path: CFG(), oldText: "a", newText: "b" });
		expect(r?.block).toBe(true);
		expect(r.reason).toContain("self-protection");
	});
	test("write via symlink to pi-verdict.json → deny (realpath 归一)", async () => {
		setConfig({});
		const link = path.join(TMP_AGENT, "link-to-config.json");
		try { fs.rmSync(link); } catch { /* 不存在 */ }
		fs.symlinkSync(CFG(), link);
		const h = makeHarness(); h.install();
		const r = await toolCall(h, "write", { path: link, content: "x" });
		expect(r?.block).toBe(true);
		expect(r.reason).toContain("self-protection");
	});
	test("relative path from a cwd whose file resolves onto config → deny", async () => {
		setConfig({});
		const h = makeHarness(); h.install();
		// cwd 指向 config 所在目录,相对路径直接命中
		h.ctx.cwd = path.join(TMP_AGENT, "config");
		const r = await toolCall(h, "write", { path: "pi-verdict.json", content: "x" });
		expect(r?.block).toBe(true);
		expect(r.reason).toContain("self-protection");
	});
	test("builtinDenyFloor:false does NOT disable self-protection", async () => {
		setConfig({ builtinDenyFloor: false });
		const h = makeHarness(); h.install();
		const r = await toolCall(h, "write", { path: CFG(), content: "x" });
		expect(r?.block).toBe(true);
		expect(h.calls.length).toBe(0);
	});
	test("user allow rule cannot override self-protection", async () => {
		setConfig({ allow: ["pi-verdict", ".*"] });
		const h = makeHarness(); h.install();
		const r = await toolCall(h, "write", { path: CFG(), content: "x" });
		expect(r?.block).toBe(true);
		expect(h.calls.length).toBe(0);
	});
	test("read of pi-verdict.json passes self-protection (读放行,走正常管线)", async () => {
		setConfig({});
		const h = makeHarness(); h.install();
		h.responses = [{ text: "<verdict>allow</verdict> ok" }]; // TMP 在 /var 下 → S1 读灰区,交分类器
		const r = await toolCall(h, "read", { path: CFG() });
		expect(r).toBeUndefined();
		expect(h.notifies.some(([m]) => m.includes("self-protection"))).toBe(false);
	});
	test("bash touching config filename → deny (any spelling)", async () => {
		setConfig({});
		const h = makeHarness(); h.install();
		const r = await toolCall(h, "bash", { command: "echo '{\"allow\":[\".*\"]}' > " + CFG() });
		expect(r?.block).toBe(true);
		expect(r.reason).toContain("self-protection");
		expect(h.calls.length).toBe(0);
	});
	test("bash with $PI_CODING_AGENT_DIR spelling → deny", async () => {
		setConfig({});
		const h = makeHarness(); h.install();
		const r = await toolCall(h, "bash", { command: "cat $PI_CODING_AGENT_DIR/config/pi-verdict.json" });
		expect(r?.block).toBe(true);
		expect(r.reason).toContain("self-protection");
	});
	test("ordinary commands unaffected (回归:无谈拦)", async () => {
		setConfig({});
		const h = makeHarness(); h.install();
		h.responses = [{ text: "<verdict>allow</verdict> ok" }];
		const r = await toolCall(h, "bash", { command: "ls -la /tmp" });
		expect(r).toBeUndefined();
		expect(h.calls.length).toBe(1);
	});
});

describe("buildProtectedSet (pure)", () => {
	test("single-file install form: exact own file + bash variants", () => {
		const own = path.join(TMP_AGENT, "extensions", "auto-mode.ts");
		fs.mkdirSync(path.dirname(own), { recursive: true });
		fs.writeFileSync(own, "// stub");
		const s = buildProtectedSet(TMP_AGENT, own);
		const ownReal = fs.realpathSync(own); // macOS TMP 在 /var → realpath 为 /private/var
		expect(s.exact).toContain(ownReal);
		expect(s.bashPatterns.some((re) => re.test(`echo x > ${ownReal}`))).toBe(true);
		expect(s.bashPatterns.some((re) => re.test("cat $PI_CODING_AGENT_DIR/extensions/auto-mode.ts"))).toBe(true);
		expect(s.watchBases).toContainEqual({ file: own, kind: "extension" });
		expect(s.watchBases).toContainEqual({ file: path.join(TMP_AGENT, "config", "pi-verdict.json"), kind: "config" });
	});
	test("npm dir install form: whole package dir as prefix", () => {
		const own = path.join(TMP_AGENT, "extensions", "pi-verdict", "extensions", "auto-mode.ts");
		fs.mkdirSync(path.dirname(own), { recursive: true });
		fs.writeFileSync(own, "// stub");
		const s = buildProtectedSet(TMP_AGENT, own);
		const pkg = path.join(TMP_AGENT, "extensions", "pi-verdict");
		expect(s.prefixes).toContain(fs.realpathSync(pkg));
		expect(isProtectedWritePath(path.join(pkg, "package.json"), "/proj", s)).toBe(true);
		expect(isProtectedWritePath(path.join(pkg, "sub/dir/x.ts"), "/proj", s)).toBe(true);
		expect(isProtectedWritePath(path.join(TMP_AGENT, "extensions", "other.ts"), "/proj", s)).toBe(false); // 包外不拦
	});
	test("dev checkout (outside agentDir/extensions) → 不保护扩展文件,仅配置", () => {
		const s = buildProtectedSet(TMP_AGENT, "/repo/extensions/auto-mode.ts");
		expect(s.exact).not.toContain("/repo/extensions/auto-mode.ts");
		expect(s.prefixes.length).toBe(0);
		expect(isProtectedWritePath(path.join(TMP_AGENT, "config", "pi-verdict.json"), "/proj", s)).toBe(true);
	});
});

// ── 9. 变更检测(ADR-0001:差分处置 D) ──────────────────

describe("tamper detection (ADR-0001, differential disposal)", () => {
	const CFG = () => path.join(TMP_AGENT, "config", "pi-verdict.json");

	test("interactive + Accept:用户会话中合法编辑 → 一次双选重建基线,会话照常,编辑保留", async () => {
		setConfig({});
		const h = makeHarness(); h.install();
		h.selectIndex = 0; // Accept the new version
		setConfig({ allow: ["^ls\\b"] }); // 模拟用户手工编辑(不经门禁)
		h.responses = [{ text: "<verdict>allow</verdict> ok" }, { text: "<verdict>allow</verdict> ok" }];
		const r1 = await toolCall(h, "bash", { command: "cargo build" });
		expect(h.selects).toBe(1); // 双选:仅一次
		expect(h.confirms).toBe(0); // 不走 confirm
		expect(r1).toBeUndefined(); // Accept → 本调用照常走正常管线
		expect(fs.readFileSync(CFG(), "utf8")).toContain("^ls"); // 编辑未被回滚
		const r2 = await toolCall(h, "bash", { command: "cargo build" });
		expect(h.selects).toBe(1); // 基线已重建:不再双选
		expect(r2).toBeUndefined(); // 会话未被砖
	});
	test("interactive + Decline:疑似篡改 → 还原 + 本会话 fail-closed", async () => {
		setConfig({});
		const h = makeHarness(); h.install();
		h.selectIndex = 1; // Decline — restore the session baseline
		const before = fs.readFileSync(CFG(), "utf8");
		fs.writeFileSync(CFG(), JSON.stringify({ allow: [".*"], builtinDenyFloor: false })); // 模拟绕过门禁的篡改
		const r1 = await toolCall(h, "bash", { command: "ls" });
		expect(r1?.block).toBe(true);
		expect(r1.reason).toContain("declined by user");
		expect(fs.readFileSync(CFG(), "utf8")).toBe(before); // 已从快照还原
		const r2 = await toolCall(h, "bash", { command: "ls" });
		expect(r2?.block).toBe(true);
		expect(r2.reason).toContain("fail-closed");
	});
	test("headless config change:无人可问 → 不确认,直接还原 + fail-closed", async () => {
		setConfig({});
		const h = makeHarness(); h.install();
		h.ctx.hasUI = false;
		const before = fs.readFileSync(CFG(), "utf8");
		fs.writeFileSync(CFG(), "{}");
		const r = await toolCall(h, "bash", { command: "ls" });
		expect(h.selects).toBe(0); // 无 UI 不弹双选
		expect(r?.block).toBe(true);
		expect(r.reason).toContain("tamper");
		expect(fs.readFileSync(CFG(), "utf8")).toBe(before);
	});
	test("clean session: no tamper signal, verdicts flow normally", async () => {
		setConfig({});
		const h = makeHarness(); h.install();
		h.responses = [{ text: "<verdict>allow</verdict> ok" }];
		const r = await toolCall(h, "bash", { command: "cargo build" });
		expect(r).toBeUndefined();
		expect(h.notifies.some(([m]) => m.includes("TAMPER"))).toBe(false);
	});
	test("session_start rebuilds baseline (legit edit between sessions accepted)", async () => {
		setConfig({});
		const h = makeHarness(); h.install();
		setConfig({ allow: ["^ls\\b"] }); // 会话间隙合法修改(不经门禁)
		await h.handlers.session_start({}, h.ctx); // 新基线
		h.responses = [{ text: "<verdict>deny</verdict> x" }];
		const r = await toolCall(h, "bash", { command: "cargo build" });
		expect(r?.block).toBe(true); // 正常走分类器,非 fail-closed
		expect(r.reason).not.toContain("tamper");
		expect(h.selects).toBe(0); // 无变化不弹双选
	});
	test("interactive + Esc 关闭双选:无人背书 → 安全侧同 Decline(还原 + fail-closed)", async () => {
		setConfig({});
		const h = makeHarness(); h.install();
		h.selectIndex = null; // select 返回 undefined(对话框被关闭)
		const before = fs.readFileSync(CFG(), "utf8");
		fs.writeFileSync(CFG(), "{}");
		const r = await toolCall(h, "bash", { command: "ls" });
		expect(h.selects).toBe(1);
		expect(r?.block).toBe(true);
		expect(r.reason).toContain("dialog dismissed");
		expect(fs.readFileSync(CFG(), "utf8")).toBe(before); // 已还原
	});
	test("headless config deleted mid-session → recreated from snapshot + fail-closed", async () => {
		setConfig({});
		const h = makeHarness(); h.install();
		h.ctx.hasUI = false;
		const before = fs.readFileSync(CFG(), "utf8");
		fs.rmSync(CFG());
		const r = await toolCall(h, "bash", { command: "ls" });
		expect(r?.block).toBe(true);
		expect(fs.existsSync(CFG())).toBe(true); // 删除亦被还原(重建)
		expect(fs.readFileSync(CFG(), "utf8")).toBe(before);
	});
});
