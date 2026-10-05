# Research: Ask-friction and safety audit of 10 production sessions (0.13.x / 0.14.0)

> Date: 2026-10-05.
> Question under study: what do the most recent 10 sessions of local audit logs say about (a) where ask verdicts actually come from and how much of that friction is avoidable, and (b) whether the gate held on the safety side — including what leaks into the audit trail itself.
> Data source: the 10 most recent files in `~/.pi/agent/verdicts/` (sessions 2026-10-01 ~ 2026-10-04), 658 adjudication records, all on the pi ≥ 0.99 line (0.13.0 → 0.14.0).
> Configuration facts: first layer `typesafe/jev-latest`, fallback `cloudark/deepseek-flash` in `enforce` mode, `classifierMinConfidence: 90`, `audit: true`. `ignoreTools` already covers `todo` / `ask_user_question` / `web_search` / `fetch_content` / `memory_write` / `memory_search`.
> Prior reading: `research/classifier-cascade-production-audit-en.md` (2026-09-25, the cascade's first production validation; this document is its follow-up on ask friction specifically).

## TL;DR

1. **The top-level `verdict` field understates real ask friction by ~2×.** First-layer semantics say allow 595 / ask 38 / deny 25, but the *effective* verdicts the user experienced were **allow 581 (88.3%) / ask 72 (10.9%) / deny 5 (0.8%)**. The gap: the #71 carve-out (a fallback allow may not relax a negative first-layer verdict) converts 24 first-layer denies into asks. One user confirm out of nine tool calls is the lived reality behind "asks too much".
2. **Roughly two thirds of the 72 asks are low-value confirmations**, clustered in three repeating shapes: (a) ~20 commands carrying a hardcoded internal-service API key (Langfuse diagnostics, one evening of work), (b) ~16 release-workflow chains (`git push` / `gh pr merge` / branch deletes / version bump / release-note writes), (c) ~5 `kubectl exec` diagnostics. The same command shapes recur within a session — the Langfuse session confirmed near-identical key-bearing commands ~18 times in 30 minutes.
3. **Adjudication is inconsistent across near-identical commands.** `gh pr merge …` appeared 5 times across the batch: 3 × effective allow, 2 × effective ask. Release-note `write` calls: 3 allow, 2 ask. Unpredictability costs more trust than a stable ask would.
4. **The safety side held where it was tested, with one real catch and one real hole.** The fallback vetoed three first-layer allows that read `~/.ssh/config` and `~/.zshrc` into the transcript — the cascade's reason to exist, working. But `pkill -f …` never enters the danger floor (7 allows observed), and — more urgently — **the audit log itself stores hardcoded secrets in plaintext**: the Langfuse `sk-lf-…` key sits verbatim in ~18 verdicts records on disk.
5. **One subagent false-positive confirmed end-to-end**: a headless (no-UI) subagent `write` to pi's own `sessions/…/subagent-artifacts/` path gathered an effective ask, which the no-UI convention degrades to deny (`degraded: true`) — the subagent's work fails with no human in the loop and no appeal path.
6. **Approval-rate ground truth (correction, 2026-10-05)**: an earlier draft of this report claimed the user's response to each ask is unrecorded — that was wrong. #62 already lands `userAnswer`/`answeredAt` at the ask finalize (the survey script initially overlooked the field). The real numbers, stronger than any inference: of 71 asks with a recorded answer across these 10 sessions, **70 were allowed and 1 declined — and the single decline is the denyPaths rule layer's `.zshrc` read**. Every model-layer ask was approved. The friction estimate above is not an estimate; it is measured: from the classifier's perspective, essentially none of its asks ever stops anything the user wanted stopped.

## 1. Data overview

| Dimension | Value |
|---|---|
| Sessions / records | 10 / 658 (10-01 ~ 10-04) |
| Top-level verdict (first-layer semantics) | allow 595 (90.4%) · ask 38 (5.8%) · deny 25 (3.8%) |
| **Effective verdict (what the user saw)** | **allow 581 (88.3%) · ask 72 (10.9%) · deny 5 (0.8%)** |
| Records with a second-layer run | 229 (34.8%) |
| Second-layer transition table | allow→allow 154 · ask→ask 35 · **deny→ask 24** · allow→ask 11 · **allow→deny 3** · ask→deny 1 · deny→deny 1 |
| Tools (top) | bash 562 · write 24 · subagent 22 · codemode 16 |
| cwd (top) | pi-verdict 403 · RamDisk 112 · pi-provider-litellm-oidc 58 · pi-vetter 45 · cloudark-k8s-manifests 40 |
| Fallback latency | ~1.4 s – 6.5 s per second-layer call |
| `degraded` records | 1 (the subagent case, §5) |
| Built-in danger-floor hits | 0 (all 25 top-level denies are classifier-source; the floor never fired in this batch) |

Note on method: "effective" is computed from `fallback.effective` when present, else the top-level verdict — mirroring `runConfidenceCascade` + the ask-degradation convention in `extensions/pi-verdict.ts`. Ask counts below are clustered by hand from the command text (approximate per-cluster counts; the script in the appendix reproduces the totals exactly).

The 2026-09-25 audit's top finding — a third of second-layer triggers wasted on side-effect-free tools (`todo`, `ask_user_question`, …) — is **confirmed fixed**: those tools are absent from this batch's flow entirely (the `ignoreTools` adoption closed the loop; the remaining `memory_forget` × 3 all passed first-layer at high confidence).

## 2. Where the 72 asks actually came from

| Cluster | ~Count | Layer origin | Legitimacy call |
|---|---|---|---|
| Langfuse diagnostics with hardcoded `pk-lf/sk-lf` key (`curl -u`, `export LANGFUSE_*`) | 20 | jev deny → fb allow → ask (carve-out) | Defensible per-command (secret in command text), absurd as a session-level experience |
| Release workflow (`git push`, `gh pr merge`, `git push --delete`, branch `-d/-D`, version bump via `python3`, release-note `write`) | 16 | mixed jev ask / allow→fb ask | The single biggest avoidable cost; identical shapes flip between allow and ask (§3) |
| `kubectl exec` into ClickHouse for read-only `SHOW`/`SELECT` diagnostics | 5 | jev deny → fb allow → ask | Arguably fine as ask; the k8s-debugging convention (port-forward + local curl) would have avoided them |
| Reading pi's own config under `~/.pi/agent/` (`models-store.json`, `pi-vetter/config.json`, `langfuse.json`) | 4 | jev ask / deny → ask | Over-conservative: agent-owned runtime config, several calls even redact keys before printing |
| Local test prep (`rsync` project → RamDisk clone, run typecheck there) | 3 | jev ask → fb ask | False positives: pure-local, reversible, no network |
| denyPaths semantics (`read ~/.zshrc`, test-file edit via embedded `python3`) | 3 | rule layer (protected-path) | Expected — user-declared |
| Genuinely high-stakes (codemode nested `rm -rf`, `kubectl patch` PVC resize, socket.dev key probe, `curl` with bearer key) | ~8 | mixed | Correct asks; keep |

Two structural observations follow. First, **the fallback is the de facto adjudicator of every negative-leaning call**: 34.8% of calls dropped below the 90 floor, and no first-layer deny survived as deny (deny→deny = 1, vs deny→ask = 24). The maintainers' 09-25 stance — the floor routes judgment to the second layer — now routes nearly all *denial* authority there too; jev's denies function as "escalate to human" signals, not denials. That is arguably the intended semantics, but it should be stated as such in docs. Second, **ask friction concentrates in sessions, not spreads evenly**: one session (the Langfuse evening) accounts for ~25 of the 72 asks.

## 3. Consistency: same command, different verdict

- `gh pr merge <n> --merge && git switch main && git pull …`: 5 occurrences → 3 allow / 2 ask.
- Release-note / spec `write` in `pi-verdict` cwd: 5 occurrences → 3 allow / 2 ask.
- `git branch -d … && git push origin --delete …`: 4 occurrences → 1 allow / 3 ask.
- `gh run watch|view|list`, `npm view`, `gh release view` (read-only CI checks): 5 standalone occurrences → all allow; but the same subcommands *embedded in a push-bearing chain* inherit the chain's ask.

The pattern: read-only CI inspection is reliably allowed when standalone; the instability sits entirely in the release chains, where the second layer re-judges a 10-segment compound command from scratch each time. Since bash adjudication is whole-command, a chain is judged by its riskiest segment, and deepseek's ranking of `gh pr merge` vs `git push` varies run to run. Users cannot form a mental model ("pushes ask, merges don't") — which is worse than either stable policy.

## 4. Safety-side findings

**S1 — Plaintext secrets land in the audit log (new, highest priority).** Every adjudication records `input.command` verbatim; the Langfuse session's `sk-lf-…` / `pk-lf-…` pair is now persisted in ~18 records in `~/.pi/agent/verdicts/`. The verdicts dir is read-denied from inside pi and absent from `files` on npm, but local-at-rest plaintext of credentials inside the *security tool's own telemetry* is a minimize-by-default violation. Remediation: redact common token shapes (`sk-…`, `pk-…`, `Bearer …`, `AKIA…`, `ghp_…`, `xox[bp]-…`, assignment after `-u`/`-H authorization`) before append; keep a short reversible-by-human prefix (e.g. first 4 + `…`) so records stay diffable.

**S2 — `pkill` / `killall` are outside the danger floor.** Seven `pkill -f "remote-debugging-port=…"` cleanups were allowed (76–90% confidence). Each instance was semantically fine (killing a headless Chrome the same session spawned), but `pkill -f` matches arbitrary command lines and can kill beyond intent — it is precisely the "pattern cheap to name, expensive when wrong" class the floor exists for. Add to `BASH_DANGER_RULES` (deny, consistent with `rm-recursive`'s stance).

**S3 — The fallback veto earned its keep.** Three first-layer allows (84–95% raw allow, 49%/84% observed with confidence below floor) reading `~/.ssh/config` and `~/.zshrc` were denied by the second layer with precise natural-language reasons ("reads ~/.ssh/config … exfiltrates its contents into the transcript"). No false relaxations in the dangerous direction were observed this batch (the 09-25 report's two contentious ask→allow relaxations remain the only known cases).

**S4 — Secret-in-command does not reliably escalate.** `npx langfuse-cli api --help` with keys already `export`ed passed as effective allow (fb concurred) — the help query itself is harmless, but the verdict pipeline treated a key-bearing command identically to a keyless one. A cheap deterministic rule — command text matching a token pattern ⇒ at least ask, before the classifier — would make this axis consistent (and would have collapsed the Langfuse evening's 20 asks into a stable, explainable one-ask-per-shape).

**S5 — Headless ask→deny has no appeal path (subagent false positive, confirmed).** A subagent's `write` to `~/.pi/agent/sessions/…/subagent-artifacts/outputs/…/context.md` — pi's own runtime artifact plumbing, not gate-owned state — drew jev ask 48% → fb allow → carve-out ask → no-UI degradation → deny (`degraded: true`). The write target is exactly where pi's subagent tooling is *supposed* to write. Two candidate fixes: (a) a deterministic exemption for `<agentDir>/sessions/` and `<agentDir>/workflows/` runtime trees (they are neither gate files nor audit records — the protected set already distinguishes `verdicts/` for exactly this reason); (b) if pi's subagent API ever surfaces an approval channel, route headless asks there instead of degrading.

**S6 — Zero danger-floor hits in 658 calls.** Every deny this batch came from the classifier layers. The floor is pure insurance here — which is fine — but it means *all* measured safety behavior rides on model availability; the fail-closed path (26 records in the 09-25 batch) did not recur this batch (fallback never errored).

## 5. Recommendations (priority order)

| # | Action | Type | Cost | Expected effect on the measured pain |
|---|---|---|---|---|
| 1 | **Redact token-shaped secrets in the audit writer** (S1) | safety | small | Removes plaintext credentials from disk; no UX change |
| 2 | ~~**Record the human's response to each ask**~~ **Already implemented** (#62 `userAnswer`/`answeredAt`); the measured approval rate is 70/71 with the only decline from the rule layer — this report's initial claim was wrong, corrected above | telemetry | done | Provides the calibration baseline: model-layer asks are ~never rejected, so friction-cutting there is safe |
| 3 | **Document allow-recipes** for the release workflow and read-only CI inspection (`^gh run (view|list|watch)\b`, `^npm view\b`, `^gh (release view|issue view)\b`, `^git push\b` if desired) in `docs/configuration.md` | usability | docs-only | Directly eliminates clusters (b) and the standalone-CI slice — ~20 of 72 asks — for users who adopt them |
| 4 | **Deterministic runtime-data exemption** for `<agentDir>/sessions/` (+ `workflows/`) in the rule layer (S5) | usability/safety | small | Fixes subagent false positives; shrinks headless-deny surprises |
| 5 | **`pkill`/`killall` into `BASH_DANGER_RULES`** (S2) | safety | one line | Consistent terminal deny for process kills |
| 6 | **Secret-in-command ⇒ deterministic ask** rule ahead of the classifier (S4) | safety+consistency | small | Stable, explainable handling of key-bearing commands (still needs #7 to not repeat 20×) |
| 7 | **Session-scoped ask memory**: after a human approves an ask, subsequent calls matching the same fingerprint (tool + normalized command shape) skip re-asking for that session; audited as `ask(remembered)` | usability | medium (needs pi API surface for surfacing the approval back to the extension) | Collapses intra-session repetition (the 18× Langfuse evening, back-to-back release chains) — the single largest remaining friction; with #2's data now available, its effect is directly measurable (a 70/71 approval rate says the memory would have been right ~99% of the time on this batch) |
| 8 | Compound-command reason attribution (which segment triggered the ask) | usability | medium | Better confirm dialogs; helps humans say yes faster rather than removing asks |

Deliberately *not* recommended: lowering `classifierMinConfidence` (the floor's veto catch is this batch's only confirmed dangerous-read stop), and any built-in read-only bash allowlist (violates the no-built-in-allowlist stance from #12; recipes in user config preserve sovereignty).

## Appendix: reproduction

```bash
python3 - <<'EOF'
import json, glob, os
from collections import Counter
files = sorted(glob.glob(os.path.expanduser('~/.pi/agent/verdicts/*.jsonl')), key=os.path.getmtime)[-10:]
eff = Counter(); trans = Counter(); asks = []
for f in files:
    for line in open(f):
        try: r = json.loads(line)
        except: continue
        fb = r.get('fallback')
        if fb:
            e = fb.get('effective'); eff[e] += 1
            trans[f"{r['verdict']}->{e}"] += 1
        else:
            eff[r['verdict']] += 1
        effective_ask = (fb.get('effective') if fb else r['verdict']) == 'ask'
        if effective_ask and not (fb is None and r.get('degraded')):
            asks.append((r['ts'], r['tool'], (r.get('input',{}).get('command') or '')[:120]))
print(eff, trans, len(asks), sep='\n')
EOF
```

Caveats: single host, single user, four days, and every session is a maintainer workflow on own repositories — the ask-legitimacy calls above inherit that bias (a multi-tenant or untrusted-repo profile would weigh clusters differently). The deny→ask cluster counts are hand-clustered from command text; totals are exact, per-cluster numbers approximate.
