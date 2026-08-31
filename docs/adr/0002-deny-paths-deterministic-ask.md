# 0002 - denyPaths: deterministic ask with classifier existence hint

---
status: accepted
date: 2026-08-31
---

## Context

Users need to protect *their own* sensitive paths (personal documents, company
directories) that the built-in S0 secrets floor cannot know about. Today the
nearest tool is a hand-written `deny` regex, which already matches normalized
absolute paths for file tools — but only as a string pattern: it never sees
through bash command strings semantically, and the classifier adjudicating the
gray zone has no idea which paths the user considers sensitive. The measured
record constrains the design space: command-string regexes are obfuscatable
(rule-layer audit, 8/8 bypasses reproduced), and a tree-sitter rule engine was
measured to absorb zero gray calls (rule-engine-sim) — so heavyweight bash
analysis is off the table for this project.

A second constraint is *leakage*: the paths being protected are themselves
sensitive (directory names, project names). Anything injected into the
classifier prompt leaves the machine bound for the model provider.

## Decision

1. Add a `denyPaths` config field: a list of paths the user declares
   protected. It is a **path-semantic declaration** — unlike `deny` regexes
   (string patterns, the user owns the normalization assumptions), the tool
   owns normalization here.
2. **Normalization pipeline (both sides, same scale)**: `expandHome` →
   `path.resolve(cwd, p)` (lexical layer, never fails, handles nonexistent
   paths and glob tokens) → `fs.realpathSync` attempt (enhancement layer:
   resolves symlink indirection such as `ln -s ~/sensitive /tmp/loot`);
   realpath failure degrades to the lexical result. Comparison is per path
   segment (`abs === base || abs.startsWith(base + path.sep)`). denyPaths are
   normalized once at session start; candidate paths per verdict. This mirrors
   the self-protection layer's existing realpath-normalized comparison — the
   helper is shared.
3. **Local extractor as evidence producer, not adjudicator**: file tools
   (read/write/edit/grep/find/ls) contribute their absolute path; bash
   contributes path tokens extracted from the full command string (including
   heredoc bodies, which arrive inline). External script *contents* are
   explicitly not read (no L3): recursion/TOCTOU/obfuscation make soundness
   unachievable, and a partial illusion of coverage would violate the
   project's honest-framing stance.
4. **Hit → deterministic ask (terminal)**, degrading to deny in
   non-interactive modes via the existing ask-degradation rule. The extractor
   never *denies*; it routes the exception back to its owner — the user who
   declared the path. Priority order: self-protection deny → built-in floor
   deny → user deny → **denyPaths hit → ask** → user allow → gray/classifier.
   denyPaths therefore overrides the user's own allow rules ("not even my
   allow list may touch these").
5. **Classifier sees an existence hint only**: a fixed system-prompt sentence
   stating that protected paths are configured and that edge-probing behavior
   (copy-then-read, archiving, indirection) should be judged strictly. No
   path plaintext, ever. Calls that *hit* never reach the classifier at all
   (deterministic ask short-circuits first), so a per-call hit annotation in
   the transcript would be dead code — dropped from the design.
6. denyPaths is **not** controlled by `builtinDenyFloor: false` (that switch
   turns off built-in claims, not the user's own declaration) but is subject
   to the master switch (gate off = no adjudication at all).

## Considered alternatives

- **Hit → classifier discretion (allow/ask/deny possible)**: rejected — a
  user's own security declaration degraded to the input of a probabilistic
  component; one misjudged allow and the content is in context.
- **Hit → deny (consistent with S0 and user deny)**: rejected — kills
  legitimate tasks that genuinely need the file; the user who declared the
  path is exactly the right adjudicator for the exception. S0 stays deny
  because it is an author-vetted, false-positive-tuned generic set.
- **Masked or plaintext path injection into the classifier prompt**: rejected
  — leaks path prefixes for an unreliable model-side comparison; the
  existence hint captures the behavioral value at zero leakage.
- **Deterministic deny layer over bash (L2 as adjudicator)**: rejected —
  obfuscatable string/path matching is the exact posture the security audit
  documented; declarations that can be silently bypassed are worse than
  declarations routed to a human.
- **Recursive script-content scanning (L3)**: rejected — unsound by
  construction (scripts spawning scripts, dynamic eval); a partial
  implementation would advertise coverage it does not have.
- **tool_result-side detection** (pi's post-execution hook could scan result
  content for denyPaths strings): rejected for now — weak detection
  (path-string presence ≠ content leakage), half-leaked results, no scenario
  it covers that extractor + hint do not. Recorded as an idea in the issue
  tracker.

## Consequences

- **S0 deny vs denyPaths ask is a deliberate inconsistency**: the source of a
  declaration determines who owns its exception approval (author-vetted
  generic set → deny; user-declared → ask). README must state this.
- **Coverage has honest holes**: command substitution, base64-embedded paths,
  external script contents produce no hit signal; those fall back to the
  classifier's existence-hint vigilance. This boundary goes in the README's
  limitations section, alongside the self-protection substring precedent
  ("honestly obfuscatable").
- MCP and custom tools bypass the extractor entirely, but their gray-zone
  adjudication carries the existence hint — the bypass surface is reduced,
  not eliminated.
- Config template gains a commented `denyPaths: []` example; `/automode`
  shows the active count; the pipeline diagram and options table update
  accordingly.
- The matched path is UI-only plaintext: it names the path in the local
  confirm dialog (story 6) but never in block reasons or notifications —
  those travel back into the agent context (model provider), so embedding
  the path there would leak the declaration (story 11).
- Entries anchor to the **session cwd** once at session start; per-verdict
  candidates still resolve against the current call's cwd. Mid-session
  symlink creation or cwd drift therefore cannot re-anchor what the
  declaration covers.
- Landed footprint: ~+230 lines (extensions/auto-mode.ts 1046 → ~1200 at
  review time). The "~900-line minimal" positioning no longer holds
  numerically; the README restates it as a deliberate single-file
  constraint rather than a line-count claim.
