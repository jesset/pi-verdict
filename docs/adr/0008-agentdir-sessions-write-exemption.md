# 0008 - Headless subagent-artifacts write exemption

---
status: accepted
date: 2026-10-05 (revised 2026-10-06)
---

pi's subagent tooling has its agents write working artifacts under `<agentDir>/sessions/<project>/subagent-artifacts/outputs/<run-id>/…`. Those writes are model-issued `write` calls, so they flow through the gate; they grade gray (outside the project cwd), and a subagent session has **no UI** — an ask degrades to deny. The production audit ([research](../../research/verdicts-ask-friction-audit-2026-10.md) §4/S5) captured the end-to-end false positive: a subagent writing its own artifact pipeline drew ask 48% → fallback allow → carve-out ask → no-UI degradation → deny (`degraded: true`). The subagent's work fails with no human in the loop and no appeal path.

Decision: a **headless** (`hasUI === false`) `write`/`edit` whose every canonical form sits under `<agentDir>/sessions/` **and** carries a `subagent-artifacts` directory segment returns a deterministic allow from the rule layer (`subagent artifacts (headless) — deterministic write exemption`). Boundary commitments:

- **Headless-only**: an interactive session keeps its ask capability — the gate never silently waives an adjudication a human could still perform. The headless gate is the point: no ask channel exists there, so the choice is deterministic-allow or deterministic-deny.
- **Subagent-artifacts subtree, not the whole sessions/ tree**: the exemption names the path shape pi's subagent tooling actually writes. Other sessions/ paths (transcripts et al.) stay classifier-adjudicated; the write author there is pi's own infrastructure (never gated), so no observed need exists.
- **Every-form intersection** (ancestor-rebuild tier on both sides): the prefix generates via `rebuiltForms` — sessions/ may not exist on a fresh install and `baseForms` alone would miss the firmlink real form (`/private/var/…` vs `/var/…`), silently voiding the exemption; that tier mismatch was caught by the headless test on a fresh agent dir. A symlink whose existing target resolves outside the tree earns no exemption; a dangling one keeps the standing #20 parent-rebuild semantics.
- **Position**: the check sits in `adjudicate` after `classifyByRules` has returned — after user deny and denyPaths (declarations beat the built-in exemption) — and only lifts the gray grade: floor denies and self-protection returned earlier.
- **Scope**: write/edit only. Reads of session transcripts stay classifier-adjudicated (transcripts contain untrusted model output — the same reason verdicts reads are denied outright); bash is untouched.

Why `hasUI` and not a subagent identity signal: **pi's ExtensionAPI exposes none** — no `isSubagent`, no parent-session linkage; `parentToolCallId` marks codemode nested calls only, and a subagent session presents as an independent session (own sessionId, no parent marker, own verdicts file). `hasUI === false` is the only available proxy; its coverage error is the headless *main* session (`pi -p`) gaining the same exemption for artifacts writes — accepted as low-cost (that path shape has no legitimate non-subagent writer). Upstream signal request declined: subagents are an extension-surface capability of pi, not core, and this gate should not key on it.

No configuration key: the closest precedent is #54's verdicts read-deny, equally keyless — both are facts about the gate's relationship to pi's own surfaces, not user policy. #12's "no built-in bash allowlist" stance is about bash command whitelists and is not crossed by a path-tool grade.

## Rejected alternatives

- **Path-only exemption (this ADR's initial draft)**: exempting the write regardless of session UI-ness also waived adjudication for interactive sessions, where a human could still be asked — silent waiving without need. Tightened in this PR's review round before any release.
- **Exempt the whole `<agentDir>/sessions/` tree**: broader than the observed false positive; transcripts and any future session-adjacent files would pass unadjudicated for no observed need.
- **Precise subagent identity (isSubagent / parentSessionId / sessionId↔run-id binding)**: no API signal exists; the run-id in the artifacts path has no visible binding to the session; heuristic guessing (cwd/sessionId shape) is worse than a declared proxy — a guessed exemption is a guessed hole.
- **Exempt `<agentDir>/workflows/` too**: the workflows tree lives under `~/.pi/workflows`, outside the agent dir — a different surface with no observed false positive.
- **Exempt reads / bash**: transcripts are untrusted-content sinks (the #54 rationale); bash token extraction is weaker than path-tool semantics, with no observed false positive.
- **A config key**: the observed surface is one pi-internal path shape; a key would be configuration for the sake of configuration.

## Consequences

- The false-positive class is closed for subagent artifact writes, deterministically and latency-free (zero classifier calls) — precisely in the sessions where no alternative existed.
- The admitted risk is stated plainly: a headless session writing inside the subagent-artifacts subtree passes without adjudication. That path shape is pi-tooling-owned; a compromised agent could stash data there, but it can already write anywhere else in the project, so the marginal exposure is negligible.
- An interactive session writing that subtree now draws a possible ask (measured occurrences to date: zero) — the price of never waiving an adjudication a human can perform.
- Discovered and recorded en passant: the verdicts `readPrefixes` use `baseForms` while the read-side check uses `rebuiltForms` — the same tier mismatch. Practically safe today (the verdicts dir exists whenever records are readable; a nonexistent dir has nothing to read), but worth aligning if that prefix set ever grows.
- Rule-layer allows stay unaudited (the #54 convention) — the exemption inherits it; corpus visibility of what passes here is deliberately forgone.

## Revision note

2026-10-06: the initial draft (same PR, pre-merge review round) exempted write/edit under the whole `<agentDir>/sessions/` tree in all sessions. Tightened to headless-only ∧ subagent-artifacts subtree after maintainer review — the interactive-session waiver had no justification, and the subtree names the actual false-positive shape.
