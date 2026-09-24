import { openFloatingWindow } from './floating-window.js';
import { attachAgent } from './attachment.js';
import { arenaAgentStageFiles } from './stage-main.js';
import { AGENT_URL, isArena, isDirectChat } from './core.js';

// One-time grants for page-context file insertion, used only by the pinned content script of the
// Arena tab that an explicit staged-file Send was relayed to. File bytes exist solely for that call:
// they are never stored, logged, cached or sent anywhere else, and each grant is single-use.
const STAGE_WINDOW_MS = 20000;
const stageGrants = new Map(); // `${tabId}:${documentId}` -> expiry
function pruneGrants() { const now = Date.now(); for (const [key, until] of stageGrants) if (until <= now) stageGrants.delete(key); }
function releaseDocument(documentId) { for (const key of [...stageGrants.keys()]) if (key.endsWith(`:${documentId}`)) stageGrants.delete(key); }

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return;
  if (message?.type === 'CLEAR_STAGE') { if (sender.documentId) releaseDocument(sender.documentId); respond({ ok: true }); return; }
  if (message?.type !== 'STAGE_FILES') return;
  const tabId = sender.tab?.id, documentId = sender.documentId;
  const deny = (code, error) => { respond({ ok: false, code, error }); return false; };
  if (!Number.isInteger(tabId) || sender.frameId !== 0 || !documentId || !isArena(sender.url))
    return deny('STAGE_UNBOUND', 'The staging request did not come from the connected Arena top frame. Nothing was inserted.');
  pruneGrants();
  const key = `${tabId}:${documentId}`;
  if (!stageGrants.has(key)) return deny('STAGE_UNBOUND', 'No pending staged-file send is attached to this Arena document. Nothing was inserted.');
  stageGrants.delete(key); // single use: another attempt needs a fresh explicit Send
  const files = Array.isArray(message.files) ? message.files : [];
  if (!files.length || files.length > 4 || files.some(file => typeof file?.name !== 'string' || typeof file?.type !== 'string' ||
      typeof file?.data !== 'string' || file.data.length > 12e6) || !/^[0-9a-f-]{36}$/.test(String(message.token || '')))
    return deny('INVALID_ATTACHMENT', 'The staged files were rejected before reaching the page. Nothing was inserted.');
  (async () => {
    const results = await chrome.scripting.executeScript({
      target: { tabId, documentIds: [documentId] }, world: 'MAIN',
      func: arenaAgentStageFiles, args: [{ token: message.token, files }]
    });
    return { ok: true, value: results?.find(entry => entry.frameId === 0)?.result ?? null };
  })().then(result => respond(result), error => respond({ ok: false, code: 'STAGE_FAILED', error: error?.message || 'Chrome could not run the staging step. Nothing was inserted.' }));
  return true;
});

async function configure() {
  // The toolbar icon opens the docked side panel next to the Arena tab; no extra window.
  try { await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }); }
  catch (error) { console.warn('Side panel unavailable:', error.message); }
}
chrome.runtime.onInstalled.addListener(configure);
chrome.runtime.onStartup.addListener(configure);

// Fallback only: Chrome fires onClicked when the side panel cannot be opened from the icon.
chrome.action.onClicked.addListener(() => { openFloatingWindow().catch(error => console.warn('Floating window unavailable:', error.message)); });
const isChatPage = url => ['panel.html', 'floating.html'].some(name => url === chrome.runtime.getURL(name));

// No credential access, private API calls or retained chat state.
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || !isChatPage(sender.url)) return;
  (async () => {
    switch (message?.type) {
      case 'OPEN_FLOATING': return openFloatingWindow();
      case 'LIST_TABS': {
        const tabs = await chrome.tabs.query({ url: 'https://arena.ai/*' });
        return tabs.map(({ id, windowId, title, url }) => ({ id, windowId, title, url }));
      }
      case 'GET_TAB':
      case 'FOCUS_TAB': {
        if (!Number.isInteger(message.tabId)) throw new Error('Choose an Arena tab.');
        const tab = await chrome.tabs.get(message.tabId);
        if (!isArena(tab.url)) throw new Error('This tab is no longer on Arena. Reconnect to Agent Mode.');
        if (message.type === 'FOCUS_TAB') {
          await chrome.windows.update(tab.windowId, { focused: true });
          await chrome.tabs.update(tab.id, { active: true });
        }
        return { id: tab.id, windowId: tab.windowId, title: tab.title, url: tab.url, discarded: !!tab.discarded, status: tab.status };
      }
      case 'ATTACH': {
        if (!Number.isInteger(message.tabId)) throw new Error('Choose an Arena tab first.');
        const attached = await attachAgent(message.tabId, message.expectedUrl);
        return { documentId: attached.documentId };
      }
      case 'STAGE_GRANT': {
        // A panel is about to relay a staged-file Send to this exact document: allow one insertion.
        if (!Number.isInteger(message.tabId) || typeof message.documentId !== 'string' || !message.documentId) throw new Error('No connected Arena document for the staged files.');
        pruneGrants(); stageGrants.set(`${message.tabId}:${message.documentId}`, Date.now() + STAGE_WINDOW_MS); return true;
      }
      case 'STAGE_REVOKE': {
        if (Number.isInteger(message.tabId) && typeof message.documentId === 'string') stageGrants.delete(`${message.tabId}:${message.documentId}`);
        return true;
      }
      case 'NAVIGATE_TAB': {
        // Explicit model/mode choice from the panel: open a NEW Direct chat (Arena's own ?model_a= link)
        // or Agent Mode in the connected tab. Only these two Arena addresses are allowed.
        if (!Number.isInteger(message.tabId)) throw new Error('Choose an Arena tab first.');
        const target = String(message.url || '');
        const url = new URL(target);
        const allowed = (isDirectChat(target) && [...url.searchParams.keys()].every(k => k === 'model_a') && !url.hash) || target === AGENT_URL;
        if (!allowed) throw new Error('Only a new Arena Direct chat or Agent Mode can be opened from the panel.');
        const tab = await chrome.tabs.get(message.tabId);
        if (!isArena(tab.url)) throw new Error('This tab is no longer on Arena.');
        await chrome.tabs.update(tab.id, { url: target });
        return true;
      }
      case 'OPEN_ARENA': {
        const tab = await chrome.tabs.create({ url: AGENT_URL });
        return { id: tab.id };
      }
      default: throw new Error('Unsupported companion action.');
    }
  })().then(value => respond({ ok: true, value }), error => respond({ ok: false, code: error.code, error: error.message || 'Chrome action failed.' }));
  return true;
});

// Since v2.3.0 there is no long-lived relay here: the panel connects straight to the content script,
// so the worker being suspended while idle cannot drop the chat. Only one-shot requests remain.
