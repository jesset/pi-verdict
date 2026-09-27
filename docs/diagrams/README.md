# Diagrams

Source-of-truth authoring specs for the documentation diagrams. The SVGs are
export artifacts — regenerate them from the specs instead of editing by hand.

| file | role |
|---|---|
| `security-pipeline.workflow.json` | English pipeline-diagram spec (source of truth) |
| `security-pipeline.workflow.zh.json` | Chinese pipeline-diagram spec (source of truth) |
| `security-pipeline.en.svg` | exported embed for [README.md](../README.md) |
| `security-pipeline.zh.svg` | exported embed for [README.zh-CN.md](../README.zh-CN.md) |

Both SVGs are dual-theme: they embed a `prefers-color-scheme: dark` variant and
adapt automatically on GitHub and in most renderers.

## Regenerating

The specs author with the [archify](https://github.com/tt-a1i/archify) workflow
skill (installed locally, not a repo dependency):

```bash
# 1. validate the edited spec (showcase gate: composition, labels, semantics)
archify validate workflow security-pipeline.workflow.json --quality showcase --json

# 2. render the checked interactive HTML (local artifact, not committed)
archify deliver workflow security-pipeline.workflow.json security-pipeline.en.html --quality showcase
```

Then open the HTML, use **Export → SVG (editable vector, dual-theme)**, and
replace the matching `.svg` file. Keep both language specs in sync on
pipeline-structure changes (only string fields differ).

Baseline: adjudication pipeline as of v0.12 (ADR-0001–0004; #22/#62/#71/#73
semantics included).
