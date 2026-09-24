(() => {
  'use strict';
  const VERSION = globalThis.ArenaAgentVersion?.VERSION ?? null;
  if (!VERSION) throw new Error('Arena Agent Auto Chat: version.js must load before agent-content.js.');
  const runtime = chrome.runtime;
  // Guard against re-executing this file's body in the same document. Chrome can run a
  // content script twice per page load when manifest-declared injection and a
  // chrome.scripting.executeScript(files: ...) call overlap; re-running would dispose the
  // live registration (and its connected port) mid-attach and make the panel's probe fail
  // with SCRIPT_REGISTRATION_FAILED even though everything is healthy.
  if (globalThis.__ARENA_AGENT_CONTENT_LOADED__ === VERSION) {
    const live = globalThis.__ARENA_AGENT_REGISTRATION__;
    if (live?.version === VERSION && live.isAlive?.()) return;
  }
  globalThis.__ARENA_AGENT_CONTENT_LOADED__ = VERSION;
  const previous = globalThis.__ARENA_AGENT_REGISTRATION__;
  if (previous?.version === VERSION && previous.isAlive?.()) return;
  // A stale registration (e.g. left by an older/removed extension build whose runtime id is gone)
  // must be deleted before re-registering, otherwise the panel's probe sees the dead entry and
  // reports SCRIPT_REGISTRATION_FAILED forever until a manual reload.
  try { previous?.dispose?.(); } catch { /* old invalidated context */ }
  if (previous && !previous.isAlive?.()) { try { delete globalThis.__ARENA_AGENT_REGISTRATION__; } catch { /* frozen object */ } }
  const D = globalThis.ArenaAgentDOM;
  let owner = null, transaction = null, lastHeartbeat = 0, timer = null, observer = null;
  let scanQueued = false;
  // Liveness comes from the port itself (it closes with the panel or page). The lease only guards
  // against a silent panel, and is long enough for Chrome's once-a-minute timer throttling.
  const LEASE_MS = 5 * 60 * 1000;
  const consumed = new Set();
  const documentId = crypto.randomUUID();
  function emit(message) { try { owner?.postMessage({ ...message, documentId, adapterVersion: VERSION }); } catch { cleanup(); } }
  function stopTransaction() { transaction = null; }
  function cleanup() {
    stopTransaction(); observer?.disconnect(); observer = null;
    clearInterval(timer); timer = null;
    const old = owner; owner = null;
    try { old?.disconnect(); } catch { /* already closed */ }
  }
  function error(error, tx = transaction) {
    emit({ type: 'ERROR', requestId: tx?.requestId || null, code: error.code || 'ADAPTER_ERROR',
      message: error.code ? error.message : 'The Agent DOM adapter failed. Inspect the Arena tab. No retry was attempted.',
      reviewCloseAttempted: !!tx?.reviewCloseAttempted, clicked: !!tx?.clicked, accepted: !!tx?.userId });
    if (transaction === tx) stopTransaction();
  }
  function checkUrl(tx, result) {
    if (D.samePage(location.href, tx.url)) return;
    // Permit one first-message SPA URL assignment only while the verified new user row
    // still anchors the same document. All existing-conversation URL changes stop capture.
    if (location.origin === 'https://arena.ai' && tx.baseline.length === 0 && !tx.urlAssigned &&
        result.accepted && !/^\/(?:text|leaderboard|history|auth|login)(?:\/|$)/.test(location.pathname)) {
      tx.url = location.href; tx.urlAssigned = true;
      emit({ type: 'URL_BOUND', requestId: tx.requestId, url: tx.url });
      return;
    }
    // SPA may set URL just before inserting its user row; wait at most 2 seconds for proof.
    if (!tx.baseline.length && !tx.urlAssigned && !result.accepted) {
      tx.urlChangedAt ||= Date.now();
      if (Date.now() - tx.urlChangedAt < 2000) return;
    }
    D.fail('CONVERSATION_CHANGED', 'The Arena address changed without a verified continuation of this turn. Capture stopped.');
  }
  function publishLive(tx, result) {
    if (!result.accepted) return;
    tx.seenRows = result.turnIds || tx.seenRows;
    tx.questionRows = [...new Set([...(tx.questionRows || []), ...(result.questionRows || [])])];
    tx.questionTokens ||= new Map(); tx.answerStates ||= new Map();
    tx.currentQuestions = new Map();
    const questions = (result.questions || []).map(question => {
      let token = tx.questionTokens.get(question.fingerprint);
      if (!token) { token = crypto.randomUUID(); tx.questionTokens.set(question.fingerprint, token); }
      tx.currentQuestions.set(token, question);
      return { ...question.data, token, answerState: tx.answerStates.get(token) || '', busy: !!tx.answerInFlight };
    });
    if (tx.questionTokens.size > 128) D.fail('TOO_MANY_QUESTIONS', 'Too many changing clarification cards. Continue in Arena; no automatic answer was chosen.');
    const data = { text: result.liveText || '', tools: result.tools || [], questions, interactionNotice: result.interactionNotice || '', thinking: result.thinking || null, generating: !!result.generating };
    const signature = JSON.stringify(data);
    if (signature !== tx.liveSignature) {
      tx.liveSignature = signature;
      emit({ type: 'LIVE_UPDATE', requestId: tx.requestId, ...data });
    }
  }
  function attachmentsFor(list) {
    if (list === undefined || list === null) return [];
    if (!Array.isArray(list) || !list.length) D.fail('INVALID_ATTACHMENT', 'Attachments must be a short list of user-picked files.');
    const A = globalThis.ArenaAgentAttachments;
    if (!A) D.fail('ADAPTER_ERROR', 'The attachment policy failed to load. No prompt was sent.');
    if (list.length > A.ATTACHMENT_POLICY.maxFiles) D.fail('INVALID_ATTACHMENT', `Only ${A.ATTACHMENT_POLICY.maxFiles} files can accompany one message.`);
    return list.map(item => {
      if (!item || typeof item.name !== 'string' || typeof item.type !== 'string' || typeof item.data !== 'string' ||
          item.data.length > Math.ceil(A.ATTACHMENT_POLICY.maxBytes * 4 / 3) + 8)
        D.fail('INVALID_ATTACHMENT', 'Every attachment needs a name, type and encoded contents within the size limit.');
      const { accepted, rejected } = A.validateAttachments([{ name: item.name, type: item.type, size: Math.round(item.data.length * 3 / 4) }]);
      if (rejected.length || !accepted.length) D.fail('INVALID_ATTACHMENT', rejected[0]?.reason || 'That file is not supported.');
      const bytes = A.base64ToBytes(item.data);
      if (!bytes.byteLength || bytes.byteLength > A.ATTACHMENT_POLICY.maxBytes) D.fail('INVALID_ATTACHMENT', 'The attachment contents are empty or exceed the size limit.');
      return { name: accepted[0].name, type: accepted[0].type, bytes };
    });
  }
  // Attachment chips may add a short suffix; the wording itself must stay identical.
  function composerMatches(tx, text) { return D.promptMatches(tx, text); }
  async function stageAttachments(tx, field) {
    const A = globalThis.ArenaAgentAttachments;
    if (!D.uploadsFor(field).input)
      D.fail('UPLOAD_UNAVAILABLE', 'Arena has no single file input tied to its composer that this version can use. Attach the files in the Arena tab and send there; nothing was inserted and no Send click was attempted.');
    // Marks exactly one verified composer input; the page-context helper refuses anything else.
    const request = D.stageRequestFor(field, tx.staged.map(item => ({ name: item.name, type: item.type, size: item.bytes.byteLength })));
    tx.stageToken = request.token;
    emit({ type: 'STAGED', requestId: tx.requestId, count: tx.staged.length });
    // Bytes are handed to the worker and written by the page-context staging helper, then erased here.
    const payload = tx.staged.map(item => ({ name: item.name, type: item.type, data: A.bytesToBase64(item.bytes) }));
    let response;
    try { response = await chrome.runtime.sendMessage({ type: 'STAGE_FILES', token: request.token, files: payload }); }
    catch (e) { D.fail('STAGE_FAILED', `The extension worker could not stage the files (${e?.message || 'no response'}).`); }
    finally { for (const item of payload) item.data = ''; payload.length = 0; }
    if (transaction !== tx || !owner) return false;
    if (!response?.ok) D.fail(response?.code || 'STAGE_FAILED', `${response?.error || 'The files could not be placed in the Arena composer.'} Nothing was sent; the extension did not retry or fall back.`);
    const stage = response.value;
    if (!stage?.ok) D.fail('STAGE_REJECTED', `${stage?.reason || 'Arena’s upload control did not accept the staged files.'} Nothing was sent; attach the files in Arena instead.`);
    if (stage.files?.length !== tx.staged.length || stage.files.some((file, index) => file.name !== tx.staged[index].name || file.size !== tx.staged[index].bytes.byteLength))
      D.fail('STAGE_MISMATCH', 'Arena’s upload control reported different files than were staged. Nothing was sent; check the Arena tab.');
    // From here on the page may show its own attachment chips beside the prompt; allow only that short suffix.
    tx.attachmentLabels = true;
    // Let the site react (it may echo labels or replace the composer) before deciding anything.
    await sleep(300);
    if (transaction !== tx || !owner) return false;
    if (!D.uploadsFor(field).input) D.fail('UPLOAD_CHANGED', 'The page replaced its upload input right after staging. Nothing was sent; re-attach in Arena.');
    if (!composerMatches(tx, D.composerText(field))) D.fail('COMPOSER_CHANGED', 'The composer changed while the upload was inserted. Your text and files remain in Arena; nothing was sent by the extension.');
    return true;
  }
  async function answerQuestion(message) {
    const tx = transaction;
    if (!owner || !tx?.clicked || message.requestId !== tx.requestId) return;
    if (tx.answerInFlight || typeof message.token !== 'string' || tx.answerStates?.has(message.token)) return;
    const old = tx.currentQuestions?.get(message.token);
    if (!old) return emit({ type: 'QUESTION_ERROR', requestId: tx.requestId, token: message.token, message: 'The question is no longer current. Check Arena; nothing was clicked.' });
    tx.answerInFlight = true;
    tx.answerStates.set(message.token, 'Submitting your answer…');
    let attempted = false;
    try {
      const check = () => {
        if (transaction !== tx || !owner) return null;
        D.checkBlocks();
        if (!D.samePage(location.href, tx.url)) D.fail('CONVERSATION_CHANGED', 'Arena navigated before the clarification answer. No further answer action will be taken.');
        const result = D.matchTurn(tx);
        const matches = (result.questions || []).filter(question => question.fingerprint === old.fingerprint);
        if (matches.length !== 1 || matches[0].data.readOnly)
          D.fail('QUESTION_CHANGED', 'The clarification changed or was already answered. Check Arena; this answer will not be retried.');
        return matches[0];
      };
      let current = check(); if (!current) return;
      if (current.input?.value.trim()) D.fail('ANSWER_DRAFT_EXISTS', 'Arena already has a custom-answer draft. It was not overwritten; finish it in Arena.');
      if (message.kind === 'option') {
        if (!Number.isInteger(message.index) || message.index < 0 || message.index >= current.buttons.length)
          D.fail('INVALID_ANSWER', 'Choose one of the current options. No option was clicked.');
        const button = current.buttons[message.index];
        if (!D.enabled(button) || button.closest('[inert]')) D.fail('ANSWER_UNAVAILABLE', 'This option is unavailable in Arena. No option was clicked.');
        attempted = true; button.click(); // One explicit option click; the site may immediately submit it.
      } else if (message.kind === 'custom') {
        if (!current.input || !current.submit || typeof message.text !== 'string' || !message.text.trim() || message.text.length > 2000)
          D.fail('INVALID_ANSWER', 'Custom answers must match a recognized field and contain 1–2,000 characters.');
        if (!D.enabled(current.input) || current.input.closest('[inert]')) D.fail('ANSWER_UNAVAILABLE', 'The custom-answer field is unavailable.');
        const input = current.input;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(input, message.text); input.dispatchEvent(new Event('input', { bubbles: true }));
        const deadline = Date.now() + 2500;
        do {
          await sleep(100); current = check(); if (!current) return;
          if (current.input !== input || !input.isConnected || input.value !== message.text)
            D.fail('ANSWER_CHANGED', 'The custom-answer input changed. Text may remain in Arena; nothing was submitted automatically.');
        } while (!D.enabled(current.submit) && Date.now() < deadline);
        if (!D.enabled(current.submit) || current.submit.closest('[inert]')) D.fail('ANSWER_UNAVAILABLE', 'Custom-answer Submit stayed disabled. The draft remains in Arena; no retry was attempted.');
        attempted = true; current.submit.click(); // No Enter, Skip, generic Continue or retry.
      } else D.fail('INVALID_ANSWER', 'Unsupported clarification answer type.');
      tx.answerStates.set(message.token, 'Answer attempted once. Waiting for Arena…');
      const deadline = Date.now() + 8000;
      while (transaction === tx && owner) {
        D.checkBlocks();
        if (!D.samePage(location.href, tx.url)) D.fail('CONVERSATION_CHANGED', 'Arena navigated while answering. Check the tab; no retry was attempted.');
        const result = D.matchTurn(tx);
        if (!(result.questions || []).some(question => question.fingerprint === old.fingerprint)) {
          // The card was answered; Arena may reuse this exact card structure for a follow-up question.
          tx.answerStates.delete(message.token);
          emit({ type: 'QUESTION_SENT', requestId: tx.requestId, token: message.token }); break;
        }
        if (Date.now() >= deadline) D.fail('ANSWER_NOT_CONFIRMED', 'The answer was attempted once, but the question did not change. Check Arena; it will not be retried automatically.');
        await sleep(150);
      }
    } catch (e) {
      if (transaction !== tx || !owner) return;
      if (['SECURITY_CHECK','RATE_LIMIT','SIGN_IN_REQUIRED','ARENA_ERROR','CONVERSATION_CHANGED','AMBIGUOUS_TURN','AMBIGUOUS_REPLY','PROMPT_MISMATCH','AMBIGUOUS_TRANSCRIPT'].includes(e.code)) error(e, tx);
      else {
        const messageText = e.code ? `${e.code}: ${e.message}` : 'Clarification handling failed. Check Arena; no retry was attempted.';
        tx.answerStates.set(message.token, messageText);
        emit({ type: 'QUESTION_ERROR', requestId: tx.requestId, token: message.token, message: messageText, attempted });
      }
    } finally {
      tx.answerInFlight = false;
      if (transaction === tx && owner) scan();
    }
  }
  function scan() {
    const tx = transaction;
    if (!owner || !tx || !tx.clicked) return;
    try {
      D.checkBlocks();
      const result = D.matchTurn(tx);
      checkUrl(tx, result);
      if (result.accepted && !tx.userId) {
        tx.userId = result.userId;
        emit({ type: 'ACCEPTED', requestId: tx.requestId, userMessageId: tx.userId });
      }
      if (result.assistantId) tx.assistantId = result.assistantId;
      publishLive(tx, result);
      if (!result.accepted && Date.now() > tx.ackDeadline)
        D.fail('SEND_NOT_CONFIRMED', 'Send was clicked once, but no matching user message appeared within 15 seconds. Check Arena before sending again; do not assume it failed.');
      // No completed-response deadline. Attribution, security and owner/heartbeat guards still apply.
      if (result.complete && result.text && !tx.answerInFlight) {
        if (tx.completedText !== result.text) { tx.completedText = result.text; tx.completeAt = Date.now(); }
        if (Date.now() - tx.completeAt >= 700) {
          emit({ type: 'COMPLETE', requestId: tx.requestId, userMessageId: tx.userId,
            assistantMessageId: tx.assistantId, text: result.text, url: tx.url, model: result.model || '' });
          stopTransaction();
        }
      } else { tx.completedText = ''; tx.completeAt = 0; }
    } catch (e) { error(e, tx); }
  }
  function queueScan() {
    if (scanQueued) return;
    scanQueued = true;
    queueMicrotask(() => { scanQueued = false; scan(); });
  }
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function prepareComposer(tx) {
    // Snapshot conversation BEFORE any review dismissal so it cannot change context unnoticed.
    tx.baseline = D.conversationReady().map(row => row.id);
    const review = D.reviewPanel();
    if (!review) return D.preflight();
    if (!D.enabled(review.close) || review.close.closest('[inert]'))
      D.fail('REVIEW_CLOSE_UNAVAILABLE', 'The task-review Close control is disabled. Open Arena to continue. No feedback choice or Send click was attempted.');
    emit({ type: 'REVIEW_HANDLING', requestId: tx.requestId });
    if (transaction !== tx || !owner) return null;
    // Only the observed neutral Close control. Never Yes, No, Keep working, Escape, or a generic modal close.
    tx.reviewCloseAttempted = true;
    review.close.click();
    const deadline = Date.now() + 6000;
    while (transaction === tx && owner) {
      D.checkBlocks();
      if (!D.samePage(location.href, tx.url)) D.fail('CONVERSATION_CHANGED', 'Arena navigated while closing the review. No prompt was sent.');
      const ids = D.rows().map(row => row.id);
      if (JSON.stringify(ids) !== JSON.stringify(tx.baseline))
        D.fail('CONVERSATION_CHANGED', 'The transcript changed while closing the review. No prompt was sent.');
      if (!D.reviewPanel()) {
        try { return D.preflight(); }
        catch (e) {
          if (!['COMPOSER_NOT_FOUND', 'SEND_BUTTON_NOT_FOUND'].includes(e.code)) throw e;
        }
      }
      if (Date.now() >= deadline)
        D.fail('REVIEW_BLOCKING_COMPOSER', 'The review Close control was attempted once, but the review did not disappear or the message input did not return within 6 seconds. Open Arena and close the review or choose Keep working yourself. No feedback option was selected and no prompt was sent.');
      await sleep(150);
    }
    return null;
  }
  // Resume tracking a message Arena already accepted (after the panel reconnected). Strictly read-only:
  // there is no composer write and no click on this path, and the usual attribution rules apply.
  function watch(message) {
    if (transaction) return emit({ type: 'ERROR', requestId: message.requestId, code: 'BUSY', message: 'This tab is already tracking a request.', clicked: false });
    try {
      if (typeof message.requestId !== 'string' || !/^[\da-f-]{36}$/i.test(message.requestId) || typeof message.prompt !== 'string' ||
          !message.prompt.trim() || message.prompt.length > 30000 || typeof message.userMessageId !== 'string' || !message.userMessageId)
        D.fail('INVALID_REQUEST', 'Invalid resume request.');
      if (!D.samePage(message.url, location.href)) D.fail('CONVERSATION_CHANGED', 'The Arena tab is now on a different page, so this reply can no longer be tracked here. Read it in Arena.');
      D.checkBlocks();
      const list = D.rows(), index = list.findIndex(row => row.id === message.userMessageId && row.user);
      if (index < 0) D.fail('WATCH_UNAVAILABLE', 'Your message is no longer visible in the Arena tab, so its reply cannot be tracked here. Read it in Arena; nothing was resent.');
      const tx = { requestId: message.requestId, prompt: message.prompt.trim(), url: location.href, clicked: true, resumed: true,
        userId: message.userMessageId, baseline: list.slice(0, index).map(row => row.id), ackDeadline: Infinity, attachmentLabels: !!message.hadAttachments };
      transaction = tx;
      emit({ type: 'WATCHING', requestId: tx.requestId });
      scan();
    } catch (e) { emit({ type: 'ERROR', requestId: message.requestId, code: e.code || 'WATCH_UNAVAILABLE', message: e.message, clicked: false }); }
  }
  async function send(message) {
    if (transaction) return emit({ type: 'ERROR', requestId: message.requestId, code: 'BUSY', message: 'This tab is already tracking a request.', clicked: false });
    if (typeof message.requestId !== 'string' || !/^[\da-f-]{36}$/i.test(message.requestId) ||
        typeof message.prompt !== 'string' || !message.prompt.trim() || message.prompt.length > 30000)
      return emit({ type: 'ERROR', requestId: message.requestId, code: 'INVALID_REQUEST', message: 'Invalid prompt or request ID.', clicked: false });
    if (consumed.has(message.requestId)) return emit({ type: 'ERROR', requestId: message.requestId, code: 'DUPLICATE_REQUEST', message: 'This request was already attempted. It will not be sent again.', clicked: false });
    consumed.add(message.requestId);
    if (consumed.size > 128) consumed.delete(consumed.values().next().value);
    const tx = { requestId: message.requestId, prompt: message.prompt.trim(), url: location.href, clicked: false };
    transaction = tx;
    try {
      if (!D.samePage(message.url, location.href)) D.fail('CONVERSATION_CHANGED', 'The tab URL changed. Reconnect before sending.');
      const prepared = await prepareComposer(tx);
      if (!prepared || transaction !== tx || !owner) return;
      D.checkBlocks();
      if (!D.samePage(location.href, tx.url) || JSON.stringify(D.rows().map(row => row.id)) !== JSON.stringify(tx.baseline))
        D.fail('CONVERSATION_CHANGED', 'The Arena conversation changed before insertion. No prompt was sent.');
      if (D.reviewPanel()) D.fail('REVIEW_REAPPEARED', 'The task review reappeared before insertion. It will not be closed again automatically for this request. No prompt was sent.');
      const { field } = prepared;
      emit({ type: 'SENDING', requestId: tx.requestId, inputKind: field.tagName === 'TEXTAREA' ? 'textarea' : 'contenteditable' });
      if (transaction !== tx || !owner) return;
      D.writeComposer(field, tx.prompt);
      try { tx.staged = attachmentsFor(message.attachments); } catch (e) { tx.staged = []; D.fail(e.code || 'INVALID_ATTACHMENT', e.message); }
      if (tx.staged.length && !(await stageAttachments(tx, field))) return;
      if (transaction !== tx || !owner) return;
      const enableDeadline = Date.now() + 2500;
      let button;
      do {
        await sleep(100);
        if (transaction !== tx || !owner) return;
        D.checkBlocks();
        if (D.reviewPanel()) D.fail('REVIEW_REAPPEARED', 'The task review appeared before Send. No message was sent; inspect Arena before trying again.');
        if (!D.samePage(location.href, tx.url)) D.fail('CONVERSATION_CHANGED', 'Arena navigated before Send. No Send click was attempted.');
        const current = D.rows().map(r => r.id);
        if (JSON.stringify(current) !== JSON.stringify(tx.baseline)) D.fail('CONVERSATION_CHANGED', 'The transcript changed before Send. No Send click was attempted.');
        if (!field.isConnected || !composerMatches(tx, D.composerText(field))) D.fail('COMPOSER_CHANGED', 'The composer changed before Send. No Send click was attempted.');
        if (D.running()) D.fail('AGENT_BUSY', 'Arena started another request. No Send click was attempted.');
        if (D.composer() !== field) D.fail('COMPOSER_CHANGED', 'The active composer changed before Send. No Send click was attempted.');
        button = D.sendButton(document, field);
      } while (!D.enabled(button) && Date.now() < enableDeadline);
      if (!D.enabled(button)) D.fail('SEND_UNAVAILABLE', 'Arena’s Send button stayed unavailable. The prompt may remain in its composer, but no Send click was attempted. Check sign-in, model access, or verification in the tab.');
      // Exactly one click attempt. No click/Enter retry on any failure or disconnect.
      tx.clicked = true; tx.ackDeadline = Date.now() + 15000;
      button.click(); scan();
    } catch (e) { error(e, tx); }
    finally {
      if (tx.stageToken) {
        for (const input of document.querySelectorAll('input[type="file"][data-arena-agent-stage]'))
          if (input.getAttribute('data-arena-agent-stage') === tx.stageToken) input.removeAttribute('data-arena-agent-stage');
        try { chrome.runtime.sendMessage({ type: 'CLEAR_STAGE' }).catch(() => {}); } catch { /* context closing */ }
      }
      for (const item of tx.staged || []) item.bytes = new Uint8Array(0);
      tx.staged = [];
    }
  }
  // Explicit, read-only snapshot of the earlier turns currently rendered in this conversation.
  function loadHistory(message) {
    const requestId = typeof message.requestId === 'string' ? message.requestId.slice(0, 80) : '';
    try {
      if (message.url && !D.samePage(message.url, location.href)) D.fail('URL_CHANGED', 'The Arena conversation changed. Reconnect before loading its history.');
      const snapshot = D.historyTurns();
      emit({ type: 'HISTORY', requestId, url: location.href, ...snapshot });
    } catch (e) {
      emit({ type: 'HISTORY_ERROR', requestId, code: e.code || 'HISTORY_FAILED', message: e.message || 'Earlier messages could not be read. Nothing was changed in Arena.' });
    }
  }
  // Which kind of Arena chat this is, the model shown in its picker, and (Direct only) Arena's own list.
  function modelInfo() {
    const pageKind = D.pageKind() === 'direct' ? 'direct' : 'agent';
    let models = [];
    if (pageKind === 'direct') { try { models = D.modelCatalog(); } catch { models = []; } }
    return { pageKind, model: pageKind === 'direct' ? D.currentModel() : '', models };
  }
  let probingPort = null;
  async function probe(port) {
    if (probingPort === port) return;
    probingPort = port;
    const deadline = Date.now() + 6000;
    try {
      while (owner === port) {
        try {
          const info = D.inspectControls();
          emit({ type: 'READY', url: location.href, inputKind: info.inputKind, reviewPending: !!info.reviewPending, uploadKind: info.uploadKind, fileInputCount: info.fileInputCount, historyCount: D.historyCount(), ...modelInfo() });
          return;
        } catch (e) {
          // Only wait for missing/mounting UI. Never retry a Send or a security failure.
          if (!['COMPOSER_NOT_FOUND', 'SEND_BUTTON_NOT_FOUND'].includes(e.code) || Date.now() >= deadline) { error(e, null); return; }
          await sleep(200);
        }
      }
    } finally { if (probingPort === port) probingPort = null; }
  }
  const onConnect = port => {
    if (port.name !== 'arena-agent-content-v3' || port.sender?.id !== chrome.runtime.id) return;
    if (owner) {
      port.postMessage({ type: 'ERROR', code: 'TAB_IN_USE', message: 'Another extension panel is connected to this Agent tab. Disconnect it first.', clicked: false });
      port.disconnect(); return;
    }
    owner = port; lastHeartbeat = Date.now();
    observer = new MutationObserver(queueScan);
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true,
      attributeFilter: ['aria-label', 'disabled', 'aria-disabled', 'hidden', 'data-chat-message-id', 'aria-checked', 'aria-expanded'] });
    timer = setInterval(() => {
      if (Date.now() - lastHeartbeat > LEASE_MS) return cleanup();
      scan();
    }, 300);
    port.onDisconnect.addListener(() => { if (owner === port) cleanup(); });
    port.onMessage.addListener(message => {
      if (owner !== port) return;
      lastHeartbeat = Date.now(); // any message from the panel proves it is still there
      // Each heartbeat also rescans, so capture keeps pace even while this tab's timers are throttled.
      if (message?.type === 'PING') { lastHeartbeat = Date.now(); emit({ type: 'PONG' }); scan(); }
      else if (message?.type === 'WATCH') watch(message);
      else if (message?.type === 'MODEL') { try { emit({ type: 'MODEL_INFO', url: location.href, ...modelInfo() }); } catch { emit({ type: 'MODEL_INFO', url: location.href, pageKind: 'agent', model: '', models: [] }); } }
      else if (message?.type === 'PROBE') {
        probe(port);
      } else if (message?.type === 'SEND') send(message);
      else if (message?.type === 'ANSWER_QUESTION') answerQuestion(message);
      else if (message?.type === 'LOAD_HISTORY') loadHistory(message);
      else if (message?.type === 'CANCEL') {
        const id = transaction?.requestId;
        if (!message.requestId || message.requestId === id) { stopTransaction(); emit({ type: 'CANCELLED', requestId: id }); }
      }
    });
  };
  chrome.runtime.onConnect.addListener(onConnect);
  const onPageHide = () => {
    // Before Arena accepted the message this is a hard stop. After acceptance the panel reconnects to the
    // reloaded page and re-watches the same message ID read-only, so no error is raised here.
    if (transaction && !transaction.userId) error(new D.DomError('PAGE_RELOADED', 'The Arena document closed or reloaded while sending. Capture stopped. Check the tab before sending again.'));
    cleanup();
  };
  window.addEventListener('pagehide', onPageHide);
  // A frozen background tab delivers queued heartbeats after its timers: grant a fresh lease on resume.
  const onResume = () => { if (owner) { lastHeartbeat = Date.now(); queueScan(); } };
  document.addEventListener('resume', onResume);
  document.addEventListener('visibilitychange', onResume);
  globalThis.__ARENA_AGENT_REGISTRATION__ = {
    version: VERSION,
    isAlive: () => {
      try { return runtime.id === chrome.runtime.id && !!runtime.id && (!runtime.getManifest || runtime.getManifest().version === VERSION); }
      catch { return false; }
    },
    dispose: () => {
      cleanup();
      try { runtime.onConnect.removeListener(onConnect); } catch { /* context already invalid */ }
      window.removeEventListener('pagehide', onPageHide);
      document.removeEventListener('resume', onResume); document.removeEventListener('visibilitychange', onResume);
      delete globalThis.__ARENA_AGENT_REGISTRATION__;
      if (globalThis.__ARENA_AGENT_CONTENT_LOADED__ === VERSION) delete globalThis.__ARENA_AGENT_CONTENT_LOADED__;
    }
  };
})();
