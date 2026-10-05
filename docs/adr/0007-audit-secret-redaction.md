# 0007 - Audit secret redaction

---
status: accepted
date: 2026-10-05
---

The verdict audit log (#54) persists `input.command`, the transcript, reasons and raw responses verbatim. Production data (10 sessions, 2026-10-01~04, [audit](../../research/verdicts-ask-friction-audit-2026-10.md)) showed ~18 records carrying a hardcoded internal-service API key pair (`pk-lf-…`/`sk-lf-…`) in plaintext — the security tool's own telemetry was a credential sink. The verdicts directory is read-denied from inside the agent and ships in no package, but plaintext secrets at rest inside the gate's audit trail violates minimize-by-default.

Decision: redact at the single choke point — `AuditLog.append()`, the one sink every record path funnels through (gray-zone, fail-closed, protected-path, the `userAnswer` finalize). Two detection layers over all string values of the record, recursively:

1. **Exact provider shapes** (near-zero false positives): `sk-`/`pk-`/`sk-ant-`/`ghp_`-family/`github_pat_`/`AKIA`/`xox?`/`AIza`/JWT. Order-sensitive (specific prefix first); shape output can never re-match.
2. **Context-guided value redaction** for shapeless secrets, running *before* the shapes: `-u user:pass` password segment, URL userinfo (`https://user:pass@host`, lookahead `@` guards ports; the value class also excludes `/`, which RFC 3986 forbids in userinfo anyway — `host:8080/path@x` port shapes stay untouched), credential query params (`token`/`apikey`/`signature`/… — before the assignment rule so query-position names keep the query tag), and assignments: `*_KEY|*_TOKEN|_SECRET|_PASSWORD|_CREDENTIALS` suffixes plus bare `TOKEN|APIKEY|SECRET`. The layer order is load-bearing: a provider-shaped *username* (`-u "sk-…:shapelesspass"`) must meet the `-u` rule while still raw — shapes-first would rewrite it into a marker whose leading `<` defeats the value classes, dropping the shapeless password.

Every value character class excludes `<` (every replacement starts with `<`), which is the sole load-bearing idempotency mechanism; `#` is additionally excluded only in the bearer and query value classes where a bare fragment could otherwise pose as a value. Recursion clones plain objects and arrays only — exotic objects (Date, …) pass through untouched, leaving JSON.stringify in authority over their serialization.

Replacement form: `<redacted:type#sha256-8-hex>` — type tag (which family) plus an **unsalted** sha256 fingerprint. Determinism is the point: the same secret gets the same fingerprint across records, preserving cross-record clustering and diffability (the production audit's "same key in 18 records" tracking relies on exactly this).

## Rejected alternatives

- **High-entropy-string detection**: uncontrollable false positives in audit content (base64 payloads, hashes, session ids, UUIDs — all present in real records). Rejected; two named layers instead, with the residual risk (shapeless secret not near a recognized context) accepted and documented.
- **Salted fingerprints**: rainbow-table hardening for weak secrets, at the cost of clustering. Rejected: the threat model anchors on high-entropy API keys (rainbow inversion infeasible); a weak secret (`-u admin:admin`) is already lost on every other surface.
- **Fail-closed redaction** (drop/blank the whole record on redactor error): rejected — #54's core promise is fail-soft append completeness; hygiene must not eat audit integrity. Redaction failure fails open (raw text lands), the worst case equals today's behavior. All regexes are character-class + bounded/greedy quantifiers, no nested quantifiers, no backtrack blowup.
- **Redacting the classifier input**: rejected — "the command carries a secret" is itself an adjudication signal; the gate must see the real command. Redaction applies to the persisted copy only, never the pipeline.
- **User-extensible `redactPatterns` key**: YAGNI. Built-in list until a real need appears; one deliberate tension with user sovereignty is accepted (redaction changes record fidelity, not verdict semantics — safety default wins).
- **Truncation interplay**: transcript lines are sanitized (head 600 + tail 400) at construction time, before append — mid-command secrets never reach the log, and boundary-cut half-tokens (unusable fragments) are an accepted known edge, noted here rather than engineered around.

## Consequences

- **Corpus fidelity is permanently reduced**: records no longer reproduce the exact command text; cross-referencing raw transcripts for debugging now means re-running with `auditRedactSecrets: false` (the explicit escape hatch, config-only, new-session semantics; invalid values warn once and redaction stays on — [inert configuration must surface](../../CONTEXT.md)).
- **Scope is the audit face only**: pi's native session transcripts and terminal echoes still contain the raw commands — this ADR makes no claim over them (upstream surface). "Redacted" refers to `verdicts/*.jsonl` exclusively; the docs say so to avoid a false sense of coverage.
- **Fingerprint collisions** (8 hex, ~4 billion space) are negligible at audit scale; two distinct secrets sharing a fingerprint would merely merge two clusters.
- Existing plaintext records are not rewritten — historical files are the user's to handle (rotation of any already-logged credential is the real remediation; the gate never edits its own audit trail).
