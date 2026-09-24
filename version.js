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
//
// The classic-script copy MUST be idempotent: Chrome can execute it twice per document
// (manifest-declared injection overlapping a chrome.scripting.executeScript files:[...] call).
// A top-level `const VERSION` would then throw "Identifier 'VERSION' has already been
// declared", aborting the rest of the injection chain and surfacing as a false
// SCRIPT_REGISTRATION_FAILED in the panel. Hence the global assignment + export-from-global
// pattern below, with no top-level lexical declarations at all.
globalThis.ArenaAgentVersion = globalThis.ArenaAgentVersion || {};
if (!globalThis.ArenaAgentVersion.VERSION) globalThis.ArenaAgentVersion.VERSION = '2.3.1';
export const VERSION = globalThis.ArenaAgentVersion.VERSION;
