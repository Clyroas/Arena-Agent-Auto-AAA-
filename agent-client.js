// Panel-side connection. Since v2.3.0 the panel holds a DIRECT port to the Arena tab's top-frame
// content script (chrome.tabs.connect from this extension page). The MV3 service worker is only
// used for short one-shot requests (attach/inject, staged-file grants), so Chrome suspending the
// idle worker can no longer drop the chat connection.
import { VERSION } from './version.js';
export const ADAPTER_VERSION = VERSION;
export const HEARTBEAT_MS = 10000;

export class AgentClient {
  constructor(tabId, onEvent, expectedUrl) {
    this.closed = false; this.ready = false; this.onEvent = onEvent; this.tabId = tabId; this.port = null;
    this.readiness = new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
    this.readiness.catch(() => {}); // callers await it; avoid unhandled rejections after close
    this.timeout = setTimeout(() => this.fail('ADAPTER_HANDSHAKE_TIMEOUT: The Agent adapter did not finish connecting within 15 seconds. Check the Arena tab and this extension’s Site access in chrome://extensions. No prompt was sent.'), 15000);
    this.start(expectedUrl);
  }
  async start(expectedUrl) {
    let attached;
    try {
      const result = await chrome.runtime.sendMessage({ type: 'ATTACH', tabId: this.tabId, expectedUrl });
      if (!result?.ok) throw Object.assign(new Error(result?.error || 'The extension worker did not respond. Reload the extension and the Arena tab.'), { code: result?.code || 'CONNECTION_FAILED' });
      attached = result.value;
    } catch (error) {
      if (this.closed) return;
      const message = `${error.code || 'CONNECTION_FAILED'}: ${error.message}`;
      this.fail(message); this.onEvent({ type: 'ERROR', code: error.code || 'CONNECTION_FAILED', message: error.message, clicked: false });
      return;
    }
    if (this.closed) return;
    this.documentId = attached.documentId;
    try { this.port = chrome.tabs.connect(this.tabId, { name: 'arena-agent-content-v3', documentId: attached.documentId }); }
    catch (error) { this.lost(`Chrome could not open a connection to the Arena tab (${error.message}).`); return; }
    this.port.onMessage.addListener(event => this.handle(event));
    this.port.onDisconnect.addListener(() => {
      const detail = chrome.runtime.lastError?.message;
      this.lost(`The Arena tab connection closed.${detail ? ' Browser detail: ' + detail : ''}`);
    });
    this.heartbeat = setInterval(() => {
      if (this.closed) return;
      try { this.port.postMessage({ type: 'PING' }); } catch { this.lost('The Arena tab connection closed.'); }
    }, HEARTBEAT_MS);
    this.post({ type: 'PROBE' });
  }
  handle(event) {
    if (this.closed) return;
    if (event.type === 'READY') {
      if (event.adapterVersion !== ADAPTER_VERSION) {
        const message = 'Wrong content-script version. Reload the Arena tab after updating the extension, then reconnect.';
        this.fail(message); this.onEvent({ type: 'ERROR', code: 'VERSION_MISMATCH', message, clicked: false }); this.close(); return;
      }
      this.ready = true; this.inputKind = event.inputKind || 'unknown'; this.reviewPending = !!event.reviewPending; this.uploadKind = event.uploadKind || 'none';
      this.fileInputCount = event.fileInputCount || 0; this.historyCount = event.historyCount || 0;
      this.setModelInfo(event); clearTimeout(this.timeout); this.resolve(event);
    }
    if (event.type === 'MODEL_INFO') this.setModelInfo(event);
    if (event.type === 'SENDING') { this.reviewPending = false; this.inputKind = event.inputKind || this.inputKind; }
    if (event.type === 'ERROR' && !this.ready) this.fail(`${event.code || 'CONNECTION_FAILED'}: ${event.message}`);
    this.onEvent(event);
  }
  setModelInfo(event) {
    this.pageKind = event.pageKind === 'direct' ? 'direct' : 'agent';
    this.model = typeof event.model === 'string' ? event.model : '';
    if (Array.isArray(event.models) && (event.models.length || !this.models?.length)) this.models = event.models.slice(0, 400);
  }
  queryModel() { this.post({ type: 'MODEL' }); }
  // Unexpected loss (tab reloaded/discarded, page closed). The panel decides whether to reattach.
  lost(message) {
    if (this.closed) return;
    const wasReady = this.ready;
    this.fail(message); this.shutdown();
    this.onEvent({ type: 'BRIDGE_LOST', code: 'CONNECTION_LOST', message, wasReady });
  }
  post(message) { if (this.closed || !this.port) throw new Error('The Arena connection is not ready.'); this.port.postMessage(message); }
  fail(message) { clearTimeout(this.timeout); this.reject(new Error(message)); }
  async send(requestId, prompt, url, attachments) {
    if (this.closed || !this.ready) throw new Error('The Agent adapter is not connected. Reconnect to Arena.');
    if (attachments?.length) {
      // Single-use, 20-second permission for the page-context file insertion of this one Send.
      const grant = await chrome.runtime.sendMessage({ type: 'STAGE_GRANT', tabId: this.tabId, documentId: this.documentId });
      if (!grant?.ok) throw new Error(grant?.error || 'The staged files could not be prepared. Nothing was sent.');
      if (this.closed || !this.ready) throw new Error('The Arena connection closed before sending. Nothing was sent.');
    }
    this.post({ type: 'SEND', requestId, prompt, url, ...(attachments?.length ? { attachments } : {}) });
  }
  // Resume tracking an already-accepted message after a reconnect. Read-only: never clicks or resends.
  watch(requestId, prompt, userMessageId, url, hadAttachments) {
    if (this.closed || !this.ready) throw new Error('The Arena connection is not ready.');
    this.post({ type: 'WATCH', requestId, prompt, userMessageId, url, hadAttachments: !!hadAttachments });
  }
  answer(requestId, answer) {
    if (this.closed || !this.ready) throw new Error('The Arena connection is not ready.');
    this.post({ type: 'ANSWER_QUESTION', requestId, ...answer });
  }
  loadHistory(requestId, url) {
    if (this.closed || !this.ready) throw new Error('The Arena connection is not ready.');
    this.post({ type: 'LOAD_HISTORY', requestId, url });
  }
  cancel(requestId) {
    if (this.closed) return;
    try { this.port?.postMessage({ type: 'CANCEL', requestId }); } catch { /* already closed */ }
    if (this.documentId) chrome.runtime.sendMessage({ type: 'STAGE_REVOKE', tabId: this.tabId, documentId: this.documentId }).catch(() => {});
  }
  shutdown() {
    this.closed = true; this.ready = false;
    clearInterval(this.heartbeat); clearTimeout(this.timeout);
  }
  close() {
    if (this.closed) return;
    this.shutdown();
    this.reject(new Error('Agent connection closed.'));
    try { this.port?.disconnect(); } catch { /* already closed */ }
    if (this.documentId) chrome.runtime.sendMessage({ type: 'STAGE_REVOKE', tabId: this.tabId, documentId: this.documentId }).catch(() => {});
  }
}
