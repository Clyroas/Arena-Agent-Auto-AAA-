# Arena Agent Auto Chat — v2.3.0

Resilient direct-port architecture, attachment support, and a single-source-of-truth version system.

## Highlights

- **Version constant extracted** — `version.js` is now the single source of truth (`VERSION = '2.3.0'`). All user-facing version strings interpolate from it; the panel badge and adapter state are derived automatically. `manifest.json` keeps its own copy (manifests can't import JS) with a runtime self-check that loudly flags any mismatch.
- **README added** — full documentation: architecture diagram, per-file role table, install (Load unpacked), usage, troubleshooting, security notes, and ToS/DOM-brittleness warning.
- **Resilient direct-port architecture** — panel ↔ content-script communication via named ports with re-acked pings and namespaced alarms; survives service-worker eviction.
- **Attachment support** — file attachments handled through `attachment.js` + `attachment-policy.js` with strict policy checks in the page's isolated world.

## Install

1. Download and unzip `Arena-Agent-Auto-Chat-v2.3.0.zip`.
2. Open `chrome://extensions`, enable **Developer mode**.
3. Click **Load unpacked** and select the unzipped `Arena-Agent-Auto-Chat-v2.3.0` folder.

## Notes / known limitations

- The extension scrapes arena.ai's DOM; selectors may break when the site updates (see README "Troubleshooting").
- Automated interaction may violate arena.ai's Terms of Service — use at your own risk.
- When bumping versions, update **both** `version.js` and `manifest.json`; the runtime check will catch it if you forget.

## Assets

- `Arena-Agent-Auto-Chat-v2.3.0.zip` — ready-to-load unpacked extension build (source, 31 files).
