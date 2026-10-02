# 0006 - Nested codemode calls: layered exemption policy + audit attribution

---
status: accepted
date: 2026-10-02
---

pi ≥ 0.99's codemode runs model-written JavaScript whose tool calls re-enter the `tool_call` pipeline as nested calls (`parentToolCallId` set, ids `<parent>/<n>`); pi routes them through the handlers by design, and pi-verdict gates them identically to direct calls (live-fire verified 2026-10-02, PR #89 pins it). That identity amplifies cost: gray-zone adjudication is serial, measured at ~350ms per nested call (jev) — a 50-call `Promise.all` batch pays ~17.5s of pure gating latency, the 256-call cap ~90s (an LLM classifier's p90 ≈ 20s multiplies that to ~85min). Users faced a binary: full gating latency or `/automode off`.

pi-verdict 0.14 adds `codemodeNestedCalls` (default `"gate"` = unchanged identity) with `"rules-only"` as an opt-in layered exemption: nested calls keep every deterministic layer — self-protection (ADR-0001), the built-in deny floor, user rules, denyPaths with its terminal ask — and skip only the classifier + confidence cascade; the gray zone passes. Recorded in the audit (`source: "rule"`, `policy: "rules-only"`), because the user needs corpus data on what the opt-in lets through. Alongside (mode-independent), audit records gain `toolCallId` / `parentToolCallId` attribution — the live-fire session showed nested records were field-for-field indistinguishable from direct calls.

## Rejected alternatives

- **Full skip for sandbox calls**: the QuickJS sandbox constrains the script, not the tools — script-issued `bash` is real privileged execution, so skipping is a complete bypass (wrap any blocked action in a script); it would also drop the self-protection layer's preventive denies to post-hoc tamper detection.
- **Static script-source analysis**: dynamically constructed commands defeat it; not a security boundary.
- **Session-level trust after one confirm**: privilege persistence across the script/session violates least privilege.

## Consequences

- **The honest cost of rules-only**: rule-passing actions the classifier would have caught now pass — e.g. a nested `bash head ~/.ssh/config` (live-fire record: the jev+fallback layer denied it) passes unless `~/.ssh` is a denyPaths declaration, in which case bash token extraction still asks. Deterministic coverage beyond the floor is denyPaths-declaration-dependent; the configuration docs state this.
- Gate stays the default; direct calls are byte-identical under both modes; PR #89's baseline tests pin the identity.
