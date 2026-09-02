# Configuration Reference

Everything the gate reads from disk lives in `<agentDir>/config/pi-verdict.json` (first run generates a template there; `PI_CODING_AGENT_DIR` overrides the location). This page is the full reference; the README keeps a quick-start subset.

## User rules

```json
{
  "allow": ["^ls\\b", "^git (status|log|diff)\\b"],
  "deny":  ["rm ", "docker ", "^/etc/"],
  "denyPaths": ["~/Documents/private", "~/work/company"],
  "builtinDenyFloor": true,
  "classifierModel": null,
  "toggleShortcut": "ctrl+shift+a"
}
```

- `allow`/`deny` are JS regex arrays; **`deny` wins over `allow`**, both beat the classifier. Match targets: bash/powershell = the full command string; file tools = the resolved absolute path; other tools (e.g. MCP) are not covered by rules and land in the gray zone.
- `denyPaths` are plain paths (not regexes) you declare **protected**: any tool call touching them — file tools via their path, bash via path tokens extracted from the command string — triggers a **terminal ask** you adjudicate (non-interactive sessions degrade to deny). Not affected by `builtinDenyFloor: false`.
  The classifier only ever learns that protected paths *exist*; the paths themselves never leave your machine, and a matched path shows **only** in the local confirm dialog.
- `builtinDenyFloor: false` turns the built-in danger/path floor off entirely (risk accepted by you; the classifier and your rules remain — the self-protection layer always stays on).
- `classifierModel: "provider/model-id"` sets the classifier model (e.g. a fast flash-class model); precedence is flag > env > config > session model (self-reflection); an invalid value falls back to the session model with a one-time warning.
- The spec accepts pi's native `--model` thinking suffix: `"zai/glm-5.3-flash:low"` sets classifier thinking to effort low (default without suffix: thinking explicitly off).
- `toggleShortcut` rebinds the master-switch toggle key (`null` or empty disables it, not persisted).

## Why no built-in allowlist?

Bypass testing of the rule layer ([writeup](../research/rule-layer-security-audit.md)) showed that allowlist robustness is very limited. The built-in layer only makes **deny** claims (the sound direction); allow claims are yours.

## Host notes (pi and oh-my-pi)

pi-verdict runs on both [pi](https://github.com/badlogic/pi-mono) and [oh-my-pi](https://github.com/can1357/oh-my-pi) (omp); the extension self-anchors to whichever agent tree it is installed in. On a dual-install machine the gate follows the extension copy's own location — the mere presence of `~/.omp` never redirects a pi run (and vice versa).

Implementation details worth knowing if you hack on the extension:

- omp 18's `ModelRegistry` has no `complete` method, so the classifier resolves completion through the pi-ai compat module at first gray-zone verdict (`@earendil-works/pi-ai/compat`, which omp's legacy compat layer rewrites to its bundled pi-ai). Resolution or call failures follow the usual fail-closed deny.
- Thinking control is sent in both hosts' native dialects (`thinkingEnabled`/`effort` for pi, `reasoning`/`disableReasoning` for omp); each host reads its own fields and ignores the other's.
- omp installs npm plugins under `<agentDir>/plugins/node_modules/<pkg>/`; that install form gets the same whole-package-dir self-protection as the pi forms (ADR-0001).
