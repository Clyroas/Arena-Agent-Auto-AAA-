import { setupFloatingGeometry } from './window-geometry.js';
import { ConversationView } from './conversation-view.js';
import { AgentClient } from './agent-client.js';
import { AGENT_URL, isArena, isDirect, tabLabel, samePage, directModelUrl } from './core.js';
import { liveStatus } from './live-status.js';
import './attachment-policy.js'; // Registers ArenaAgentAttachments (same text the page adapter loads).
const { ATTACHMENT_POLICY, validateAttachments, bytesToBase64, formatBytes } = globalThis.ArenaAgentAttachments;
const $ = id => document.getElementById(id);
const floating = location.pathname === '/floating.html';
if (floating) setupFloatingGeometry();
const conversation = new ConversationView(document, answerQuestion);
let tab = null, client = null, pending = null, turns = [], state = 'disconnected';
let busy = false, epoch = 0, dialogResolve = null;
let historyRequest = null;
const staged = []; // Staged files live in memory only, until an accepted send or a local reset.
$('attachment-input').accept = ATTACHMENT_POLICY.accept;
const labels = { disconnected: 'Disconnected', connecting: 'Checking controls…', reconnecting: 'Reconnecting…', ready: 'Auto ready', sending: 'Sending…', waiting: 'Waiting for Arena', error: 'Stopped · check tab' };
const rpc = async (type, extra = {}) => {
  const result = await chrome.runtime.sendMessage({ type, ...extra });
  if (!result?.ok) throw new Error(result?.error || 'The extension worker did not respond. Reload the extension and Arena tab.');
  return result.value;
};
// Settings sheet: slides up under the toolbar; the chat stays the focus when it is closed.
function setSheet(open, { restoreFocus = true } = {}) {
  const sheet = $('settings-sheet'), was = sheet.dataset.open === 'true';
  sheet.dataset.open = String(open); document.body.dataset.sheet = open ? 'open' : '';
  sheet.inert = !open; $('message-arena').inert = open;
  for (const id of ['settings-button', 'status-pill']) $(id).setAttribute('aria-expanded', String(open));
  if (open && !was) requestAnimationFrame(() => $('sheet-done').focus({ preventScroll: true }));
  if (!open && was && restoreFocus && sheet.contains(document.activeElement)) (!$('prompt').disabled ? $('prompt') : $('settings-button')).focus({ preventScroll: true });
}
const toggleSheet = () => setSheet($('settings-sheet').dataset.open !== 'true');
$('settings-button').addEventListener('click', toggleSheet);
$('status-pill').addEventListener('click', toggleSheet);
$('sheet-done').addEventListener('click', () => setSheet(false));
$('sheet-backdrop').addEventListener('click', () => setSheet(false));
$('empty-connect').addEventListener('click', () => setSheet(true));
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && $('settings-sheet').dataset.open === 'true' && !$('confirm-dialog').open) { event.preventDefault(); setSheet(false); }
});
// The composer grows with its text up to a cap, like Messages.
function fitPrompt() { const field = $('prompt'); field.style.height = 'auto'; field.style.height = `${field.scrollHeight}px`; }
$('prompt').addEventListener('input', fitPrompt);
setSheet(true); // Disconnected on open: show the connection setup.
// Messages appear in full, then tuck away into a small dot in the chat corner. Info shrinks by itself
// after a few seconds (not while hovered/focused); errors stay until you minimize them.
const NOTICE_AUTO_MS = 6000;
let noticeTimer = null;
function noticeKind(text) {
  if (state === 'error' || /^[A-Z][A-Z0-9_]{3,}:/.test(text)) return 'error';
  return state === 'reconnecting' ? 'warning' : 'info';
}
function setNoticeOpen(open) {
  const box = $('notice'), dot = $('notice-dot'), has = !!$('notice-text').textContent;
  box.hidden = !has || !open; dot.hidden = !has || open;
  dot.dataset.kind = box.dataset.kind || 'info';
  box.dataset.minimized = String(has && !open);
}
function armNoticeTimer() {
  clearTimeout(noticeTimer);
  if ($('notice').dataset.kind === 'error' || !$('notice-text').textContent) return;
  noticeTimer = setTimeout(() => {
    const box = $('notice');
    if (box.matches(':hover') || box.contains(document.activeElement)) return armNoticeTimer();
    setNoticeOpen(false);
  }, NOTICE_AUTO_MS);
}
function notice(text = '') {
  $('notice-text').textContent = text;
  const kind = noticeKind(text);
  $('notice').dataset.kind = kind;
  $('notice').setAttribute('role', kind === 'error' ? 'alert' : 'status');
  setNoticeOpen(!!text);
  if (text) { $('notice-dot').classList.remove('fresh'); void $('notice-dot').offsetWidth; $('notice-dot').classList.add('fresh'); }
  armNoticeTimer();
}
$('notice-minimize').addEventListener('click', () => { clearTimeout(noticeTimer); setNoticeOpen(false); $('notice-dot').focus({ preventScroll: true }); });
$('notice-dot').addEventListener('click', () => { $('notice-dot').classList.remove('fresh'); setNoticeOpen(true); armNoticeTimer(); });
$('notice').addEventListener('mouseleave', armNoticeTimer);
function render() {
  $('status').textContent = labels[state]; $('status').dataset.state = state;
  document.body.dataset.working = String(!!pending && pending.status !== 'error');
  document.body.dataset.connected = String(!!client?.ready);
  $('connected').hidden = !tab;
  $('connect').disabled = busy || !!tab || !$('tabs').value || !$('confirmed').checked || !$('authorize').checked;
  $('tabs').disabled = busy || !!tab;
  $('confirmed').disabled = busy || !!tab; $('authorize').disabled = busy || !!tab;
  $('prepare').disabled = busy || state !== 'ready' || !client?.ready || !!pending;
  // While reattaching, the draft stays editable; Send waits for the verified connection.
  $('prompt').disabled = pending ? true : busy || (state !== 'reconnecting' && (state !== 'ready' || !client?.ready));
  const uploadReady = client?.ready && client.uploadKind === 'input';
  $('attach-files').disabled = busy || !!pending || state !== 'ready' || !uploadReady;
  $('attach-files').title = uploadReady ? 'Attach images or files from your computer' : 'Staged files can only be sent after the Arena tab exposes its composer file input. Attach them in Arena until then.';
  $('prepare').textContent = staged.length ? `Send to Arena · ${staged.length} file${staged.length > 1 ? 's' : ''}` : 'Send to Arena';
  $('prepare').title = staged.length ? 'Send this message together with the staged files' : '';
  $('prompt').placeholder = state === 'ready' ? 'Type a message to send to Arena…' : state === 'reconnecting' && !pending ? 'Reconnecting to Arena… you can keep typing' : pending?.live?.questions?.length ? 'Answer the question cards above to continue…' : pending ? 'Arena is working on this task…' : 'Connect your Agent tab to start…';
  for (const id of ['refresh', 'open', 'focus', 'reconnect', 'disconnect', 'cancel', 'float-window']) $(id).disabled = busy;
  $('pending').hidden = !pending;
  $('connection-info').hidden = !tab;
  $('connection-summary-text').textContent = tab ? `Tab ${tab.id} · ${tab.title || 'Arena'}` : 'Choose your Arena tab';
  $('connection-summary-text').title = tab ? tabLabel(tab) : '';
  $('connected-tab-short').textContent = tab ? `Tab ${tab.id}` : '';
  $('connected-tab-short').title = tab?.url || '';
  $('pending').dataset.state = pending?.status || '';
  $('pending').dataset.question = String(!!pending?.live?.questions?.length && pending?.status !== 'error');
  $('tab-name').textContent = tab ? tabLabel(tab) : '';
  $('tab-url').textContent = tab?.url || '';
  $('adapter-state').textContent = client?.ready ? (client.reviewPending ? 'Agent task-review panel detected. On your next Send, only its Close control will be used; no feedback will be selected.' : `Agent content script v2.3.0 verified · ${client.inputKind} input · upload: ${client.uploadKind === 'input' ? 'composer file input ready' : client.uploadKind === 'unsupported' ? 'a restricted or ambiguous file input — staged files cannot be sent' : client.uploadKind === 'button-only' ? 'site picker only — attach in Arena' : 'not detected — staged files cannot be sent'}`) : 'Agent control check not ready. Reconnect after fixing the reported issue.';
  $('progress').textContent = pending?.status === 'error' ? 'Capture stopped. Read the error above and check the Arena tab. No manual reply entry is available.' : pending?.phase === 'review' ? 'Closing the task-review panel and waiting for the composer. No feedback is selected.' : pending?.live?.questions?.length ? 'Review the question cards above. Select an answer, then submit it explicitly. Sensitive or unsupported actions stay in Arena.' : pending?.status === 'waiting' ? 'Your message is in Arena. The status above follows its visible activity; the final reply appears separately — no response time limit. Approvals and unsupported controls stay in Arena.' : pending?.phase === 'upload' ? 'Placing your staged files into the Arena composer, then attempting exactly one Send click…' : 'Preparing the Arena composer and attempting exactly one Send click…';
  const found = client?.ready ? client.historyCount || 0 : 0, imported = turns.filter(t => t.imported).length;
  $('history-import').hidden = !client?.ready || (!found && !imported);
  $('load-history').disabled = busy || !!historyRequest || !!pending || state !== 'ready';
  $('load-history').textContent = historyRequest ? 'Loading earlier messages…' : imported ? 'Reload earlier messages' : `Load earlier messages (${found} found)`;
  $('history-import-note').textContent = imported ? `${imported} imported from the Arena page` : 'Read-only · from this Arena chat';
  renderModelChip();
  conversation.render(turns, pending, state);
  updateLiveStatus();
  fitPrompt();
}
// Real-time status: ticks once a second, touching only the pending card's three text nodes.
let statusTimer = null;
function updateLiveStatus() {
  if (!pending) { clearInterval(statusTimer); statusTimer = null; $('pending').dataset.kind = ''; return; }
  const status = liveStatus(pending);
  if ($('pending-title').textContent !== status.step) $('pending-title').textContent = status.step;
  if ($('live-detail').textContent !== status.detail) $('live-detail').textContent = status.detail;
  $('live-detail').hidden = !status.detail;
  if ($('live-elapsed').textContent !== status.meta) $('live-elapsed').textContent = status.meta;
  $('pending').dataset.kind = status.kind;
  if (!statusTimer && pending.status !== 'error') statusTimer = setInterval(updateLiveStatus, 1000);
  if (statusTimer && pending.status === 'error') { clearInterval(statusTimer); statusTimer = null; }
}

