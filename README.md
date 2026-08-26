# pi-verdict

**[English](README.md)** | [简体中文](README.zh-CN.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/pi-verdict)](https://www.npmjs.com/package/pi-verdict)
[![pi extension](https://img.shields.io/badge/pi-extension-blueviolet)](https://pi.dev)

> Pi runs YOLO by default: every tool call executes without asking.
> **verdict gives each call a three-state adjudication — `allow / ask / deny`.**
> A built-in deny floor plus your own allow/deny rules first; everything else goes to a model classifier that sees the conversation context; every failure mode fails closed.

**verdict is an adjudication, not a switch.** Most classifiers in this space output a binary allow/block. Three states matter: `ask` routes genuinely ambiguous actions to a human (and degrades to `deny` in non-interactive sessions), so "not sure" never silently becomes "go ahead".

## How it compares

| | three-state verdict | classifier sees context | fail direction | runtime deps |
|---|---|---|---|---|
| **pi-verdict** | ✅ allow / ask / deny | ✅ recent user intent + tool calls | **closed** (errors/timeout/bad output → deny; headless ask → deny) | **0** |
| [@czottmann/pi-automode](https://github.com/czottmann/pi-automode) | rules 3-state, classifier 2-state | ✅ budgeted transcript | closed | 1 |
| [@zhushanwen/pi-permission](https://www.npmjs.com/package/@zhushanwen/pi-permission) | ✅ (outcome) | ❌ single-turn, no context | closed (→ ask) | 4 |
| [@gotgenes/pi-permission-system](https://github.com/gotgenes/pi-packages) | ✅ deterministic only | — (no built-in classifier) | closed | 3 |

Full landscape: [`research/pi-permission-landscape.md`](research/pi-permission-landscape.md) · convergence analysis with the closest architectural relative: [`research/pi-automode-convergence.md`](research/pi-automode-convergence.md).

Honest framing: pi-automode and pi-verdict have **converged on the same architecture** (deny floor → user rules → classifier, fail-closed — see the convergence analysis). What remains distinct here: a classifier that can say `ask` (runtime human-in-the-loop, not just rule-declared), a built-in floor you can turn off (`builtinDenyFloor` — user sovereignty), a zero-dependency single file (~700 lines, deliberate), and the measurement habit — every design decision in this repo is backed by shipped research.

The single-file, zero-dependency shape is deliberate — the whole extension is one readable [~700-line file](extensions/auto-mode.ts).

## Pipeline

```
tool_call
  │
  ├─ 1. Rule layer (deterministic, zero latency)
  │     ├─ built-in deny floor: bash danger regexes (full-string) +
  │     │   path sensitivity S0–S5 (secrets/system/.git meta → deny)
  │     ├─ your rules: user deny beats user allow (regex, see below)
  │     └─ no built-in allowlist — every "always allow" claim is yours to make
  │
  ├─ 2. Gray zone → model classifier (defaults to session model — "self-reflection")
  │     ├─ input: CC-style <transcript> (last 5 user messages + last 10 tool calls,
  │     │        action under review always last) — user intent is evidence
  │     ├─ output contract: <verdict>allow|ask|deny</verdict> prefix-anchored
  │     ├─ thinking explicitly disabled (thinkingEnabled: false) + retry 512→1024
  │     └─ configurable via --auto-mode-model
  │
  └─ 3. Three-state adjudication
        ├─ allow → pass
        ├─ deny  → block, reason returned to the agent
        └─ ask   → human confirm (ctx.ui.confirm); non-interactive modes degrade to deny

  [shadow cache] (observe-only, runs alongside 2/3, never changes a verdict)
        replays a double-key LRU(128) to measure would-be hit rate
```

**fail-closed**: classifier exception / timeout (15s) / contract violation → deny. Never silently allow.

## Quick start

```bash
# install from npm (after the first release is published)
pi install npm:pi-verdict

# or directly from git — try it once
pi --extension ./extensions/auto-mode.ts

# or install globally (auto-discovered)
cp extensions/auto-mode.ts ~/.pi/agent/extensions/
```

- `/automode` — status (read-only): on/off + shadow-cache stats for the session
- `/automode on` / `/automode off` — idempotent set; unknown args are rejected with usage
- footer always shows `auto mode on` (highlighted) / `auto mode off` (dimmed)
- `pi --auto-mode-debug` — notify every verdict incl. allows, with shadow-cache annotations

| Option | Default | Description |
|---|---|---|
| `--auto-mode` / `--no-auto-mode` | on | master switch |
| `--auto-mode-model provider/id` | session model | classifier model ("self-reflection" by default) |
| `--auto-mode-debug` | off | full verdict notifications |
| `PI_AUTO_MODE_MODEL` | — | env form of the model flag |
| `PI_AUTO_MODE_DEBUG=1` | off | env form of debug (flag wins) |

### User rules (`config/pi-verdict.json`)

```json
{
  "allow": ["^ls\\b", "^git (status|log|diff)\\b"],
  "deny":  ["rm ", "docker ", "^/etc/"],
  "builtinDenyFloor": true,
  "classifierModel": null
}
```

- `allow`/`deny` are JS regex arrays; **`deny` wins over `allow`**, both beat the classifier
- matched against the **full command string** for bash, the **absolute path** for file tools (read/write/edit/grep/find/ls); other tools (MCP etc.) always go to the classifier
- `builtinDenyFloor: false` turns the built-in danger/path floor off entirely (risk accepted by you; the classifier and your rules remain)
- `classifierModel: "provider/model-id"` persistently sets the classifier model (e.g. a fast flash-class model); precedence is flag > env > config > session model (self-reflection); an invalid value falls back to the session model with a one-time warning
- the spec accepts pi's native `--model` thinking suffix: `"zai/glm-4-flash:low"` sets classifier thinking to effort low (default without suffix: thinking explicitly off — the [measured](research/thinking-param-blackhole.md) default)
- first run generates a template at `~/.pi/agent/config/pi-verdict.json` (honors `PI_CODING_AGENT_DIR`); changes apply to new sessions

Why no built-in allowlist? A third-party security audit ([`research/rule-layer-security-audit.md`](research/rule-layer-security-audit.md)) showed that allowlist soundness requires shell AST analysis — every built-in "always allow" would be a security claim maintained by the author. The built-in layer only makes **deny** claims (the sound direction); allow claims are yours.

Requires pi ≥ 0.84. Works in interactive and non-interactive (`-p`/json/rpc) sessions; in non-interactive modes `ask` degrades to `deny`.

## Evidence-driven, not vibes-driven

Design decisions here are settled by measurement, and the lab notes ship with the repo:

- [`research/cache-sim`](research/cache-sim/README.md) — replayed 1.2k+ real classifier verdicts to measure verdict-cache hit rate (**3.2%** → cache deferred, shadow-mode telemetry built instead)
- [`research/thinking-param-blackhole.md`](research/thinking-param-blackhole.md) — three-layer forensic root-cause of thinking models burning the classifier budget; why the fix is `thinkingEnabled: false`
- [`research/rule-engine-sim`](research/rule-engine-sim/README.md) — measured a tree-sitter rule-engine port against 746 real bash calls (**absorbs 0 gray calls**) and rejected it
- [`research/pi-permission-landscape.md`](research/pi-permission-landscape.md) — the competitive landscape this README's positioning is checked against
- [`research/rule-layer-security-audit.md`](research/rule-layer-security-audit.md) — third-party audit of the rule layer (8/8 reproduced → fixed architecturally in 0.2.0)
- [`research/pi-automode-convergence.md`](research/pi-automode-convergence.md) — where this project genuinely converges with pi-automode, and what remains distinct
- [`research/claude-code-classifier-prompts.md`](research/claude-code-classifier-prompts.md) — structural reconstruction of Claude Code's classifier design (via self-hosted Langfuse observations) that this extension's transcript contract descends from

## Status & limitations

Prototype quality — usable, not hardened:

- no built-in allowlist by design (see the [security audit](research/rule-layer-security-audit.md)); with an empty `allow` config most commands go to the classifier — point `--auto-mode-model` at a fast model if per-call latency matters
- AGENTS.md is not passed to the classifier as downweighted intent evidence (Claude Code does this)
- parallel gray-zone calls are adjudicated serially
- self-reflection means the session model adjudicates — point `--auto-mode-model` at a lighter model if verdict latency/cost matters (open question tracked in the issue tracker)
- shadow cache is observe-only by decision; the serving switch is a one-line change once measured hit rates justify it

**verdict is not a sandbox.** It runs inside the pi process and adjudicates tool calls; it does not contain malicious code, protect against a compromised process, or guard manual `!` shell escapes. For isolation, use an OS-level sandbox.

The name: the three-state **verdict** is the core concept. The UX keeps `/automode` — the mode concept traces back to Claude Code's auto mode, which this project borrows its transcript design from.

## Development

```bash
bun install
bun run typecheck
bun test          # 36 offline stub tests: deny floor, user rules, audit regression, classifier retry, shadow cache, commands
```

Issue tracker and decision records live in the GitHub issues ("map" issue #1 indexes them).

## License

[MIT](LICENSE)
