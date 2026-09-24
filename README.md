# Arena Agent Auto Chat

**Version:** 2.3.1 · **Platform:** Chrome Extension (Manifest V3) · **Target site:** `https://arena.ai`

A Chrome side-panel extension that automates chatting on arena.ai in **Agent mode** and **Direct (single-model) mode**: it sends your prompt through the page exactly once, watches the Arena DOM for the matching reply, captures it back into the panel, and keeps a conversation history — with no manual fallback path.

> ⚠️ **Experimental / unofficial.** This tool drives arena.ai by reading and clicking its DOM. It is not affiliated with or endorsed by Arena. Automating a site this way can break when the site changes its markup, and may conflict with the site's Terms of Service. Use at your own risk.

---

## Features

- **Side panel + floating window** — works docked in Chrome's Side Panel or as a detached always-on-top-style window (`floating.html`).
- **Two chat modes** — Agent conversations and Direct text chats (with model selection); Battle / Side-by-Side modes are not supported.
- **One-shot send with capture** — each turn is sent once; the adapter matches the reply by message ID and streams status (thinking, tool activity, review panel) live into the panel.
- **Attachments** — stage up to 4 files in memory and let the adapter place them into Arena's composer file input. Strict validation policy (`attachment-policy.js`); if the composer's file input is ambiguous or restricted, files are refused *before* anything is sent.
- **History import** — read-only import of earlier turns already present in the Arena conversation ("Load earlier messages").
- **Resilient connection** — since v2.3.0 the panel holds a **direct port** to the Arena tab's top-frame content script (`chrome.tabs.connect`). The MV3 service worker is only used for short one-shot requests (script injection, staged-file grants), so Chrome suspending the idle worker can no longer drop an active chat. Reconnects with heartbeat/lease logic and survives worker suspension.
- **Safety-first errors** — every failure mode reports *whether a prompt was sent*. Hard stops (wrong origin, tab navigated, document reloaded mid-send, unsupported upload) never retry blindly and never double-send.
- **Themes & customization** — light/dark theme plus user customization applied identically in both windows.

## Architecture

```
panel.js / floating.html ──(chrome.tabs.connect, direct port)──► agent-content.js (isolated world, arena.ai top frame)
      │                                                                        │ uses
      │ chrome.runtime.sendMessage (one-shot RPC)                              ▼
      ▼                                                                  agent-dom.js
worker.js (MV3 service worker)  ◄── attachment.js (chrome.scripting.executeScript)
      │
      └── stage-main.js (file staging via executeScript, token-gated)
```

| File | Role |
|---|---|
| `manifest.json` | MV3 manifest: side panel, service worker, content scripts, CSP (`connect-src 'none'` — the extension makes zero network requests of its own). |
| `version.js` | **Single source of truth for the version string** (see below). |
| `core.js` | URL helpers shared by panel and worker (`isArena`, `isDirect`, `samePage`, …). |
| `agent-client.js` | Panel-side port wrapper: handshake, heartbeat, version check, event decoding. |
| `attachment.js` | Worker-side: permission checks + idempotent script injection + registration verification. |
| `agent-content.js` | Page adapter: owns the send transaction, watches the DOM, emits events over the port. |
| `agent-dom.js` | Pure DOM knowledge layer (selectors, row matching, composer, models, history). All brittle site-specific logic lives here. |
| `attachment-policy.js` | Shared attachment validation rules (size/type/count) used by both panel and page. |
| `stage-main.js` | Function injected to materialize base64-staged files into the composer input. |
| `worker.js` | Service worker: floating-window opening, one-shot RPC, staged-file grants. |
| `panel.js` / `panel.html` / `floating.*` | UI, state machine, rendering. |
| `conversation-view.js`, `live-view.js`, `live-status.js` | Chat rendering components. |
| `window-geometry.js`, `theme.js`, `customization.js` | Floating-window sizing/persistence and appearance. |

### Version handling

The version is defined **once** in [`version.js`](version.js):

```js
globalThis.ArenaAgentVersion.VERSION = '2.3.1'; // (exported from the global for classic-script idempotency)
globalThis.ArenaAgentVersion = { VERSION };
```

- ES modules (`panel.js`, `attachment.js`, `agent-client.js`, `worker.js`) use `import { VERSION } from './version.js'`.
- Classic content scripts (`agent-dom.js`, `agent-content.js`) cannot use `import`, so `version.js` is listed **first** in both `content_scripts.js` (manifest) and the `executeScript({files: [...]})` list in `attachment.js`, and they read `globalThis.ArenaAgentVersion.VERSION`.
- `manifest.json` still carries `"version": "2.3.0"` because manifests cannot import JS. Keep the two in sync when releasing — the runtime self-check in `agent-content.js` compares `chrome.runtime.getManifest().version` against the constant, so a mismatch fails loudly instead of silently misbehaving.

## Installation (unpacked)

1. Clone or download this repository, then open `chrome://extensions`.
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select this folder (the one containing `manifest.json`).
4. Pin the extension, open <https://arena.ai>, start an Agent or Direct conversation, and open the side panel (extension action icon).

Requirements: Chrome ≥ 116 (for `chrome.scripting` document IDs and Side Panel APIs).

## Usage

1. Open an arena.ai conversation in a tab.
2. In the panel, pick the tab and press **Connect**. The panel verifies the content-script version and probes the composer controls before enabling Send.
3. Type a prompt (optionally stage ≤ 4 files) and **Send**. The panel shows live status until the matching reply is captured.
4. Use **Load earlier messages** to import existing turns from the Arena page (read-only).

### Troubleshooting

- **"Wrong content-script version"** — you updated the extension but not the open tab. Reload the Arena tab, then reconnect.
- **Site access errors** — chrome://extensions → Arena Agent Auto Chat → Details → Site access → allow `https://arena.ai` (don't grant all sites).
- **"staged files cannot be sent"** — Arena's composer file input is missing/ambiguous; attach files directly in the Arena tab instead.

## Security notes

- Content scripts run only in Chrome's **isolated world** on `https://arena.ai/*`; no site auth data is read.
- Manifest CSP sets `connect-src 'none'` for extension pages: the extension itself performs no network I/O.
- Injection is idempotent and cannot submit a prompt by itself; file staging is token-gated and capped.

## Repository layout note

`arena-agent-auto-v2.3.0.zip` is a snapshot of the packaged release as originally uploaded. It predates the `version.js` refactor, so load the **folder** (not the zip) when testing current `main`.
