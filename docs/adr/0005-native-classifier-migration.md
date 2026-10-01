# 0005 - Native classifier migration: retire the jev-adapter, require pi ≥ 0.99

---
status: accepted
date: 2026-10-01
---

pi 0.99 added native classifier support — `ModelRegistry.classify()` with request-time auth, plus classifier-typed catalog entries (`typesafe/jev-latest` direct, Jev on OpenRouter/OpenCode/Cloudflare/Vercel, llama.cpp label-probability classifiers) — protocol-isomorphic to what the bundled jev-adapter built by hand (ADR-0003). pi-verdict 0.13 deletes `extensions/jev-adapter.ts` and routes classifier-typed models through `ctx.modelRegistry.classify()`; a `classifierModel` spec resolves via `findOfType("classifier", …)` first (the native path wins same-id dual listings, e.g. llama.cpp chat+classifier pairs), falling back to the chat registry (the LLM prompt path). Retiring the adapter also un-shadows pi's built-in `typesafe` classifier: the adapter's native provider registration replaced the provider's model list wholesale for the whole session, hiding the built-in entry from other extensions (evidence: `research/pi-0.87-to-0.99-upgrade-assessment.md` §2.2).

Old hosts keep old extensions: 0.13 raises peerDependencies to `>=0.99.0` (pi < 0.99 and omp installations stay on 0.12.x from npm) instead of carrying a dual-path compat layer.

## Consequences

- **The confidence floor keys on protocol-native confidence** (`ClassifierOutcome.confidence`, set only by the classify() path) instead of "decisions-model identity + reason-text parsing" — an LLM's free text cannot demote by construction, not by regex. ⚠️ Corpus comparability: pre-0.13 demoted rows required the 0.12 criterion; cross-version analysis must treat the demoted population as criterion-dependent (the same caveat class as 0.12.1).
- **The reason line keeps its exact 0.12 shape for System One** (`jev:` prefix — audit tooling continuity); other classifier APIs render `classifier:`.
- **Carried-over limitation**: `VERDICT_QUESTIONS` has no denyPaths criteria variant — the adapter never saw the hint either (parity); tightening it is a separate change.
- `PI_VERDICT_JEV_TRANSPORT` / `PI_VERDICT_JEV_URL` are gone; custom endpoints move to models.json provider `baseUrl` overrides. llama.cpp local classifiers become zero-cost classifier options.
- On hosts without `classify()` a native spec is unresolvable and follows the standing fallback-with-warning path (never a silent chat downgrade).
