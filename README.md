# pi config

Versioned [pi](https://github.com/earendil-works/pi) configuration.

## Contents

| Path | What it is |
|---|---|
| `agent/settings.json` | Default provider/model and other settings |
| `agent/models-store.json` | Model definitions (DeepSeek models) |
| `agent/trust.json` | Trusted project directories |
| `agent/extensions/footer-cache.ts` | Custom footer + click-through info overlays |
| `agent/extensions/undo.ts` | `/undo` command — reverts the last turn's file edits and removes it |
| `agent/extensions/summarize.ts` | `/summarize` command — summarizes and compacts the current context |
| `agent/extensions/plan-mode/` | `/plan` + `/todos` — read-only research/plan mode before editing |
| `agent/extensions/subagent/` | `/subagent` + `/subagent_check` tools — dispatch agents to background Herdr panes |
| `agent/agents/` | Subagent definitions, advertised in the system prompt as a `<subagents>` section |
| `agent/prompts/` | Prompt templates (`/implement`, `/scout-and-plan`, `/implement-and-review`) |
| `pi-acp/session-map.json` | ACP session map |

## Not tracked

- `agent/auth.json` — **API keys (secret)**
- `agent/sessions/` — conversation history
- `agent/plans/` — per-plan markdown files
- `agent/install/`, `agent/bin/` — the pi installation itself

## Notes

The footer extension replaces pi's built-in footer with two lines:

```
Σ <tokens> · <time> · ◧ <ctx%> · ↺ <cache%>        $<session> · $<today> · $<30d> · <peak>
<branch> · <cwd>                                  <model> · <effort> · <tps>/s
```

In fullscreen mode, each segment (and each cost value) is clickable and opens an
overlay with details, bar charts, and DeepSeek pricing. Extension statuses set
via `setStatus()` (e.g. the plan-mode indicator) are shown at the start of line 1.

## Plan mode

`/plan` toggles a read-only research/planning mode: `edit`/`write` are withdrawn,
`bash` is limited to an allowlist of read-only commands, and the agent is told to
output a numbered `Plan:`. After it proposes a plan you can execute it (full
access restored, progress tracked in a widget), refine it, or stay in plan mode.

Each plan is saved as its own file under `~/.pi/agent/plans/<timestamp>-<slug>.md`,
so a single session can hold many plans. The file contains the steps as a
markdown checklist (checked off during execution) plus the full plan text.
`/planfile` prints the current file and `/plans` lists the session's plans.

## Subagents

The `subagent` extension advertises every agent under `agent/agents/` in the
system prompt as a `<subagents>` section, mirroring the `<skills>` section.
Each entry lists the agent's name, description, model, tools, and source file
so the model can pick the right one without re-discovering them at dispatch time.

| Agent | Role | Model |
|---|---|---|
| `scout` | Fast codebase recon, returns compressed context | `claude-haiku-4-5` |
| `planner` | Turns context + requirements into an implementation plan | `claude-sonnet-4-5` |
| `worker` | General-purpose, isolated context | `claude-sonnet-4-5` |
| `reviewer` | Code review: quality, security, maintainability | `claude-sonnet-4-5` |
