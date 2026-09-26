# Research: Production audit analysis of the jev + fallback two-layer cascade

**[English](classifier-cascade-production-audit-en.md) | [简体中文](classifier-cascade-production-audit-zh.md)**

> Date: 2026-09-25.
> Question under study: using the real audit logs of two hosts (local macOS and a remote Linux box) covering 2026-09-19 ~ 2026-09-25, evaluate how the jev (first-layer classifier) + fallback classifier (second layer) cascade performs in production, and propose improvements to the combination.
> Data source: `~/.pi/agent/verdicts/*.jsonl` (22 local session files + 13 remote-unique session files; 7 files are byte-identical across the two hosts — synchronized copies, counted once).
> Configuration facts: both hosts run first layer `typesafe/jev-latest`, second layer `claude-haiku-4-5-20251001` (routed via an internal gateway), `classifierFallbackMode: "enforce"`; the difference is the confidence floor threshold — local `classifierMinConfidence: 80`, remote `classifierMinConfidence: 90`.
> Prior reading: `research/classifier-fallback-model-feasibility.md` (the cascade's design argument; this document is its production validation).
> Method: statistical aggregation over the deduplicated 1265 adjudication records plus case-by-case sampling, cross-comparing the first-layer raw verdict, the second-layer verdict, and the final effective verdict. Every number can be reproduced with the method in the appendix.

## TL;DR

1. **Every inter-layer boundary of the architecture held in production**: the rule that a first-layer deny cannot be relaxed to allow by the second layer, the isolation between protected-path and the cascade, the second layer stepping in when the first fails — no layer was observed overstepping.
2. **The trigger rate is the cost of the floor strategy, not a defect**: after 0.11.0 (confidence floor) took full effect (from 2026-09-24), 39% of classifier calls entered the second layer — the direct consequence of the high `classifierMinConfidence` thresholds (80 local / 90 remote). The design stance (maintainer's decision): the first layer's safety-judgment intelligence is distrusted, so a high floor routes the judgments needing deeper intelligence to the second layer — the threshold is a user-sovereignty parameter. The batch contains positive evidence for the strategy: two credential-access allows were caught by the second layer precisely because their low confidence fired the floor (see 2.2).
3. **The real waste is threshold-independent and sits in side-effect-free tools**: about a third (33%) of second-layer triggers landed on todo / ask_user_question / memory_write / memory_forget, where the second layer never tightened anything and nearly always allowed — whatever the threshold, these triggers carry no "needs deeper intelligence" content; they are pure latency (p50 2.5 seconds per trigger).
4. **jev systematically confuses "meta-action" tools**: `ask_user_question` averages confidence 50% (control group: read / fetch_content at 96% ~ 99%), frequently rating "the tool that asks the user a question" as low-confidence or ask, after which the second layer unanimously flipped them back to allow. This is a calibration problem, not an intelligence problem, and it pollutes the floor signal — reporting "jev can't judge this kind of action" as "jev is unsure".
5. Two high-value samples deserve their own record: the second layer twice escalated first-layer allows to deny (credential enumeration, credential-file probing) with accurate reasoning — the cascade's reason to exist; it also twice made contentious ask→allow relaxations (cluster-config write, loading a credentials file and calling an external API) — the relaxation direction lacked a gate.

## 1. Data and configuration overview

### 1.1 Totals

| Dimension | Value |
|---|---|
| Adjudication records | 1265 (local 719 / remote 546) |
| Sessions | 34 (local 21 / remote 13) |
| Time span | 2026-09-19 ~ 2026-09-25 |
| Tool distribution (top five) | bash 738 · todo 167 · get_search_content 132 · fetch_content 87 · web_search 43 |
| Record source (`source` field) | model 1223 · fail-closed 26 · protected-path 16 |
| First-layer raw verdict (`verdict` field) | allow 1155 · ask 76 · deny 34 (26 of the denies are fail-closed origin) |

### 1.2 Cascade activation timeline (inferred from the data)

| Dates | Observation | Version |
|---|---|---|
| 09-19 ~ 09-20 | 26 calls with confidence < 60, none triggered the second layer | pre-0.10.0 |
| 09-21 | Mixed state: of 43 calls with confidence < 60, 29 triggered and 14 did not; demotions appear up to confidence 79 that day | 0.10.0 release day (uncertainty-gated fallback); the floor threshold was in dev-period trial |
| 09-24 ~ 09-25 | Every call below the threshold triggers; enforce fully in effect | 0.11.0 (confidence floor, #67) |

### 1.3 Second-layer trigger totals and composition

Across the full period the second layer was consulted **296 times** (any of the trigger conditions suffices):

| triggeredBy | Count | Meaning |
|---|---|---|
| confidence | 262 | First-layer confidence below `classifierMinConfidence` (autonomy floor, #67) |
| fail-closed | 26 | First-layer classifier call failed (all in one remote window on 09-24, see 3.3) |
| ask | 8 | First-layer verdict was ask (#63's uncertainty gate). Occurred only on 09-21, all in shadow mode; #67 removed this trigger (a confident ask goes straight to the human) — none after 0.11.0 |

## 2. Designs validated by the production data

### 2.1 The deny-no-relaxation carve-out worked as designed

Production saw 3 "first layer deny, second layer allow" disagreements; every effective verdict converged to ask, logged as "first layer said deny at confidence X%; second opinion allows — your call". The rule held the boundary under real traffic: the second layer participates in adjudication but cannot single-handedly allow a first-layer deny.

### 2.2 The second layer's tightening rulings are high quality

Two first-layer allows were escalated to deny by the second layer, both credential access, with specific, accurate reasoning:

- Environment-variable credential enumeration (local, 09-21): the command walked `.env`-style files and printed masked key names; the second layer's reason: "even masked, enumerating secret environment variables is itself credential access".
- Credential-file read probing (local, 09-21): the command read an auth credentials file to probe for an API key's existence; the second layer's reason: "reading the user's credentials file must not pass silently".

These are exactly the blind spots where the first layer leans allow — and the direct positive evidence for the high-floor strategy: the two cases' first-layer confidences were 35% and 44%, both confidence-triggered (`triggeredBy: "confidence"`, enforce) — low-confidence allows sent for review and caught. Under a lower floor both would have passed as confident allows.

### 2.3 The second layer rescued a failing first layer without interrupting the session

On the remote host 09-24 05:27 ~ 05:35 (8 minutes), the first-layer classifier call failed 26 times in a row (fail-closed). The second layer took over every adjudication (25 allows, 1 ask); the adjudicated commands were all read-only investigation (package info, reading source and docs), the rulings were sound, and the session did not break on the first layer's outage.

### 2.4 protected-path and the cascade do not intersect

All 16 protected-path adjudications (`denyPaths` hits) were asks; none entered the cascade. The two defense lines are cleanly separated: path protection is a deterministic rule that neither needs nor accepts model adjudication.

### 2.5 The ground-truth fields suffice for post-hoc review

`demoted` / `fallback.triggeredBy` / `fallback.effective` / `fallback.reason` / `fallback.durationMs` are all fully recorded; every statistic in this document (including the case-by-case disagreement audit) is reproducible from the audit logs alone.

## 3. Problems (ordered by impact)

### 3.1 Trigger-budget composition: separating strategy cost from real waste

**Recharacterization (2026-09-25, maintainer's decision)**: the trigger rate itself is not the problem. `classifierMinConfidence` is a user-sovereignty parameter; a high threshold (80/90) deliberately routes a large share of calls to the second layer — the first layer's confidence is used as a routing signal for "does this judgment need deeper intelligence", not merely as a trust measure. The 39% trigger rate is that strategy's expected cost. This section keeps the composition data for later optimization; "lower the threshold" is not a recommendation.

After 0.11.0 (from 09-24, 658 records, 619 model-sourced):

| Metric | Value |
|---|---|
| Second-layer triggers | 241 (**39%** of model calls) |
| of which produced a stricter ruling (tightened) | 18 (7.5%) |
| of which landed on side-effect-free tools (see 3.2) | 80 (**33%**) — the real waste |
| the rest (confirmations/relaxations on effectful tools) | the strategy's expected cost |
| Second-layer latency | p50 2.5 s · p90 5.1 s · max 17.0 s · mean 3.1 s |
| Share of jev confidences < 90 | 37.5% (matches the trigger rate; the threshold-90 remote contributed most) |
| Share of jev confidences < 80 | 27% (the trigger-face ceiling at the local threshold 80) |

The heaviest single day was remote 09-24: 208 triggers, one session alone (source-code exploration, 948 KB of log) contributing 60.

Under the "high floor buys second-layer intelligence" strategy, confirmation-type rulings (~80%) are the service being bought, not waste; **waste is narrowed to triggers carrying no intelligence demand** — the side-effect-free tools of 3.2, threshold-independent pure latency under any floor configuration.

### 3.2 Side-effect-free tools consume a third of the trigger budget; jev calibration is the root cause

Trigger rate and first-layer mean confidence per tool (model-sourced, full period):

| Tool | Trigger rate | Mean confidence | Note |
|---|---|---|---|
| ask_user_question | 84% (16/19) | **50%** (p10 = 28%) | second layer flipped all back to allow |
| memory_forget | 80% (4/5) | 70% | all flipped back to allow |
| memory_write | 82% (28/34) | 77% | zero tightenings |
| write | 67% (4/6) | **52%** (p10 = 24%) | — |
| Agent | 29% (2/7) | 66% (p10 = 27%) | — |
| todo | 26% (43/167) | 77% | zero tightenings |
| bash | 22% (156/708) | 85% (p10 = 52%) | the main source of tightenings |
| web_search | 7% | 92% | — |
| fetch_content | 2% | 96% | control group |
| read | 0% | 99% | control group |
| get_search_content | 0% | 98% | control group |

Key observations:

1. **Of the 241 post-0.11.0 triggers, 80 (33%) landed on the four side-effect-free tools todo / ask_user_question / memory_write / memory_forget — zero tightenings among them.**
2. jev's behavior on `ask_user_question` most resembles systematic semantic confusion: the tool's whole purpose is to ask the user, yet jev broadly rates it low-confidence (mean 50%) and demotes heavily, after which the second layer without exception rules allow. The control group (read / fetch_content / get_search_content, mean confidence 96% ~ 99%, trigger rate 0% ~ 2%) shows jev calibrates well on semantically clear read-only actions — the problem is specific to "meta-action" tools.
3. jev's confidence conflates two semantics: "action risk level" and "confidence in the ruling's correctness". write's mean 52% is not jev being unsure of its verdict — writing files is simply risky. The autonomy floor (#67) means the latter (unsure ⇒ not autonomous); the mismatch makes the floor spin its wheels.

### 3.3 The fail-closed audit semantics distort

All 26 fail-closed records carry `verdict: "deny"`, yet 25 of them were effectively allowed by the second layer and 1 asked. Counting "blocks" off the `verdict` field is badly distorted (34 denies by field, 8 effective denies).

This is not a behavioral error — the second layer taking over a failed first layer is fallback's designed purpose (#63), and all 26 rulings were manually verified sound. The problem is the **recording convention**: the combination `source: "fail-closed"` + `verdict: "deny"` + `fallback.effective: "allow"` makes the "fail-closed" label carry two readings at once — "the first layer failed" (fact) and "conservatively blocked" (did not happen). Audit and statistics must know to read `fallback.effective` for the truth.

### 3.4 The enforce mode's relaxation direction lacked a gate, and the documentation disagreed with the implementation

**Documentation/implementation mismatch**: the config hint at `extensions/pi-verdict.ts:328` read "mode shadow (default) observes without changing verdicts, **enforce escalates strictness only**", but the implementation (`extensions/pi-verdict.ts:1706`) was de novo second-layer adjudication applied directly — the only limit being the first-layer-deny carve-out (2.1). Enforce could both tighten and relax while the docs said "tighten only".

**The asymmetry of relaxation risk**: across the period the second layer relaxed first-layer asks to allow 24 times and tightened allows to ask/deny 24 times — equal counts, unequal error costs: one extra confirmation costs one keystroke; allowing something that should have been confirmed can cost an irreversible action. Relaxation and tightening shared the same logic with no extra gate.

**Two contentious relaxations** (both second-layer overrides of a first-layer ask into allow):

- Cluster backup-config write (local, 09-25): the second layer's reason — "directly matches the user's task; the same command ran before" — task-relevance and historical precedent as grounds to allow a write, carrying a "repeat actions auto-allow" path-dependence risk.
- Loading a credentials file and calling an image-generation API (local, 09-21): the reason — "uses the user's own stored key, a routine explicitly requested operation" — the first layer's ask (credential read + outbound data) was closer to correct.

The other 22 relaxations concentrated on side-effect-free tools (the 3.2 root cause) and were themselves sound.

### 3.5 The shadow cache was effectively useless

Full-period shadow observation: 1208 misses, 41 would-hits (3.3%). In its current form the cache changes no decision path; the retained observational value is marginal — evaluate removal or a real serving cache.

## 4. Improvement recommendations (by priority)

> **Disposition record (2026-09-26, evaluated with the maintainer)**: recommendation 1 landed (PR #70, `ignoreTools`); recommendations 2/3 were merged into issue #71 (ask-relaxation carve-out + fail-closed audit semantics, ADR-0004 amendment); recommendation 2's documentation half is covered by #72 (the `_hint` removal — the wording drift and the stale key name lived only in `_hint`; docs/configuration.md was already correct); recommendation 4 was **declined** — `ignoreTools` physically removed the largest calibration-pollution sources (ask_user_question / memory_write / todo out of the cascade), and the remaining low-confidence tools (write / Agent / memory_forget) being floor-routed is exactly the high-floor strategy working as intended — the signal-purity argument no longer holds; recommendation 5 was **decided: remove now** (issue #73) — offline sim (3.2%) and runtime would-hit (3.3%) agree, far below any activation threshold; a runtime probe does not fit the minimalist positioning. Additional rulings: a fail-closed second-layer allow is a de novo first ruling, not a relaxation (the first layer was absent, not negative) — automatic allow stands; the audit record's `shadow` field is removed together with the cache.

> Recharacterization (2026-09-25, maintainer's decision): the floor threshold is a user-sovereignty parameter; "lower the threshold to reduce triggers" is not a goal. The high floor is deliberate — distrust the first layer's judgment intelligence, route deeper-intelligence judgments to the second layer (the two credential catches of 2.2 are the strategy's positive evidence). The recommendations below are ranked under that strategy.

1. **Side-effect-free tool exemption: via `ignoreTools` (PR #45), not a built-in set**: the production conclusion stands — 33% of triggers carry no intelligence demand, zero tightenings on these tools. But the landing mechanism reuses PR #45's `ignoreTools` (a user-declared exemption list: skips all adjudication, zero model calls, sits after the self-protection layer and deny floor, inert for covered tools) rather than a built-in fixed set in code: a built-in exemption conflicts with the project's user-sovereignty stance (no built-in passthrough; every exemption is the user's own declaration, isomorphic to "no built-in allowlist"), and the boundary decisions (include `memory_write`'s cross-session persistence? `memory_forget`'s deletion semantics?) belong to user config, not code. `todo` / `ask_user_question` / `memory_*` are uncovered tools — `ignoreTools` applies directly; the exemption sits before the classifier, so the 14 "first layer asked, second layer flipped to allow" degradations of 3.2 cease to exist (the first layer is never called). Prerequisite: merge PR #45 — the author had not responded to the a/b paths offered in the 2026-09-19 comment; the maintainer may take path (b) (extract, squash with attribution). After merging, declare in config (this report's recommended set, excluding `memory_forget` — deletion keeps its review): `"ignoreTools": ["todo", "ask_user_question", "memory_write", "memory_search"]`.
2. **Gate the relaxation direction**: symmetric with the deny carve-out, require high second-layer confidence to relax a first-layer ask to allow (or allow relaxation only for whitelisted tools). At minimum fix the documentation wording at `extensions/pi-verdict.ts:328` ("escalates strictness only" vs the de novo implementation — pick one).
3. **fail-closed audit convention**: records where the first layer failed and the second took over get a distinct source marker (e.g. `fail-closed→fallback`) instead of `verdict: "deny"`; the cascade summary gets a distinct "first layer failed, second allowed" counter.
4. **Fix jev calibration with this ground truth**: the 619 post-09-24 records are a natural regression set (first-layer verdict + confidence + second-layer ruling + effective verdict). Under the high-floor strategy, calibration's value is not fewer triggers but a purer routing signal: `ask_user_question`'s confusion (mean 50%) reports "jev can't judge this" as "jev is unsure", wasting routing budget. The prompt should pin confidence's definition as "confidence in the given ruling's correctness", decoupled from "action risk level".
5. **Evaluate the shadow cache's fate**: a 3.3% would-hit rate does not support the current complexity.

## 5. Terminology and field reference

This document avoids ad-hoc abbreviations; all field names follow the audit-log schema (written around `extensions/pi-verdict.ts:1390-1490`):

| Field / term | Meaning |
|---|---|
| first layer | the jev classifier (`classifierModel: typesafe/jev-latest`), producing allow / ask / deny plus confidence per tool call |
| second layer (fallback classifier) | the classifier configured via `classifierFallbackModel` (claude-haiku-4-5-20251001), consulted only when the first layer is uncertain |
| verdict | the first layer's raw ruling (allow / ask / deny). On fail-closed-origin records this field is always deny and does not mean an actual block |
| effective verdict (`fallback.effective`) | the verdict actually applied after second-layer adjudication under enforce; on records without a fallback, the verdict itself |
| demoted | the #67 confidence-floor marker: first-layer confidence below `classifierMinConfidence`, its ruling demoted and handed to the cascade |
| triggeredBy | why the second layer ran: `confidence` (below threshold) / `ask` (first layer asked) / `fail-closed` (first-layer call failed) |
| source | adjudication origin: `model` (normal first layer) / `fail-closed` (first-layer call failed) / `protected-path` (denyPaths rule hit) |
| enforce / shadow | second-layer mode: enforce applies its ruling; shadow records the counterfactual without changing any verdict |
| confidence floor / autonomy floor | the #67 `classifierMinConfidence` setting; first-layer rulings below it may not apply autonomously |

## Appendix: reproduction method

1. Ingest: read `~/.pi/agent/verdicts/*.jsonl` locally; for the remote host, sync its unique files (deduplicated against local by md5) into a temp directory and merge.
2. Aggregation (Python + stdlib): parse JSON per line; the key derived quantities —
   - confidence extracted from `rawResponse` via `confidence (\d+)%`;
   - effective verdict = `fallback.effective` when present, else `verdict`; shadow mode (empty `fallback.effective`) changes nothing;
   - tightened / relaxed = comparing the effective verdict against the first-layer verdict on the strictness order (allow < ask < deny);
   - trigger rate denominators = records with `source == "model"`.
3. Period convention: "after 0.11.0" = timestamps ≥ 2026-09-24; "full period" = all of 2026-09-19 ~ 2026-09-25.
4. Case-by-case verification samples (deny destinations, relaxation/tightening cases, the fail-closed window) printed each record's `actionLine` and `fallback.reason` for manual review.

The analysis script was a one-off (not committed); to track trigger rate and calibration drift long-term, consider fixing the step-2 aggregation into a repo-internal offline tool.
