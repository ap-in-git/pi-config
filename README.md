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
| `pi-acp/session-map.json` | ACP session map |

## Not tracked

- `agent/auth.json` — **API keys (secret)**
- `agent/sessions/` — conversation history
- `agent/install/`, `agent/bin/` — the pi installation itself

## Notes

The footer extension replaces pi's built-in footer with a single line:

```
Σ <tokens> · $<session> · $<today> · $<30d>    ◧ <ctx%> · ↺ <cache%> · <peak> · <model> · <effort>
```

In fullscreen mode, each segment (and each cost value) is clickable and opens an
overlay with details, bar charts, and DeepSeek pricing.
