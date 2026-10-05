# 0008 - agentDir sessions/ runtime write exemption

---
status: accepted
date: 2026-10-05
---

`<agentDir>/sessions/` is pi's own runtime output tree — subagent artifacts (`sessions/<project>/subagent-artifacts/outputs/…`) are written there by pi's subagent tooling while the agent works. These writes grade gray under the path rules (outside the project cwd), so the classifier adjudicates them; in a headless (no-UI) subagent context an ask degrades to deny, and the production audit ([research](../../research/verdicts-ask-friction-audit-2026-10.md) §4/S5) captured the end-to-end false positive: a subagent writing its own artifact pipeline drew ask 48% → fallback allow → carve-out ask → no-UI degradation → deny (`degraded: true`). The subagent's work fails with no human in the loop and no appeal path.

Decision: `write`/`edit` whose every canonical form sits under `<agentDir>/sessions/` return a deterministic allow from the rule layer (`agentDir sessions/ runtime data — deterministic write exemption`). Three boundary commitments define it:

- **Position**: after user deny and denyPaths, before the gray fall-through. A user declaration beats the built-in exemption; the exemption only lifts the gray grade — the floor and self-protection have already returned by then (writes to `config/`, `extensions/`, `verdicts/` stay denied; S0/S1 hits stay denied).
- **Semantics**: every-form intersection (ancestor-rebuild tier on both sides). The prefix is generated with `rebuiltForms(agentDir/sessions)` — sessions/ may not exist on a fresh install, and `baseForms` alone would miss the firmlink real form (`/private/var/…` vs `/var/…` on macOS), silently voiding the exemption; that tier mismatch was caught by the headless test on a fresh agent dir. Conversely, a symlink whose target exists and resolves outside sessions/ earns no exemption (classifier-adjudicated); a dangling symlink keeps the standing #20 rebuild semantics (parent-dir rebuild, in-tree).
- **Scope**: write/edit only. Reads of session transcripts stay classifier-adjudicated (transcripts contain untrusted model output — the same reason verdicts reads are denied outright); bash is untouched (token extraction is weaker than path-tool semantics, and no bash false positive was observed).

No configuration key: the closest precedent is #54's verdicts read-deny, equally keyless — both are facts about the gate's relationship to pi's own surfaces, not user policy. #12's "no built-in bash allowlist" stance is about bash command whitelists and is not crossed by a path-tool grade.

## Rejected alternatives

- **Exempt `<agentDir>/workflows/` too**: the workflows tree lives under `~/.pi/workflows`, outside the agent dir — a different surface with no observed false positive. Rejected pending evidence.
- **Exempt bash via token extraction**: weaker semantics (string-level, spoofable spacing), no observed need.
- **Exempt reads**: session transcripts are untrusted-content sinks, the exact class #54 denies for verdicts.
- **A config key (`agentRuntimeWrite`)**: the observed surface is one pi-internal directory; a key would be configuration for the sake of configuration.
- **A new S6 path tier**: the exemption is not a sensitivity grade — it is an ownership statement (pi's runtime data), which is why it lives beside the user-rule application, not inside classifyPath.

## Consequences

- The false-positive class is closed for subagent artifact writes, deterministically and latency-free (zero classifier calls).
- The admitted risk is stated plainly: any write that lands inside `<agentDir>/sessions/` passes without adjudication. That tree is pi's working surface; a compromised agent could stash data there — but it can already write anywhere else in the project, so the marginal exposure is negligible.
- Discovered and recorded en passant: the verdicts `readPrefixes` use `baseForms` while the read-side check uses `rebuiltForms` — the same tier mismatch. Practically safe today (the verdicts dir exists whenever records are readable; a nonexistent dir has nothing to read), but worth aligning if that prefix set ever grows.
- Rule-layer allows stay unaudited (the #54 convention) — the exemption inherits it; corpus visibility of what passes here is deliberately forgone.
