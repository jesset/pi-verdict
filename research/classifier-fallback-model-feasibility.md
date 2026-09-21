# Research: A second-layer ClassifierFallbackModel — feasible, and in what shape?

> Date: 2026-09-20
> Question under study (user proposal): add a `ClassifierFallbackModel` on top of the current
> `classifierModel` (jev). Two shapes proposed: (a) a fallback that adjudicates the requests the
> first layer cannot decide, trading efficiency for accuracy while reducing human distraction;
> (b) an evaluator model that judges whether the first layer's verdict is reliable and issues
> the final recommendation. Analysis grounded in the audit corpus at `~/.pi/agent/verdicts/`.
> Method: repo source reading + statistical analysis of the local audit JSONL + first-hand
> external sources (papers, production router docs). No source code was modified.

## TL;DR

1. **Worth continuing — but neither proposed shape as stated.** The data supports an
   **uncertainty-gated cascade** (the standard shape in the literature): first layer (jev,
   ~1.2s, ~$0.000015/call) decides everything; a stronger second-layer model is consulted
   **only when the first layer signals uncertainty** (low confidence / low top-choice
   probability / `ask`). This is shape (a) and (b) fused: the escalation *trigger* is the
   first layer's self-reported uncertainty; the escalated call *is* a second opinion.
2. **The premise "jev lacks judgment" is only half-true — and the half that is true points
   at a cheaper fix first.** jev already emits calibrated probabilities + confidence
   (RLCD-trained). The pipeline consumes only `choice` and discards the rest
   (`extensions/jev-adapter.ts:165-179`): in the corpus, **23 of 403 jev `allow`s carried
   confidence < 50% — several with deny-probability ≥ 35% — and every one was allowed**.
   The uncertainty signal exists and is free; it is simply unused.
3. **The stated goal "reduce human distraction" has a small ceiling.** `ask` verdicts are
   21/646 (3.3%) across 2 days (~10 confirmations/day). A fallback that only rescues `ask`
   (shape (a) as stated) saves at most that much. The real risk surface is the opposite
   direction: **low-confidence allows**, which shape (a) as stated does not touch.
4. **Shape (b) as stated (judge every verdict) is not supported**: double cost/latency on
   all gray-zone calls, LLM-as-judge has documented failure modes (position/verbosity/
   self-enhancement bias; ~80% human agreement for a frontier judge), and both layers read
   the same transcript — adversarial content that fools one may fool both. Judging only the
   uncertain subset inherits the benefit without most of the cost.
5. **A natural A/B already exists in the corpus**: 2026-09-19 ran jev (417 calls), 2026-09-20
   ran claude-haiku-4.5 (229 calls). The stronger model is measurably more conservative
   (5.2% vs 3.4% non-allow) with high-quality ask rationales — evidence that a cheap strong
   second layer (haiku-class) adds real adjudication depth, and also that it over-blocks
   (2 of its 3 denies read as `ask`s semantically). A second layer is a better *tie-breaker*
   than a replacement *oracle*.
