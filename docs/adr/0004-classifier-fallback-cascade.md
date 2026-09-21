# 0004 - Classifier fallback cascade: uncertainty-gated second layer, shadow-first

---
status: accepted
date: 2026-09-21
---

## Background

The first-layer classifier (typically jev via `classifierModel`, ADR-0003) is fast (~1.2s, near-free) but under-judges at the margin: the local verdicts corpus (646 records, `research/classifier-fallback-model-feasibility.md`) shows jev already emits calibrated probabilities yet the pipeline consumed only the choice — 23 of 403 jev allows carried confidence below 50% (several with deny probability ≥ 35%) and were allowed anyway. A natural A/B in the corpus (one full day of jev, one of a haiku-class LLM) showed the stronger model resolves more and over-blocks some — evidence for depth, but not enough to forfeit the fast path for the ~82–94% of calls that need no depth.

The literature's answer to exactly this tradeoff is the LLM cascade (FrugalGPT, arXiv 2305.05176; RouteLLM, lmsys): a cheap first layer plus a gate that escalates only uncertain calls to a stronger second layer. The two originally proposed shapes were both rejected on the corpus evidence — fallback-for-asks-only (the ask population is too small for the payoff) and judge-everything (doubles cost on every call; LLM-as-judge reliability is itself limited).

## Decision

1. **Uncertainty-gated cascade, opt-in** via three config keys: `classifierFallbackModel` (`provider/id[:thinking]` spec, same format/validation as `classifierModel`; the feature is entirely off unless set), `classifierFallbackConfidence` (0–100, default 50), `classifierFallbackMode` (`"shadow"` | `"enforce"`, default `"shadow"`). Trigger precedence: first-layer **fail-closed → ask → jev confidence strictly below the threshold**. Resolution is config-only (no flag/env precedence) and never falls back to the session model — a second layer silently inheriting the session model would bill the same judgment twice, not add a second opinion.
2. **Confidence is hard-required in the jev adapter**: the decisions contract guarantees `choice + probabilities + confidence` on choice answers, so a missing or non-numeric confidence in `verdictText` throws, joining the existing malformed → fail-closed discipline. Contract drift therefore fails closed — and the cascade's fail-closed trigger means the second layer still runs on those calls. `parseJevConfidence(reason)` is exported for the gate; it returns null for non-jev reasons, so **LLM first layers gate on ask/fail-closed only** (they carry no numeric confidence).
3. **Shadow-first rollout**: in shadow (the default) the second layer runs on triggered calls and its outcome is recorded — an optional `fallback` sub-object on the audit record and session-memory counters surfaced via `/automode` — while the effective verdict never changes. This follows the #7 shadow-cache discipline (observe-only, session-memory stats, never an adjudication input).
4. **Enforce is a safety ratchet**: `effective = stricter(first, fallback)` with allow < ask < deny — the fallback may only escalate strictness, never relax. An escalation annotates the reason (`… (second-opinion classifier escalated allow to deny)`). The fallback receives the full `CLASSIFIER_SYSTEM + DENY_PATHS_HINT` prompt — unlike jev, it sees the denyPaths existence hint (with an LLM first layer, both layers see it).
5. **Failure semantics (grill decision, user override)**: once the user configures a second layer, its silent failure must not quietly degrade the gate to single-layer. In enforce, a failed fallback call (timeout/credential/parse — 15s per attempt) or an unresolvable model **denies the triggered call** through the existing fail-closed lane, and the failure row carries `fallback.effective: "deny"` like every other enforce row; untriggered calls never consult the fallback and stay single-layer. In shadow a failure is recorded (`fallback.error`, errored counter) and changes nothing.
6. **No ratchet exception for first-layer absence**: a no-model fail-closed (first layer never ran) triggers the cascade as well, but the ratchet means the resulting deny can never be relaxed by the fallback — the trigger is observability-only in enforce. An exception would hand adjudication to the second layer whenever the first layer is made to fail, including adversarially.
7. **Audit keeps first-layer semantics at the top level** (grill decision — shadow/enforce corpus comparability, old analysis scripts keep working): the enforced outcome lives in `fallback.effective` (enforce rows only, failure rows included). Evaluators must read enforce rows through the sub-object. Composes with #62: escalated interactive asks carry the sub-object into the deferred record and attach `userAnswer` at finalize.

## Known limitations

- A cascade raises *resolution*; it is not an injection defense — both layers read the same transcript, and jev "does not treat state as hostile". The rule floor and self-protection layer remain the deterministic backbone.
- Shadow data is only evaluable with the #62 ground-truth fields; without `userAnswer`, agreement rates say nothing about correctness.
- Enforce rows must be read via `fallback.effective` (the top-level verdict is the first layer's) — a documented trap for analysis scripts. On non-interactive records, an `effective` of `ask` was applied as its deny degradation (the usual ask-degradation rule); the top-level `degraded` flag reflects the first layer only.
- Sequential latency: a triggered call may spend the first layer's budget plus up to 15s of fallback budget *per attempt* (the two-tier retry mirrors the first layer's per-attempt 25s, so worst case ≈30s).
- Judge reliability limits apply to the second layer too (self-preference, inconsistency); the ratchet bounds the damage to over-strictness, never over-permissiveness.

## Alternatives considered

- **Fallback for asks only (original shape a)**: dominated — the ask population is the smallest slice; the gate would idle exactly where jev is weakest (confidently-wrong low-confidence allows).
- **Judge every first-layer verdict (original shape b)**: doubles cost on every call for a signal the confidence gate localizes to 6–18% of calls; LLM-as-judge reliability limits.
- **Confidence threshold → direct ask, no second model**: free, but converts uncertainty into precisely the human distraction the feature exists to reduce.
- **Swap the first layer to a strong LLM outright**: available today as a one-line config change; forfeits jev's fast path for the majority of calls that need no depth.
- **Fail-open to the first layer on fallback failure** (recommended in design, rejected by the maintainer in grill): a configured-but-broken second layer would degrade silently; availability is recoverable by fixing the config, silent degradation is not observable.
- **Ratchet exception rescuing fail-closed when the fallback is confident**: rejected — see Decision 6.

## Shadow → enforce flip criteria

Recorded as a minimum bar plus a human decision, never an automatic threshold: at least ~2 weeks of shadow data, an adequate triggered sample, and no ground-truth evidence of fallback false-allows on triggered calls. Flipping `classifierFallbackMode` is a config change effective in new sessions.

## Consequences

- The config surface grows by three keys (template + `_hint` updated); users who configure nothing see byte-identical behavior (pinned by tests: one model call per trigger flavor, non-jev reasons never confidence-trigger).
- `pi-verdict.ts` imports `parseJevConfidence` from the jev adapter (top-level side-effect-free — the import cannot register providers or touch the network; coupling noted in the PR).
- The audit schema gains an optional `fallback` sub-object; consumers ignoring unknown fields are unaffected, and `fallback.effective` is the only place the enforced verdict lives.
- The corpus question "is the first layer reliable?" becomes measurable once #62 ground truth accumulates; revisit shape (b) (judge everything) only if shadow data shows confidently-wrong first-layer allows are common.
