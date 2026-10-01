# 0003 - Jev decisions adapter: a non-generative model as the classifier backend

---
status: superseded by ADR-0005 (the adapter mechanism; the research basis, criteria, and failure discipline carry over)
date: 2026-09-19
---

## Background

TypeSafe's jev (released 2026-09-15) is a **decisions-modality** model: it takes unstructured state in and returns schema-constrained typed decisions (a chosen value plus a probability distribution and a confidence), generating no text. OpenRouter serves it only through the dedicated `POST /api/alpha/decisions` endpoint (`chat/completions` rejects it with an explicit 400), and it does not appear in the public model catalog. pi's built-in `openrouter` provider speaks chat completions only, while `classifierModel` resolves through pi's `modelRegistry` — jev cannot enter that system without an adapter.

Research findings (research/typesafe-jev-classifiermodel.md, later revised and extended by research/jev-classifier-model.md): the classifier task maps exactly onto jev's `choice` primitive (a three-way allow/ask/deny pick); live in-repo measurements showed ~1.2s latency and ~$0.000015 per call. However, TypeSafe's own jaggedness docs concede that **"State is data, and `jev-1.13` does not treat it as hostile by default"** — adversarial content can move its judgment, and the classifier's state is precisely a transcript containing untrusted file content.

## Decision

1. **Second bundled extension, lazily effective**: `extensions/jev-adapter.ts` ships in the same package (the package's `pi.extensions` points at the whole directory) and registers `typesafe/jev-latest` (`reasoning: false`) via `pi.registerProvider()`. Unless `classifierModel` points at it or credentials resolve, the adapter takes no part in adjudication (registered but inert).
2. **Credentials reuse pi's system, no second channel** *(amended 2026-09-19)*: two transports share one adapter (`PI_VERDICT_JEV_TRANSPORT`, default `openrouter`; their wire contracts are isomorphic except for the model slug — live-verified, research/typesafe-jev-classifiermodel.md §2 and the 2026-09-19 direct probes). The `openrouter` transport resolves `ctx.modelRegistry.getProviderAuth("openrouter")` (resolver stashed at `session_start`) → `OPENROUTER_API_KEY` env → none. The `typesafe` transport (added 2026-09-19) targets TypeSafe's official v1 `POST /v1/systemone`; pi has no typesafe provider or login, so `TYPESAFE_API_KEY` env is its only source — still resolved through the provider auth pipeline, never a bare fetch or a second store. Either way, unconfigured means the main extension falls back to the session model with the existing warning. Because the registry's `hasConfiguredAuth` reads a sync snapshot built at startup, the same provider object is re-registered after `session_start` to trigger an availability refresh of that snapshot.
3. **Translation contract**: state = the classifier request's last user message (the transcript); the question is a fixed allow/ask/deny `choice` (criteria mirror `CLASSIFIER_SYSTEM`, keeping the evidence-not-instruction discipline and the err-on-ask default); the response is synthesized into a user-readable `<verdict>{choice}</verdict> jev: ask 63% (confidence 45%; allow 35%, deny 2%)` — satisfying the existing prefix contract with zero changes to the main adjudication pipeline.
4. **Failure semantics unchanged**: the adapter sets no internal timeout and passes `signal` through; the main extension's 25s timeout, parse failures, and network errors all land in the existing fail-closed deny.
5. **Self-protection coverage comes for free**: under the same-package npm-dir install form, the adapter copy automatically joins the tamper-detection baseline through #26's whole-package enumeration (pinned by a regression test); it sits on the permission path, so tampering triggers the existing restore + fail-closed.
6. **Misuse guard**: selecting a `typesafe/*` model via `model_select` warns (a decisions model generates no text and cannot drive a session); the endpoint URL is overridable via `PI_VERDICT_JEV_URL` (insurance against alpha-API drift).

## Known limitations

- **The denyPaths existence hint does not reach jev**: the adapter ignores the incoming systemPrompt (the hint lives there); denyPaths themselves remain rule-enforced before the classifier, so only the gray-zone strictening signal is lost.
- **State injection surface**: per the quoted docs, jev does not treat state as hostile by default; mitigation rests on the rule layer running first (hard deny/ask precede the classifier) and the main extension's transcript sanitization, but classifier-layer prompt-injection resistance is weaker than the LLM backend's, which carries its own evidence-not-instruction system prompt.
- **The reason is a templated probability/confidence line**, not a natural-language explanation (a UX regression for ask dialogs).
- **omp hosts are unaffected** (no `registerProvider`); `classifierModel` pointing at `typesafe/*` follows the existing fallback-with-warning path there.
- The OpenRouter endpoint is alpha and its schema may evolve; TypeSafe's v1 is official but the latest alias tracks the newest snapshot, so verdict behavior may shift across snapshots on either transport (`PI_VERDICT_JEV_URL` remains the drift escape hatch). TypeSafe's API does not report per-call cost (it surfaces as $0).

## Alternatives considered

- **Wait for native decisions-modality support in pi/pi-ai (zero code)**: blocked on upstream scheduling with no timeline; the adapter is an explicitly transitional layer that can be dropped wholesale once native support lands.
- **Direct fetch inside pi-verdict**: breaks the existing "extensions are model-agnostic, credentials flow through pi" architecture (adding a direct-connection code path and a new self-protection surface beyond ADR-0001); rejected.
- **Splice the systemPrompt into state**: would preserve the existence hint, but injects an LLM-voiced system prompt into state, disturbing jev's calibration; rejected for v1, recorded as a known limitation.
- **Env-only credentials (the third-party pi-jev form)**: a second credential channel escapes `/logout` jurisdiction and stays invisible to auth.json; contradicts the "reuse pi's system" motivation; rejected. *(2026-09-19 note: the typesafe transport reads `TYPESAFE_API_KEY` env-only — pi offers no typesafe login to reuse — but through the provider auth pipeline; what was rejected is the bare-fetch escape from pi's provider system, not the absence of a login worth reusing.)*
- **Pin the version to `typesafe/jev-1.13`**: reproducible but requires manual version tracking; v1 uses the latest alias, with the actual snapshot observable through the response's `model` field.

## Consequences

- Package grows by one file; users who don't opt in merely load an inert extension (provider registration plus two event hooks, no requests).
- `classifierModel` semantics widen from "LLM provider/model" to "any model registered through pi"; CONTEXT.md is synced (jev adapter / typed decision / verdict prefix contract entries).
- jev's verdict quality is unverified against adversarial samples (the F-series review bypass cases); enabling it accepts its experimental nature; the rule layer (built-in floor + user deny + denyPaths) remains the primary defense — the classifier only takes the gray zone.