6. **Recommended next step (minimal experiment, no behavior change)**: extend the audit
   record with (i) the user's response to each `ask` (ground truth — currently unrecorded)
   and (ii) a shadow escalation column: when the trigger fires, call the fallback model
   observe-only and log its verdict next to the real one (the shadow-cache precedent, #7).
   Two weeks of that data decides whether the cascade should go live, and with which
   threshold. A config knob change alone (`classifierModel: typesafe/jev-latest` → an LLM)
   is also already available today for users who prefer judgment over speed.

---

## 1. Current architecture (source citations)

Pipeline (`adjudicate`, `extensions/pi-verdict.ts:1536-1600`):

- Layer 0 self-protection → layer 1 rule floor (bash danger regexes, path sensitivity
  S0–S5, user deny) → denyPaths terminal `ask` → user allow → gray zone → classifier.
- Gray-zone classifier is a **single model, single value**: `classifierModel` in
  `pi-verdict.json` (CLI flag > env > config > session model) resolved per call
  (`extensions/pi-verdict.ts:1778-1797`). There is exactly one classifier and no notion of
  a second tier.
- Output contract is three-state `<verdict>allow|ask|deny</verdict>`
  (`extensions/pi-verdict.ts:951-963, 1039-1044`); `ask` → `ctx.ui.confirm` (human);
  non-interactive `ask` degrades to deny; classifier failure/timeout (25s) → fail-closed
  deny (`extensions/pi-verdict.ts:1054, 1243`).
- jev rides a custom provider registered as `typesafe/jev-latest`
  (`extensions/jev-adapter.ts:268-305`); its decisions API returns `choice +
  probabilities + confidence`, which the adapter flattens into the contract text
  `jev: allow 54% (confidence 31%; ask 15%, deny 31%)`
  (`extensions/jev-adapter.ts:165-179`). **Only `choice` feeds the verdict; the
  probabilities/confidence travel only into the human-readable reason string.**
- Known limitation (`extensions/jev-adapter.ts:29-33`): the classifier system prompt —
  including the denyPaths existence hint (`extensions/pi-verdict.ts:971-972`) — does not
  reach jev; jev treats state as data and "does not treat it as hostile by default."
  An LLM second layer *would* receive the full system prompt including the hint.
- Feasibility of a second call inside the permission hook: already proven — the
  classifier path goes through `modelRegistry.find()` + `hasConfiguredAuth()` + a bound
  `complete()` (`extensions/pi-verdict.ts:1084-1125, 1787-1788`) and accepts any
  registered provider/id; the jev adapter demonstrates registering an entirely custom
  provider. **No ExtensionAPI blocker exists**; the change is a config field + a cascade
  segment in `adjudicate`. One real constraint: two sequential 25s timeout budgets could
  stack to 50s in the worst case — the fallback tier needs its own (shorter) budget or a
  shared deadline.
- Precedent inside this repo: `research/typesafe-jev-classifiermodel.md` already noted
  (2026-09-18) that the boundary case `rm -rf /tmp/build` → deny p=0.64 / **conf=0.29**
  "恰好支持 confidence-gated ask 策略" — the confidence-gated idea predates this report;
  the audit corpus below turns that hypothesis into measurements.

## 2. Empirical analysis of the audit corpus

Corpus: `~/.pi/agent/verdicts/`, 15 session files, **646 gray-zone adjudications**,
2026-09-19T09:18Z → 2026-09-20T11:43Z (~26.5h wall). Statistics computed over the full
JSONL; no raw record content is reproduced here (the corpus carries personal data; this
report is written for the public repo — only aggregate numbers and redacted patterns).

### 2.1 Headline distribution

| metric | value |
|---|---|
| total gray-zone calls | 646 (15 sessions) |
| verdicts | allow 620 (96.0%) · ask 21 (3.3%) · deny 5 (0.8%, of which 3 are degraded asks, 1 fail-closed, 1 model deny) |
| models | jev-latest 417 · claude-haiku-4.5 229 (clean temporal split: 09-19 ≈ all-jev, 09-20 ≈ all-haiku) |
| tool mix | bash 337 · get_search_content 129 · todo 94 · fetch_content 38 · web_search 31 · misc 17 |
| `ask` by tool | bash 10 · todo 5 · ask_user_question 4 · write 1 · web_search 1 |

### 2.2 The premise check: is jev "under-judging"?

Parsing the jev reason strings (`jev: <choice> X% (confidence Y%; ask Z%, deny W%)`)
yields 403 parseable jev outcomes. All 403 top-choices were `allow` — jev never emitted
`ask`/`deny` as its top choice in this corpus... except the 12 recorded `ask`s, which are
top-choice asks with low confidence (e.g. `ask 59% (confidence 38%)`). So jev *does* route
some cases to the human; the failure mode is the other direction:

- **Confidence distribution**: min 12%, p10 58%, median 94%, p90 100%.
  conf < 30%: 2.2% · conf < 50%: 5.7% (23 calls) · conf < 70%: 18.1% (73 calls).
- **All 23 conf<50% calls ended `allow`** — several carrying `deny%` of 35–43% or
  `ask%` ≥ 36% (bash commands). I.e. jev flagged substantial doubt in its own
  probabilities and the pipeline waved the action through on the strength of `choice`
  alone. This is the sharpest evidence for the proposal's premise — but note it indicts
  the **pipeline's consumption of jev's output**, not necessarily jev itself.
- Natural control (haiku, 229 calls): non-allow rate 5.2% (9 ask + 3 deny) vs jev 3.4%
  (12 ask + 1 deny + 1 fail-closed). haiku's ask rationales are specific and actionable
  (credential-bearing config reads, security-setting writes). Its 3 denies include 2
  that read semantically as `ask` (network download to /tmp judged too harshly) — a
  stronger model is a better *adjudicator*, not a perfect one.
- 1 fail-closed (jev aborted at the 25s timeout): cascades must treat this as an
  escalation trigger too, not just low confidence.

### 2.3 The distraction ceiling

Human-facing burden today = the 21 `ask` confirms ≈ **10/day**. A fallback that only
rescues `ask` (shape (a) as stated) has that ceiling. Meanwhile 5 of 21 asks are the
`todo` tool — a trivially-safe tool that reaches the classifier only because
`toolKind()` (`extensions/pi-verdict.ts:460-475`) doesn't cover it and no user allow
regex matches it. **Rule-layer coverage of benign built-in tools is a cheaper fix for
~24% of current asks than any second model.**

### 2.4 What the corpus cannot tell us (data gaps)

- **No ground truth**: the audit record (`AuditRecord`,
  `extensions/pi-verdict.ts:1376-1392`) does not capture what the user answered to the
  `ask` confirm. Without it, false-allow/false-deny rates of the first layer (and any
  second layer) are unmeasurable. This blocks evaluating shape (b) at all ("is the first
  layer's verdict reliable?" — reliable against what?).
- **No per-call latency field**. jev's measured ~1.2–1.3s end-to-end comes from the
  earlier live test (`research/typesafe-jev-classifiermodel.md`), not this corpus; LLM
  classifier p90 ≈ 19.8s likewise (cache-sim research, cited at
  `extensions/pi-verdict.ts:1054`).
- Two days, one user, one config. Directionally strong, statistically small; thresholds
  must be validated by the shadow experiment (§5), not read off this corpus.

## 3. Prior art (first-hand sources)

- **FrugalGPT** (Chen, Zaharia, Zou; arXiv:2305.05176): the LLM cascade — cheap models
  answer easy queries, a stronger model is consulted for the rest; headline result up to
  98% cost reduction at GPT-4-matching accuracy. The canonical argument for exactly the
  architecture proposed here. <https://arxiv.org/abs/2305.05176>
- **RouteLLM** (Ong et al., LMSYS/UC Berkeley; arXiv:2406.18665): routers dynamically
  select between a stronger and a weaker LLM per query; >2× cost cuts with no quality
  loss in some settings; routers transfer when the model pair is swapped — i.e. the
  *router policy* (here: jev's own confidence) is the durable asset.
  <https://arxiv.org/abs/2406.18665>
- **LLM-as-judge reliability** (Zheng et al.; arXiv:2306.05685): judges exhibit
  position, verbosity, and self-enhancement biases; GPT-4-as-judge reaches ~80%
  agreement with humans (human–human agreement level). Judge quality is real but
  bounded — argues for judging the *uncertain subset*, not everything.
  <https://arxiv.org/abs/2306.05685>
- **Production routing practice** (OpenRouter model-routing docs): the Auto Router runs
  "a fast, lightweight classifier" per prompt, then routes within a cost band, with the
  surviving ranked candidates forming "the primary pick plus fallbacks" —
  cheap-classifier-first + fallback chain is the deployed norm, not a research curiosity.
  <https://openrouter.ai/docs/features/model-routing>
- Security-context note: permission-gating cascades specifically have little published
  practice (guardrail systems mostly ship a single classifier + threshold); the closest
  public analog is uncertainty-triggered escalation in routing generally. The dual-layer
  *arbitration* pattern in security (e.g. two AV engines) exists, but for LLM judges the
  shared-transcript correlated-failure problem (§4b) is the known weakness.

## 4. Evaluation of the two proposed shapes

### (a) Fallback for what the first layer cannot decide

- *As stated* (fallback consumes the `ask`s): weak. Ceiling ≈ 10 confirmations/day
  (§2.3); those asks are already the cases where jev was appropriately cautious, and
  9/21 are todo/ask_user_question noise better fixed in the rule layer.
- *Restated on the evidence* (fallback consumes **low-confidence outcomes** — conf <
  threshold, or top-choice probability < threshold, or `ask`, or fail-closed): strong.
  Trigger surface at conf<50% ≈ 5.7% of calls (~28 calls over the corpus), at conf<70%
  ≈ 18%. Every one of the conf<50% allows (§2.2) would have gotten a second opinion.
- Cost: at a ~6–18% trigger rate and haiku-class pricing, negligible; added latency
  (seconds) paid only on triggered calls. jev stays the 94%-ile fast path.
- Failure mode to design against: the second layer **false-allows** under the same
  prompt-injection that fooled the first (both read the same transcript; jev additionally
  "does not treat state as hostile", `extensions/jev-adapter.ts:31-32`). Mitigation is
  directional: see the safety ratchet in §5. A cascade raises *resolution*, it is not an
  injection defense — the rule floor and self-protection layer remain the deterministic
  backbone.

### (b) Evaluator/judge of every first-layer verdict

- Cost/latency double on 100% of gray calls for a benefit concentrated on the ≤ 20% where
  the first layer is unsure — FrugalGPT's whole result is that this is the wrong place
  to spend.
- Judge reliability is real but bounded (~80% human agreement at the frontier; known
  biases), and the judge sees no more evidence than the first layer — no independent
  information channel, so correlated errors dominate exactly on adversarial inputs.
- What (b) adds over uncertainty-gated escalation: it would also catch **confidently
  wrong** first-layer verdicts (high confidence, wrong answer). The corpus shows jev
  confidence is usually high when it allows (median 94%) — whether those confident allows
  are *right* is exactly the ground-truth gap (§2.4). The honest answer: buy the
  ground-truth field first ($0), and let shadow data reveal whether confident-wrong
  allows are frequent enough to justify judging beyond the uncertain set.

## 5. Recommended shape and minimal experiment

**Design: uncertainty-gated cascade (config: `classifierFallbackModel`, null = off).**

1. **Trigger** (any of): jev `confidence < T_conf` · top-choice `probability < T_choice`
   (when the classifier exposes one) · verdict `ask` · classifier fail-closed/timeout.
   Start at T_conf = 50% (corpus: 5.7% of jev calls).
2. **Safety ratchet** (one-directional conservatism): the fallback may hold or *raise*
   the caution level (allow→ask, allow→deny, ask→deny) but never lower it. A
   fallback `allow` upgrades the first layer's low-confidence allow to a confident
   two-model allow; a fallback `ask`/`deny` wins outright. This bounds the worst case
   (second layer fooled) at "no worse than today's single-layer behavior on that call".
3. **Fallback model**: an LLM (haiku-class), which uniquely benefits from receiving the
   full `CLASSIFIER_SYSTEM` + denyPaths existence hint that never reaches jev
   (`extensions/jev-adapter.ts:29-33`) — the second layer is also the only layer that
   can act on protected-path vigilance.
4. **Timeout budget**: fallback tier gets its own, shorter deadline (e.g. 15s) so the
   worst case stays well under the current 25s+25s stack; fail-closed semantics
   unchanged.
5. **Audit**: extend `AuditRecord` with the trigger reason, fallback verdict + reason,
   and — separately, unconditionally — **the user's answer to every `ask`**
   (ground truth; also valuable without any cascade).
6. **Rollout**: ship as **shadow escalation first** (observe-only, the #7 shadow-cache
   precedent): the fallback call fires on trigger, its verdict is logged, nothing
   applies. Two weeks of paired records answer: trigger rate, agreement rate,
   would-have-changed-outcome count, and the latency/cost actually paid. Then decide
   live-vs-drop with numbers.

**Do first regardless (cheap, independent wins):**

- Add benign built-in tools (`todo`, `ask_user_question`… subject to per-tool risk
  review) to the rule layer or document an allow-regex pattern — retires ~24% of
  current asks without any model change.
- Add the ground-truth field (§5.5) — it costs one line in the confirm handlers and
  unblocks every future quality question, including shape (b).

## 6. Alternatives considered

| alternative | verdict |
|---|---|
| Confidence threshold → direct `ask` (no second model) | Free, but converts uncertainty into exactly the human distraction the proposal wants to reduce (conf<50% alone ≈ 11 extra asks over the corpus — a ~50% increase over today's 21). The fallback model's entire purpose is to absorb that. |
| Swap first layer to haiku outright | Available today via `classifierModel` (a one-line config change); forfeits jev's ~1.2s/~free fast path for the 82–94% of calls that need no depth. The cascade is precisely the literature's answer to this tradeoff. |
| Prompt engineering on the first layer | Inapplicable to jev — the system prompt (incl. denyPaths hint) does not reach it (`extensions/jev-adapter.ts:29-33`). Applies only if the first layer is an LLM. |
| More rules instead of models | Right tool for the todo/ask_user_question ask-noise; cannot express "this bash command is 60% fine" — the gray zone is irreducibly probabilistic. |

## 7. Conclusion

Proceed, reshaped: implement the **uncertainty-gated cascade** (trigger on jev's
already-emitted confidence + `ask` + fail-closed; safety ratchet; shadow-first rollout),
with the ground-truth audit field and the benign-tools rule fix landed first or together.
Shape (a) as literally proposed (fallback for asks only) and shape (b) (judge everything)
are both dominated by this middle shape on the corpus evidence and the literature; revisit
(b)'s extra value only if shadow data shows confidently-wrong first-layer allows are
common once ground truth exists.

## Sources

- Repo: `extensions/pi-verdict.ts` (pipeline 1536-1600; classifier config 1778-1797;
  timeout 1054; audit record 1376-1392; rule families 460-475), `extensions/jev-adapter.ts`
  (probabilities flattening 165-179; prompt-not-reaching-jev limitation 29-33),
  `research/typesafe-jev-classifiermodel.md` (jev latency/cost, confidence-gated
  hypothesis), `extensions/pi-verdict.ts:1054` citing `research/cache-sim` (LLM p90).
- Data: `~/.pi/agent/verdicts/*.jsonl` — 646 records, 2026-09-19/20, aggregate statistics
  computed by script (counts, verdict×source×model cross-tabs, parsed jev
  confidence/probability distributions); no raw record content reproduced.
- arXiv:2305.05176 (FrugalGPT), arXiv:2406.18665 (RouteLLM), arXiv:2306.05685
  (Judging LLM-as-a-Judge), OpenRouter model-routing docs.
