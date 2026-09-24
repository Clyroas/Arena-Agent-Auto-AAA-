// Single source of truth for the extension/adapter version.
//
// IMPORTANT: this value must match "version" in manifest.json. Manifests cannot import JS,
// so the pairing is enforced by convention (and by the runtime self-check in agent-content.js,
// which compares chrome.runtime.getManifest().version against this constant).
//
// Two consumers load code from this file:
//   1. ES modules (panel.js, worker.js, attachment.js, agent-client.js) -> `import { VERSION }`.
//   2. Classic content scripts (agent-dom.js, agent-content.js), which cannot use `import`
//      inside their IIFEs -> listed first in "content_scripts.js" in manifest.json and read
//      `globalThis.ArenaAgentVersion`.
export const VERSION = '2.3.0';
globalThis.ArenaAgentVersion = { VERSION };
