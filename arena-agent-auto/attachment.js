import { isArena, samePage } from './core.js';
import { VERSION } from './version.js';
export const ADAPTER_VERSION = VERSION;
export class AttachmentError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
export async function attachAgent(tabId, expectedUrl) {
  if (!Number.isInteger(tabId)) throw new AttachmentError('INVALID_TAB', 'Choose an Arena Agent tab first.');
  if (!chrome.scripting?.executeScript)
    throw new AttachmentError('EXTENSION_UPDATE_REQUIRED', `The scripting API is unavailable. Reload Arena Agent Auto Chat in chrome://extensions and confirm version ${VERSION} with the scripting permission.`);
  if (!await chrome.permissions.contains({ origins: ['https://arena.ai/*'] }))
    throw new AttachmentError('SITE_ACCESS_REQUIRED', 'Chrome has not granted Arena site access. Open chrome://extensions → Arena Agent Auto Chat → Details → Site access and allow https://arena.ai, then reconnect. Do not grant access to all sites.');
  const before = await chrome.tabs.get(tabId);
  if (!isArena(before.url)) throw new AttachmentError('WRONG_ORIGIN', 'The selected tab is not on https://arena.ai. Open the Agent tab and select it again.');
  if (expectedUrl && !samePage(before.url, expectedUrl))
    throw new AttachmentError('TAB_NAVIGATED', 'The selected Arena tab navigated before connection. Choose the current Agent conversation and reconnect.');
  let injected;
  try {
    // Only packaged code, the selected tab's top frame, and Chrome's isolated world.
    // Repeated injection is idempotent and cannot submit a prompt.
    injected = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] }, world: 'ISOLATED',
      files: ['version.js', 'attachment-policy.js', 'agent-dom.js', 'agent-content.js']
    });
  } catch (error) {
    throw new AttachmentError('CONTENT_SCRIPT_INJECTION_FAILED', `Chrome could not attach the Agent script to tab ${tabId}. Browser detail: ${error.message || 'unknown injection error'}. Check this extension’s Arena site access, any Chrome/organization restrictions, and that the tab is a normal https://arena.ai page. No prompt was sent.`);
  }
  const documentId = injected?.find(result => result.frameId === 0)?.documentId;
  if (!documentId)
    throw new AttachmentError('DOCUMENT_NOT_FOUND', 'Chrome did not return the Arena top-frame document ID after attachment. Reload the Arena tab and reconnect. No prompt was sent.');
  let checks;
  try {
    checks = await chrome.scripting.executeScript({
      target: { tabId, documentIds: [documentId] }, world: 'ISOLATED',
      func: () => ({
        version: globalThis.__ARENA_AGENT_REGISTRATION__?.version || null,
        domVersion: globalThis.ArenaAgentDOM?.version || null,
        attachmentsPolicy: !!globalThis.ArenaAgentAttachments
      })
    });
  } catch (error) {
    throw new AttachmentError('DOCUMENT_CHANGED', `The Arena document became unavailable during attachment. Browser detail: ${error.message || 'document changed'}. Wait for it to finish loading and reconnect; no prompt was sent.`);
  }
  if (checks?.[0]?.result?.version !== ADAPTER_VERSION || checks?.[0]?.result?.domVersion !== ADAPTER_VERSION || checks?.[0]?.result?.attachmentsPolicy !== true)
    throw new AttachmentError('SCRIPT_REGISTRATION_FAILED', `The bundled Agent script did not register version ${VERSION}. Reload the extension and tab. This is an extension attachment problem, not an Arena reply timeout. No prompt was sent.`);
  const after = await chrome.tabs.get(tabId);
  if (!samePage(after.url, before.url) || !isArena(after.url))
    throw new AttachmentError('TAB_NAVIGATED', 'Arena navigated during connection. Reconnect to the current Agent conversation; no prompt was sent.');
  return { documentId, url: after.url };
}