function closeClient() { client?.close(); client = null; }
function clear() {
  epoch++; closeClient(); stopRecovery(); if (awakeTab !== null) keepTabAwake(awakeTab, false);
  tab = null; pending = null; turns = []; state = 'disconnected'; historyRequest = null;
  $('connection-details').open = true; setSheet(true);
  $('prompt').value = ''; $('confirmed').checked = false; $('authorize').checked = false;
  for (const file of staged) if (file.url) URL.revokeObjectURL(file.url);
  staged.length = 0; renderAttachments();
  notice(); render();
}
function hasContent() { return !!(turns.length || $('prompt').value || staged.length); }
function askConfirm(title, text, ok = 'Continue', cancel = 'Cancel') {
  $('dialog-title').textContent = title; $('dialog-description').textContent = text;
  $('dialog-ok').textContent = ok; $('dialog-cancel').textContent = cancel; $('confirm-dialog').showModal();
  return new Promise(resolve => { dialogResolve = resolve; });
}
function askClear(text) {
  if (!hasContent()) return Promise.resolve(true);
  $('dialog-title').textContent = 'Clear this session?'; $('dialog-ok').textContent = 'Continue'; $('dialog-cancel').textContent = 'Keep session';
  $('dialog-description').textContent = text; $('confirm-dialog').showModal();
  return new Promise(resolve => { dialogResolve = resolve; });
}
function closeDialog(value) { $('confirm-dialog').close(); dialogResolve?.(value); dialogResolve = null; }
$('dialog-ok').onclick = () => closeDialog(true);
$('dialog-cancel').onclick = () => closeDialog(false);
$('confirm-dialog').addEventListener('cancel', event => { event.preventDefault(); closeDialog(false); });
// ---- Chat mode & model (v2.3.0) ---------------------------------------------------------------
// Direct model choice uses Arena's own link: /text/direct?model_a=<name> opens a NEW empty chat with
// that model. The panel never changes the model of an existing chat and never sends anything here.
let switching = false;
function renderModelChip() {
  const chip = $('model-chip'), ready = !!client?.ready && !!tab;
  chip.hidden = !ready && !switching;
  chip.disabled = busy || switching || !!pending || !ready;
  const direct = client?.pageKind === 'direct';
  $('model-mode').textContent = switching ? 'Switching' : direct ? 'Direct' : 'Agent';
  $('model-name').textContent = switching ? 'Opening in Arena…' : direct ? (client.model || 'Model') : 'Agent Mode';
  chip.dataset.kind = direct ? 'direct' : 'agent';
  chip.title = pending ? 'Wait for the current reply before switching' : 'Choose a Direct model or Agent Mode (opens a new chat in Arena)';
}
function renderModelList() {
  const direct = client?.pageKind === 'direct', models = client?.models || [];
  $('mode-direct').setAttribute('aria-pressed', String(direct)); $('mode-agent').setAttribute('aria-pressed', String(!direct));
  $('model-picker').hidden = !direct || !models.length;
  $('model-agent-note').hidden = direct && models.length > 0;
  $('model-agent-note').querySelector('p').textContent = direct
    ? 'Arena’s model list was not found on this page. Use Arena’s own model picker, or open a new Direct chat.'
    : 'Arena lists its models on Direct chat pages. Open a new Direct chat to pick one — it will appear here.';
  const query = $('model-search').value.trim().toLowerCase(), current = (client?.model || '').toLowerCase();
  const shown = models.filter(m => !query || m.name.toLowerCase().includes(query) || m.org.toLowerCase().includes(query));
  $('model-list').replaceChildren(...shown.slice(0, 200).map(model => {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'model-option'; button.setAttribute('role', 'listitem');
    button.dataset.name = model.name; button.setAttribute('aria-current', String(model.name.toLowerCase() === current));
    const name = document.createElement('span'); name.className = 'model-option-name'; name.textContent = model.name;
    const meta = document.createElement('span'); meta.className = 'model-option-meta';
    meta.textContent = [model.org, model.image ? 'images' : '', model.file ? 'files' : ''].filter(Boolean).join(' · ');
    button.append(name, meta);
    button.addEventListener('click', () => switchChat('direct', model.name));
    return button;
  }));
  if (!shown.length && models.length) { const empty = document.createElement('p'); empty.className = 'model-empty'; empty.textContent = 'No model matches that search.'; $('model-list').append(empty); }
}
function openModelDialog() {
  if ($('model-chip').disabled) return;
  try { client?.queryModel(); } catch { /* reported by the connection */ }
  $('model-search').value = ''; renderModelList(); $('model-dialog').showModal();
  (client?.pageKind === 'direct' && client.models?.length ? $('model-search') : $('model-close')).focus();
}
$('model-chip').addEventListener('click', openModelDialog);
$('model-close').addEventListener('click', () => $('model-dialog').close());
$('model-search').addEventListener('input', renderModelList);
$('mode-agent').addEventListener('click', () => { if (client?.pageKind !== 'direct') { $('model-dialog').close(); return; } switchChat('agent'); });
$('mode-direct').addEventListener('click', () => { if (client?.pageKind === 'direct') return; switchChat('direct', ''); });
$('open-direct').addEventListener('click', () => switchChat('direct', ''));
function waitForTabLoad(tabId, timeoutMs = 30000) {
  let cleanup;
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('The Arena tab did not finish loading. Open Settings to reconnect.')); }, timeoutMs);
    const onUpdated = (id, info) => { if (id === tabId && info.status === 'complete') { cleanup(); resolve(); } };
    const onRemoved = id => { if (id === tabId) { cleanup(); reject(new Error('The Arena tab was closed.')); } };
    cleanup = () => { clearTimeout(timer); chrome.tabs.onUpdated.removeListener(onUpdated); chrome.tabs.onRemoved.removeListener(onRemoved); };
    chrome.tabs.onUpdated.addListener(onUpdated); chrome.tabs.onRemoved.addListener(onRemoved);
  });
  return { done, cancel: () => cleanup() };
}
const sameModel = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
async function confirmModel(name) {
  // Arena applies ?model_a= after the page hydrates; give it a few seconds, then report what it shows.
  for (let i = 0; i < 16 && client?.ready; i++) {
    if (sameModel(client.model, name)) return true;
    try { client.queryModel(); } catch { return false; }
    await new Promise(r => setTimeout(r, 500));
  }
  return sameModel(client?.model, name);
}
async function switchChat(kind, name = '') {
  if (!tab || pending || busy || switching) return;
  const target = kind === 'agent' ? AGENT_URL : directModelUrl(name);
  const title = kind === 'agent' ? 'Open Agent Mode?' : name ? `New chat with ${name}?` : 'Open a new Direct chat?';
  const body = `Your connected Arena tab will open ${kind === 'agent' ? 'Agent Mode' : name ? `a new Direct chat with “${name}” selected by Arena` : 'a new Direct chat'}. Nothing is sent. This panel’s chat view is cleared; your Arena history is unchanged.${$('prompt').value || staged.length ? ' Your draft and staged files stay here.' : ''}`;
  $('model-dialog').close();
  if (!await askConfirm(title, body, 'Open', 'Cancel')) return;
  const tabId = tab.id;
  switching = true; epoch++; closeClient(); stopRecovery();
  pending = null; turns = []; historyRequest = null; state = 'connecting';
  notice(kind === 'agent' ? 'Opening Agent Mode in your Arena tab…' : `Opening a new Direct chat${name ? ` with ${name}` : ''} in your Arena tab…`); render();
  const load = waitForTabLoad(tabId);
  try {
    await rpc('NAVIGATE_TAB', { tabId, url: target });
    await load.done;
    switching = false;
    await connect(tabId);
    if (!client?.ready) return;
    if (kind === 'direct' && name) {
      const confirmed = await confirmModel(name);
      notice(confirmed ? `New Direct chat with ${client.model}. Send a message below — nothing has been sent yet.`
        : `MODEL_NOT_CONFIRMED: Arena shows “${client?.model || 'an unknown model'}” instead of “${name}”. Check or change the model in Arena’s picker before sending — the extension will not switch it for you.`);
    } else notice(client.pageKind === 'direct' ? `New Direct chat${client.model ? ` with ${client.model}` : ''}. Pick a model from the chip above the message box if you like.` : 'Agent Mode is ready. Send a message below.');
  } catch (error) {
    load.cancel(); state = 'error'; notice(error.message || 'Could not open that Arena page. Open Settings to reconnect.');
  } finally { switching = false; render(); }
}
// Keep the chip current if the model is changed in Arena's own picker.
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && client?.ready) { try { client.queryModel(); } catch { /* ignore */ } } });

async function refresh() {
  const selected = $('tabs').value, tabs = await rpc('LIST_TABS');
  $('tabs').replaceChildren();
  if (!tabs.length) {
    const option = document.createElement('option'); option.value = ''; option.textContent = 'No Arena tabs — open Agent below'; $('tabs').append(option);
  }
  for (const item of tabs) {
    const option = document.createElement('option'); option.value = String(item.id);
    option.textContent = tabLabel(item) + (isDirect(item.url) ? ' · unsupported text mode' : ''); $('tabs').append(option);
  }
  if (tabs.some(item => String(item.id) === selected)) $('tabs').value = selected;
  render();
}
function answerQuestion(turnId, answer) {
  if (!pending || pending.id !== turnId || pending.status !== 'waiting' || state === 'error' || !client?.ready) return;
  const question = pending.live?.questions?.find(q => q.token === answer.token);
  if (!question || question.readOnly || question.answerState || question.busy) return;
  for (const card of pending.live.questions) card.busy = true;
  question.answerState = 'Submitting your answer…'; pending.liveRevision = (pending.liveRevision || 0) + 1;
  try { client.answer(turnId, answer); }
  catch { question.answerState = 'Connection lost while answering. Check Arena; no automatic retry.'; }
  render();
}
// Earlier turns are a read-only snapshot of the open conversation, kept above this panel's own turns.
function receiveHistory(event) {
  if (!historyRequest || event.requestId !== historyRequest) return;
  historyRequest = null;
  if (event.type === 'HISTORY_ERROR') { notice(`${event.code}: ${event.message}`); return; }
  if (tab && event.url && !samePage(event.url, tab.url)) { notice('The Arena conversation changed while loading. Reconnect before loading its history.'); return; }
  const own = turns.filter(t => !t.imported);
  const ownIds = new Set(own.map(t => t.userMessageId).filter(Boolean));
  const list = Array.isArray(event.turns) ? event.turns : [];
  const firstOwn = list.findIndex(t => ownIds.has(t.userMessageId));
  const earlier = (firstOwn >= 0 ? list.slice(0, firstOwn) : list).filter(t => !ownIds.has(t.userMessageId));
  const importedTurns = earlier.map(t => ({
    id: `arena-${t.userMessageId}`, imported: true, prompt: String(t.prompt || ''), reply: t.status === 'complete' ? String(t.reply || '') : '',
    status: t.status === 'complete' ? 'complete' : `imported-${t.status}`, userMessageId: t.userMessageId, assistantMessageId: t.assistantMessageId,
    model: typeof t.model === 'string' ? t.model.slice(0, 120) : '', mode: client?.pageKind === 'direct' ? 'direct' : 'agent',
    live: (t.tools?.length || t.thinking) ? { text: '', tools: t.tools || [], questions: [], interactionNotice: '', thinking: t.thinking || null } : undefined
  }));
  turns = [...importedTurns, ...own];
  const unclear = importedTurns.filter(t => t.status !== 'complete').length;
  const parts = [importedTurns.length ? `Loaded ${importedTurns.length} earlier turn${importedTurns.length === 1 ? '' : 's'} from this Arena chat.` : 'No earlier turns were found on the page.'];
  if (unclear) parts.push(`${unclear} had no single clear reply and are marked — read those in Arena.`);
  if (event.startMissing) parts.push('The start of this chat may not be loaded on the page: scroll up in Arena, then click Reload earlier messages.');
  if (event.truncated) parts.push('Only the first 200 turns / 2 million characters were loaded.');
  if (event.inProgressSkipped) parts.push('The newest turn is still running in Arena and was not imported.');
  notice(parts.join(' '));
}
// ---- Staying connected -------------------------------------------------------------------------
// The panel↔tab port can still drop if Arena reloads, Chrome discards/freezes the tab, or the page
// is replaced. Then the panel reattaches to the SAME tab and SAME conversation URL on its own, with
// backoff. It never resends: an accepted message is re-watched read-only; one that was mid-send is
// marked for you to check in Arena. A different page, a closed tab or another panel stops it.
const RECOVERY_DELAYS = [0, 2000, 5000, 15000, 30000, 60000];
let recovery = { attempt: 0, timer: null, running: false };
let awakeTab = null;
function keepTabAwake(tabId, keep) {
  // While connected, ask Chrome not to discard the Arena tab to save memory (it would reload later).
  try { chrome.tabs.update(tabId, { autoDiscardable: !keep }).catch(() => {}); } catch { /* tab gone */ }
  awakeTab = keep ? tabId : null;
}
function stopRecovery() { clearTimeout(recovery.timer); recovery = { attempt: 0, timer: null, running: false }; }
function scheduleRecovery(delay) {
  clearTimeout(recovery.timer);
  recovery.timer = setTimeout(recoverNow, delay ?? RECOVERY_DELAYS[Math.min(recovery.attempt, RECOVERY_DELAYS.length - 1)]);
}
function interrupt(turn, text) {
  turn.status = 'error'; turn.code = 'CONNECTION_INTERRUPTED'; turn.outcomeText = text;
  if (pending === turn) pending = null;
}
function giveUp(message, turnText) {
  stopRecovery(); state = 'error';
  if (pending) interrupt(pending, turnText || 'The connection ended before the reply arrived. Read it in Arena; nothing was resent.');
  notice(message);
}
function connectionLost(event) {
  const old = client; client = null; old?.close();
  if (!tab || !event.wasReady) {
    state = 'error'; if (pending) pending.status = 'error';
    notice(`${event.code ? event.code + ': ' : ''}${event.message}`); return;
  }
  if (pending) {
    if (pending.status === 'waiting' && pending.userMessageId) { pending.phase = 'reconnecting'; pending.resume = true; }
    else interrupt(pending, 'The connection dropped while this message was being sent. Check Arena before sending it again — it may or may not have been submitted.');
  }
  state = 'reconnecting';
  notice('Lost the connection to the Arena tab. Reconnecting automatically — nothing will be resent.');
  scheduleRecovery(0);
}
async function recoverNow() {
  if (state !== 'reconnecting' || !tab || recovery.running) return;
  recovery.running = true; recovery.attempt++;
  const version = epoch; let next = null;
  try {
    const current = await rpc('GET_TAB', { tabId: tab.id });
    if (epoch !== version || state !== 'reconnecting') return;
    if (current.discarded) throw new Error('Chrome put the Arena tab to sleep. Click “Go to Arena tab” in Settings to wake it; the panel reattaches by itself.');
    if (current.status === 'loading') throw new Error('The Arena tab is still loading.');
    if (!samePage(current.url, tab.url)) {
      giveUp('The Arena tab is now on a different page, so the panel did not reattach automatically. Open Settings and use Reconnect to connect to that page.',
        'The Arena tab moved to a different page while this reply was being tracked. Read it in Arena; nothing was resent.');
      return;
    }
    next = new AgentClient(tab.id, event => {
      if (epoch !== version || client !== next) return;
      if (!next.ready && event.type === 'ERROR' && !event.requestId) return; // reported through readiness below
      receive(event);
    }, tab.url);
    client = next;
    await next.readiness;
    if (epoch !== version || client !== next) return;
    stopRecovery(); keepTabAwake(tab.id, true);
    if (pending?.resume) {
      pending.resume = false; pending.phase = ''; pending.resumed = true; state = 'waiting';
      next.watch(pending.id, pending.prompt, pending.userMessageId, tab.url, !!pending.attachments?.length);
      notice('Reconnected to the Arena tab. Still tracking your message — nothing was resent.');
    } else { state = 'ready'; notice('Reconnected to the Arena tab automatically. Nothing was resent.'); }
  } catch (error) {
    if (next && client === next) { client = null; next.close(); }
    if (epoch !== version || state !== 'reconnecting') return;
    const text = error.message || '';
    if (/no tab with id/i.test(text)) { giveUp('The Arena tab was closed. Open Arena and connect again from Settings.', 'The Arena tab was closed before the reply arrived.'); return; }
    if (/no longer on Arena|TAB_IN_USE/i.test(text)) { giveUp(`${text} Open Settings to connect again.`); return; }
    notice(`Reconnecting to the Arena tab… (attempt ${recovery.attempt}) ${text}`.trim());
    scheduleRecovery();
  } finally { recovery.running = false; render(); }
}
const nudgeRecovery = () => { if (state === 'reconnecting' && !recovery.running) scheduleRecovery(0); };
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') nudgeRecovery(); });
window.addEventListener('focus', nudgeRecovery);
chrome.tabs.onUpdated.addListener((tabId, info) => { if (tab && tabId === tab.id && info.status === 'complete') nudgeRecovery(); });

function receive(event) {
  if (event.type === 'MODEL_INFO') { render(); if ($('model-dialog').open) renderModelList(); return; }
  if (event.type === 'BRIDGE_LOST') { connectionLost(event); render(); return; }
  if (event.type === 'ERROR' && !event.requestId) {
    state = 'error'; if (pending) pending.status = 'error';
    notice(`${event.code ? event.code + ': ' : ''}${event.message}`); render(); return;
  }
  if (event.type === 'HISTORY' || event.type === 'HISTORY_ERROR') { receiveHistory(event); render(); return; }
  const turn = pending;
  if (!turn || event.requestId !== turn.id) return;
  switch (event.type) {
    case 'REVIEW_HANDLING': state = 'sending'; turn.status = 'sending'; turn.phase = 'review'; notice('Closing Arena’s task-review panel to restore the composer. No Yes/No feedback is selected.'); break;
    case 'SENDING': state = 'sending'; turn.status = 'sending'; turn.phase = ''; break;
    case 'ACCEPTED':
      state = 'waiting'; turn.status = 'waiting'; turn.userMessageId = event.userMessageId;
      turn.acceptedAt ||= Date.now(); turn.lastActivityAt = Date.now();
      notice('Arena accepted your message. Live updates and supported question cards appear below; the final reply stays separate.'); break;
    case 'LIVE_UPDATE':
      { const now = Date.now();
        if ((event.text || '') !== (turn.live?.text || '')) turn.textChangedAt = now;
        turn.lastActivityAt = now; turn.acceptedAt ||= now;
        turn.live = { text: event.text, tools: event.tools, questions: event.questions, interactionNotice: event.interactionNotice, thinking: event.thinking || null, generating: !!event.generating };
        turn.liveRevision = (turn.liveRevision || 0) + 1; }
      break;
    case 'QUESTION_ERROR':
      { const question = turn.live?.questions?.find(q => q.token === event.token); if (question) question.answerState = event.message;
        turn.liveRevision = (turn.liveRevision || 0) + 1; notice(event.message); }
      break;
    case 'QUESTION_SENT': notice('Your answer was attempted once and Arena’s question changed. Continuing to track this task.'); break;
    case 'URL_BOUND': tab.url = event.url; break;
    case 'COMPLETE':
      turn.reply = event.text; turn.status = 'complete'; turn.userMessageId = event.userMessageId; turn.assistantMessageId = event.assistantMessageId;
      turn.model = typeof event.model === 'string' ? event.model.slice(0, 120) : '';
      tab.url = event.url; pending = null; state = 'ready';
      notice('Reply received automatically.'); break;
    case 'STAGED': turn.phase = 'upload'; break;
    case 'WATCHING': turn.phase = ''; break;
    case 'ERROR':
      if (turn.resumed && client?.ready) {
        // Re-watching after a reconnect failed (e.g. the message is gone after a reload). The
        // connection itself is fine, so finish this turn and keep the chat usable. Nothing is resent.
        turn.status = 'error'; turn.code = event.code; turn.outcomeText = `${event.message}`; pending = null; state = 'ready';
        notice(`${event.code}: ${event.message}`); break;
      }
      state = 'error'; turn.status = 'error'; turn.code = event.code;
      // Nothing was clicked in the page: hand the exact File objects back to the panel composer.
      if (turn.payload?.length && !event.clicked && !staged.length) {
        for (const [index, meta] of turn.payload.entries()) {
          const file = turn.files?.[index];
          if (!(file instanceof File)) continue;
          staged.push({ name: meta.name, type: meta.type, size: file.size, file });
          if (meta.type.startsWith('image/')) { try { staged.at(-1).url = URL.createObjectURL(file); } catch { /* preview only */ } }
        }
        turn.payload = null; turn.files = null; renderAttachments();
        if (!$('prompt').value) $('prompt').value = turn.prompt; // nothing reached Arena's Send, so keep the draft together
        notice(`${event.code}: ${event.message} Your staged files were returned to this composer.`);
      }
      notice(turn.resumed ? `${event.code}: ${event.message}` : `${event.code}: ${event.message} ${event.clicked ? 'Send was attempted once. Check Arena before resending.' : 'No Send click was attempted for this request. Text may remain in the Arena composer.'}`); break;
  }
  render();
}
async function connect(id) {
  const version = ++epoch;
  closeClient(); state = 'connecting'; render();
  const selected = await rpc('GET_TAB', { tabId: id });
  if (epoch !== version) return;
  if (!isArena(selected.url) || isDirect(selected.url)) throw new Error('Battle and Side-by-Side are not supported. Open Agent Mode or a Direct (one model) chat. It will not fall back to manual copying.');
  tab = selected; render();
  const next = new AgentClient(id, event => { if (epoch === version && client === next) receive(event); }, selected.url);
  client = next;
  try { await next.readiness; }
  catch (error) { next.close(); if (client === next) client = null; throw error; }
  if (version !== epoch) return;
  state = 'ready'; $('connection-details').open = false; setSheet(false); keepTabAwake(selected.id, true);
  notice('Connected. Send a message below — replies appear right here.');
}
function action(id, fn) {
  $(id).addEventListener('click', async () => {
    if (busy) return;
    busy = true; notice(); render(); const version = epoch;
    try { await fn(); }
    catch (error) {
      // Never convert a failure into manual mode or request pasted replies.
      if (tab || version === epoch || id === 'connect') {
        if (pending || !client?.ready) state = 'error'; if (pending) pending.status = 'error'; notice(error.message || 'Unexpected extension error. Check Arena before resending.');
      }
    } finally { busy = false; render(); }
  });
}
for (const id of ['tabs', 'confirmed', 'authorize']) $(id).addEventListener('change', render);
$('load-history').addEventListener('click', () => {
  if ($('load-history').disabled || !client?.ready || !tab) return;
  historyRequest = crypto.randomUUID();
  try { client.loadHistory(historyRequest, tab.url); }
  catch (error) { historyRequest = null; notice(error.message); }
  render();
});
action('refresh', refresh);
action('float-window', async () => {
  if (!await askClear('Open the floating window and clear this local session? History is not transferred. Any request already sent continues in Arena; wait for it to finish before switching.')) return;
  clear(); await rpc('OPEN_FLOATING'); notice('Floating window opened. Connect your Arena tab there.'); await refresh();
});
action('open', async () => { await rpc('OPEN_ARENA'); await refresh(); notice('Agent Mode opened in a new tab. Sign in and select your model there, then connect that tab here.'); });
action('connect', async () => {
  if (!$('confirmed').checked || !$('authorize').checked) throw new Error('Review both confirmations before connecting.');
  await connect(Number($('tabs').value));
});
action('focus', async () => { if (tab) await rpc('FOCUS_TAB', { tabId: tab.id }); });
action('disconnect', async () => {
  if (!await askClear('Disconnect and clear this panel? Any request already accepted by Arena may continue there.')) return;
  clear(); await refresh(); notice('Disconnected. The local session was cleared; Arena history is unchanged.');
});
action('reconnect', async () => {
  if (!await askClear('Reconnect and clear this local session? Check Arena before resending any accepted prompt.')) return;
  const id = tab?.id; clear();
  if (!Number.isInteger(id)) return;
  notice('Session cleared. Check the selected Agent tab and tick the confirmations again, then connect.');
  await refresh(); $('tabs').value = String(id);
});
action('prepare', async () => {
  if (state !== 'ready' || !client?.ready || pending || !tab) throw new Error('Connect and verify the Agent controls before sending.');
  const text = $('prompt').value.trim();
  if (!text || text.length > 30000) throw new Error('Enter a message of 1–30,000 characters with any attachments.');
  if (staged.length && !client?.ready) throw new Error('Connect and verify the Agent tab before sending staged files.');
  if (staged.length && client?.uploadKind !== 'input') throw new Error(client?.uploadKind === 'unsupported' ? 'The Arena composer file input restricts file types or is ambiguous, so staged files cannot be placed there. Attach them in the Arena tab; nothing was sent.' : 'The connected Arena tab does not expose a usable composer file input, so staged files cannot be sent. Remove them here or attach them in the Arena tab; nothing was sent.');
  const files = staged.map(item => item.file), payload = [];
  for (const item of staged) {
    const buffer = await item.file.arrayBuffer();
    if (!buffer.byteLength || buffer.byteLength > ATTACHMENT_POLICY.maxBytes) throw new Error(`"${item.name}" could not be read within the size limit. Nothing was sent.`);
    payload.push({ name: item.name, type: item.type, data: bytesToBase64(new Uint8Array(buffer)) });
  }
  const version = epoch, current = await rpc('GET_TAB', { tabId: tab.id });
  if (version !== epoch) return;
  if (current.url !== tab.url) { closeClient(); throw new Error('The Arena URL changed. Reconnect to verify the current Agent conversation.'); }
  const turn = { id: crypto.randomUUID(), mode: client?.pageKind === 'direct' ? 'direct' : 'agent', prompt: text, reply: '', status: 'sending', attachments: staged.map(({ name, size, type }) => ({ name, size, type })), payload, files };
  turns.push(turn); pending = turn; state = 'sending'; $('prompt').value = '';
  for (const item of staged.splice(0)) if (item.url) URL.revokeObjectURL(item.url);
  renderAttachments();
  await client.send(turn.id, turn.prompt, tab.url, turn.payload);
  notice(turn.attachments.length ? `Submitting your message and ${turn.attachments.length} staged file${turn.attachments.length > 1 ? 's' : ''} through Arena’s visible controls.` : 'Submitting through Arena’s visible controls. No copy/paste action is required.');
});
function formatName(name) { const text = String(name); return text.length > 34 ? `${text.slice(0, 14)}…${text.slice(-16)}` : text; }
function stageFiles(list, origin) {
  const files = [...(list || [])];
  if (!files.length) return false;
  const room = ATTACHMENT_POLICY.maxFiles - staged.length;
  if (room <= 0) { $('attachment-status').textContent = `Only ${ATTACHMENT_POLICY.maxFiles} files fit in one message.`; return true; }
  const { accepted, rejected } = validateAttachments(files.slice(0, room));
  for (const meta of accepted) {
    const file = files.find(item => item.name === meta.name && item.size === meta.size && item.type === (meta.type || item.type)) || files[0];
    staged.push({ ...meta, file });
    if (meta.type.startsWith('image/')) { const item = staged.at(-1); try { item.url = URL.createObjectURL(file); } catch { /* preview only */ } }
  }
  $('attachment-status').textContent = rejected.length ? `Skipped ${rejected.length}: ${rejected[0].reason}` : '';
  renderAttachments(); render();
  return true;
}
function renderAttachments() {
  const chips = $('attachment-chips');
  chips.replaceChildren(...staged.map((item, index) => {
    const chip = document.createElement('span'); chip.className = 'attachment-chip';
    if (item.url) { const thumb = document.createElement('img'); thumb.src = item.url; thumb.alt = ''; chip.append(thumb); }
    const label = document.createElement('span'); label.className = 'attachment-name';
    label.textContent = `${formatName(item.name)} · ${formatBytes(item.size)}`; label.title = item.name;
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'attachment-remove';
    remove.textContent = '×'; remove.setAttribute('aria-label', `Remove ${item.name}`);
    remove.onclick = () => { const [gone] = staged.splice(index, 1); if (gone?.url) URL.revokeObjectURL(gone.url); $('attachment-status').textContent = ''; renderAttachments(); render(); };
    chip.append(label, remove); return chip;
  }));
  $('attachments').hidden = !staged.length;
}
$('attach-files').addEventListener('click', () => { if (!$('attach-files').disabled) $('attachment-input').click(); });
$('attachment-input').addEventListener('change', () => { stageFiles($('attachment-input').files, 'picker'); $('attachment-input').value = ''; });
$('prompt').addEventListener('paste', event => {
  const list = [...(event.clipboardData?.items || [])].filter(item => item.kind === 'file' && item.type.startsWith('image/'))
    .map(item => item.getAsFile()).filter(Boolean);
  // Only intercept pasted images; text pastes must reach the caret untouched.
  if (list.length) { event.preventDefault(); if (stageFiles(list, 'paste')) $('attachment-status').textContent = ''; }
});
const composer = document.querySelector('.arena-composer');
composer.addEventListener('dragover', event => { if (event.dataTransfer?.types?.includes('Files')) { event.preventDefault(); composer.dataset.dragging = 'true'; } });
composer.addEventListener('dragleave', event => { if (!composer.contains(event.relatedTarget)) composer.dataset.dragging = 'false'; });
composer.addEventListener('drop', event => {
  if (!event.dataTransfer?.types?.includes('Files')) return;
  event.preventDefault(); composer.dataset.dragging = 'false'; stageFiles(event.dataTransfer.files, 'drop');
});
// Keyboard shortcut is local to the panel composer, never a synthetic Enter in Arena.
// Reuse the button path so connection, busy, draft and single-send checks stay identical.
let composingPrompt = false;
$('prompt').addEventListener('compositionstart', () => { composingPrompt = true; });
$('prompt').addEventListener('compositionend', () => { composingPrompt = false; });
$('prompt').addEventListener('blur', () => { composingPrompt = false; });
$('prompt').addEventListener('keydown', event => {
  if (event.defaultPrevented || event.key !== 'Enter' || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return;
  // IME Enter confirms a candidate; it must not submit the chat.
  if (composingPrompt || event.isComposing || event.keyCode === 229) return;
  event.preventDefault();
  if (event.repeat || $('prompt').disabled || $('prepare').disabled || !$('prompt').value.trim()) return;
  $('prepare').click();
});
action('cancel', async () => {
  if (!pending) return;
  if (!await askClear('Stop tracking this turn? This does not stop generation in Arena. Check the tab before another send.')) return;
  client?.cancel(pending.id); pending.status = 'cancelled'; pending = null;
  state = client?.ready ? 'ready' : 'error';
  notice('Local tracking stopped. Nothing was retried. Check Arena before sending another message.');
});
chrome.tabs.onRemoved.addListener(id => {
  if (tab?.id === id) { closeDialog(false); clear(); notice('The connected Arena tab closed. This session was cleared.'); }
  refresh().catch(error => notice(error.message));
});
chrome.tabs.onUpdated.addListener((id, change) => {
  if (tab?.id !== id || pending) return; // Pending navigation is guarded by the content script.
  // A reload of the same page is handled by the automatic reattach above (history is kept).
  // Moving to a different page stops the connection but keeps this chat visible until you reconnect.
  if (change.url && !samePage(change.url, tab.url) && (client || state === 'reconnecting') && !switching) {
    const old = client; client = null; old?.close(); stopRecovery(); state = 'error';
    notice('The Arena tab moved to a different page. Your chat here is kept; open Settings → Reconnect to connect to the page now shown in Arena.');
    render();
  }
});
// Minimizing, covering or switching tabs keeps the session; closing the panel/window ends it (the port closes with the page).
window.addEventListener('pagehide', () => { closeDialog(false); clear(); });
window.addEventListener('pagehide', () => { closeDialog(false); clear(); });
refresh().catch(error => { state = 'error'; notice(error.message); render(); });
