// Runs only in Chrome's isolated extension world. No site APIs or auth access.
(() => {
  'use strict';
  const ROW = '[data-agent-transcript-message="true"][data-chat-message-id]';
  const USER = '[data-user-message-layout="true"]';
  const normalize = text => String(text).replace(/\r\n/g, '\n').replace(/\s+/g, ' ').trim();
  class DomError extends Error {
    constructor(code, message) { super(message); this.code = code; }
  }
  const fail = (code, message) => { throw new DomError(code, message); };

  // ---- Direct chat (one model) --------------------------------------------------------------
  // Structure from the user's pasted Direct markup (v2.3.0). Direct rows carry no message IDs:
  //   user row:  .self-end group > .bg-surface-raised bubble > .prose
  //   reply:     card > .sticky header (span.font-mono > span.truncate = model name) + .prose body
  //              reasoning lives in a .not-prose collapsible and is never read;
  //              "Like this response" / "Dislike this response" appear in the finished card's footer.
  // Stable synthetic IDs are derived from position + prompt text, so a re-render keeps them.
  const DIRECT_PATH = /^\/(?:text\/direct\/?|c\/[^/]+\/?)$/;
  const DIRECT_OUTSIDE = 'form,nav,aside,[role="dialog"],[role="navigation"],[data-sidebar],[data-arena-agent-stage]';
  let directEls = new Set();
  function hash(text) {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return (h >>> 0).toString(36);
  }
  function agentRowsPresent(doc) { return !!doc.querySelector(ROW); }
  function pageKind(doc = document) {
    const path = (doc.defaultView || globalThis).location.pathname;
    if (/^\/agent(?:\/|$)/.test(path) || agentRowsPresent(doc)) return 'agent';
    if (DIRECT_PATH.test(path)) return 'direct';
    return /^\/text\//.test(path) ? 'text-other' : 'agent';
  }
  // Mode switcher next to the composer shows "Direct", "Battle", "Side by Side"…
  function modeLabel(doc = document) {
    const box = [...doc.querySelectorAll('form button[role="combobox"]')].find(visible);
    return box ? normalize(box.innerText || box.textContent) : '';
  }
  function currentModel(doc = document) {
    const form = [...doc.querySelectorAll('form')].find(el => el.querySelector('textarea,[contenteditable="true"]') && visible(el));
    if (!form) return '';
    const button = [...form.querySelectorAll('button[aria-haspopup="dialog"]:not([aria-label])')].find(el => visible(el) && el.querySelector('span.truncate'));
    return button ? normalize(button.querySelector('span.truncate').textContent).slice(0, 120) : '';
  }
  function modelOf(card) { return normalize(card.querySelector('.sticky span.font-mono span.truncate')?.textContent || '').slice(0, 120); }
  function directRows(doc = document) {
    const users = new Set([...doc.querySelectorAll('.bg-surface-raised')]
      .filter(bubble => bubble.querySelector('.prose') && !bubble.closest(DIRECT_OUTSIDE))
      .map(bubble => bubble.closest('.self-end') || bubble));
    const cards = [...doc.querySelectorAll('.sticky span.font-mono > span.truncate')]
      .filter(name => !name.closest(DIRECT_OUTSIDE)).map(name => name.closest('.sticky')?.parentElement).filter(Boolean);
    const all = [...new Set([...users, ...cards])].filter(el => visible(el));
    const top = all.filter(el => !all.some(other => other !== el && other.contains(el)))
      .sort((a, b) => (a.compareDocumentPosition(b) & 4) ? -1 : 1);
    directEls = new Set(top);
    let u = 0, a = 0;
    return top.map(el => {
      const user = users.has(el);
      if (user) { u++; a = 0; } else a++;
      return { el, user, id: user ? `direct-u${u}-${hash(normalize(el.querySelector('.bg-surface-raised .prose')?.textContent || ''))}` : `direct-a${u}-${a}` };
    });
  }
  function rowOf(el) {
    const agent = el.closest(ROW);
    if (agent) return agent;
    for (let p = el; p; p = p.parentElement) if (directEls.has(p)) return p;
    return null;
  }
  const inTranscript = el => !!rowOf(el);
  // Keep the Direct row set current before any check that must ignore transcript content.
  function refreshRows(doc = document) { if (pageKind(doc) === 'direct') directRows(doc); else directEls = new Set(); }
  const containsRow = node => !!node.querySelector(ROW) || [...directEls].some(el => node.contains(el));
  const SHIMMER = /^(?:thinking|generating|using faster models)(?:\.{3}|…)?$/i;
  function directPending(card) {
    return [...card.querySelectorAll('span,p,div')].some(el => !el.children.length && !el.closest('.prose') &&
      SHIMMER.test(normalize(el.textContent)) && visible(el));
  }
  function directFeedback(card) {
    return [...card.querySelectorAll('button[aria-label]')].some(el => visible(el) &&
      /^(?:like this response|liked|dislike this response|disliked)$/i.test(normalize(el.getAttribute('aria-label'))));
  }
  // Arena renders failures with a "Copy trace ID" error block and stops with "Generation stopped".
  function directProblem(card) {
    const trace = card.querySelector('button[aria-label="Copy trace ID"]');
    if (trace && visible(trace)) {
      let box = trace.parentElement;
      for (let i = 0; i < 3 && box && normalize(box.textContent).length < 8; i++) box = box.parentElement;
      const text = normalize(box?.textContent || '').slice(0, 300);
      return { code: /rate limit|too many|limit reached|quota/i.test(text) ? 'RATE_LIMIT' : 'ARENA_ERROR', text };
    }
    const stopped = [...card.querySelectorAll('p')].find(el => !el.closest('.prose') && /^generation stopped$/i.test(normalize(el.textContent)) && visible(el));
    return stopped ? { code: 'GENERATION_STOPPED', text: 'Generation stopped' } : null;
  }
  // Same page, ignoring the model_a/model parameter Arena rewrites on an empty Direct chat.
  function samePage(a, b) {
    if (a === b) return true;
    try {
      const x = new URL(a), y = new URL(b);
      if (x.origin !== y.origin || x.pathname !== y.pathname || x.hash !== y.hash || !/^\/text\/direct\/?$/.test(x.pathname)) return false;
      const rest = u => { const p = new URLSearchParams(u.search); p.delete('model_a'); p.delete('model'); return p.toString(); };
      return rest(x) === rest(y);
    } catch { return false; }
  }
  // Arena's own model list, embedded in the Direct page's data. Read-only; nothing is requested.
  const catalogCache = new WeakMap();
  function extractArray(text, start) {
    let depth = 0, inString = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inString) { if (c === '\\') i++; else if (c === '"') inString = false; continue; }
      if (c === '"') inString = true;
      else if (c === '[' || c === '{') depth++;
      else if ((c === ']' || c === '}') && --depth === 0) return text.slice(start, i + 1);
    }
    return null;
  }
  function modelCatalog(doc = document) {
    const scripts = [...doc.querySelectorAll('script:not([src])')];
    const cached = catalogCache.get(doc);
    if (cached && cached.count === scripts.length) return cached.list;
    let data = '';
    for (const script of scripts) {
      const code = script.textContent || '';
      const m = /^\s*self\.__next_f\.push\((\[[\s\S]*\])\)\s*;?\s*$/.exec(code);
      if (!m) continue;
      try { const part = JSON.parse(m[1]); if (part[0] === 1 && typeof part[1] === 'string') data += part[1]; } catch { /* not a data chunk */ }
      if (data.length > 8000000) break;
    }
    let list = [];
    const at = data.indexOf('"initialModels":');
    if (at >= 0) {
      try {
        const raw = JSON.parse(extractArray(data, data.indexOf('[', at)) || '[]');
        const seen = new Set();
        list = raw.filter(m => m && typeof m === 'object' && m.userSelectable !== false && m.capabilities?.outputCapabilities?.text &&
          m.rankByModality && Object.prototype.hasOwnProperty.call(m.rankByModality, 'chat'))
          .map(m => ({ id: String(m.id || ''), name: String(m.displayName || m.publicName || '').slice(0, 120), org: String(m.organization || '').slice(0, 60),
            rank: Number(m.rankByModality.chat) || 1e9, image: !!m.capabilities?.inputCapabilities?.image, file: !!m.capabilities?.inputCapabilities?.file }))
          .filter(m => m.name && !seen.has(m.name.toLowerCase()) && seen.add(m.name.toLowerCase()))
          .sort((a, b) => (a.name.toLowerCase() === 'max' ? -1 : b.name.toLowerCase() === 'max' ? 1 : a.rank - b.rank))
          .slice(0, 400);
      } catch { list = []; }
    }
    catalogCache.set(doc, { count: scripts.length, list });
    return list;
  }
  function visible(el) {
    if (!el || !el.isConnected || el.closest('[hidden],[aria-hidden="true"]')) return false;
    for (let p = el; p && p.nodeType === 1; p = p.parentElement) {
      const style = getComputedStyle(p);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    }
    return !!el.getClientRects().length;
  }
  // Check UI notices, not chat text. Never copy these notices into a reply.
  function checkBlocks(doc = document) {
    refreshRows(doc);
    const ui = [...doc.querySelectorAll('[role="alert"],[role="dialog"],[data-sonner-toast],h1,h2')]
      .filter(el => visible(el) && !inTranscript(el));
    for (const el of ui) {
      const text = normalize(el.innerText || el.textContent).slice(0, 3000);
      if (/captcha|verify (?:that )?you(?: are|'re) human|verification required|security (?:check|verification)|unusual traffic|checking your browser/i.test(text))
        fail('SECURITY_CHECK', 'Complete the security verification in the Arena tab yourself. No retry or bypass was attempted. Check whether Arena accepted your prompt before sending again.');
      if (/rate limit|too many requests|quota exceeded|usage limit|try again (?:in|later)|limit reached/i.test(text))
        fail('RATE_LIMIT', 'Arena is limiting requests. Follow the wait time in the Arena tab. No automatic retry was attempted.');
      if (el.matches('[role="dialog"]') && /sign in|log in|login required/i.test(text))
        fail('SIGN_IN_REQUIRED', 'Sign in normally in the Arena tab, then reconnect. Never enter Google credentials in the extension.');
      if (el.matches('[role="alert"],[data-sonner-toast]') && /something went wrong|request failed|failed to generate|service unavailable/i.test(text))
        fail('ARENA_ERROR', 'Arena displayed a request error. Inspect the Arena tab before deciding whether to send again.');
    }
    for (const frame of doc.querySelectorAll('iframe')) {
      if (!visible(frame)) continue;
      const src = frame.getAttribute('src') || '', rect = frame.getBoundingClientRect();
      if ((/recaptcha.*\/bframe|hcaptcha.*challenge|challenges\.cloudflare\.com/i.test(src)) && rect.width > 100 && rect.height > 70)
        fail('SECURITY_CHECK', 'A security verification is visible in the Arena tab. Complete it yourself there. No retry or bypass was attempted.');
    }
  }
  function proseOf(row) {
    return [...row.querySelectorAll('.prose')].filter(el =>
      rowOf(el) === row && !el.closest('.not-prose,[data-user-message-action],button,[role="dialog"]') &&
      !el.parentElement?.closest('.prose') && visible(el));
  }
  function answerText(row) {
    const nodes = proseOf(row);
    const parts = nodes.map(el => {
      const clone = el.cloneNode(true);
      clone.querySelectorAll('.not-prose,button,script,style,iframe,[hidden],[aria-hidden="true"],input,textarea,select').forEach(e => e.remove());
      // Preserve basic paragraph/code line breaks without rendering arbitrary HTML.
      clone.querySelectorAll('br').forEach(e => e.replaceWith('\n'));
      clone.querySelectorAll('p,pre,li,blockquote,h1,h2,h3,h4,tr').forEach(e => e.append('\n'));
      return clone.textContent.trim();
    });
    const text = parts.filter(Boolean).join('\n\n');
    if (text.length > 200000) fail('REPLY_TOO_LARGE', 'The reply exceeds 200,000 characters. Read it in Arena instead.');
    return text;
  }
  function rows(doc = document) {
    if (pageKind(doc) === 'direct') return directRows(doc);
    directEls = new Set();
    const list = [...doc.querySelectorAll(ROW)].filter(visible).map(el => ({
      el, id: el.getAttribute('data-chat-message-id'), user: !!el.querySelector(USER)
    }));
    if (new Set(list.map(r => r.id)).size !== list.length)
      fail('AMBIGUOUS_TRANSCRIPT', 'Duplicate visible message IDs were found. Open one Agent conversation and reconnect.');
    return list;
  }
  function ended(row) {
    if (directEls.has(row)) return !directPending(row) && !running(row.ownerDocument) && (directFeedback(row) || !!answerText(row));
    // Observed in the user's completed Agent reply. Copy and bottom markers alone are insufficient.
    return [...row.querySelectorAll('[aria-label]')].some(el =>
      !el.closest('.prose,.not-prose') && visible(el) && /\bResponse ended\b/i.test(el.getAttribute('aria-label') || ''));
  }
  function running(doc = document) {
    return [...doc.querySelectorAll('button[aria-label]')].some(el => visible(el) &&
      /^(?:stop|stop generating|stop generation|stop response|stop agent|cancel generation)$/i.test(el.getAttribute('aria-label')?.trim() || ''));
  }
  const EDITABLE = '[contenteditable="true"],[contenteditable=""],[contenteditable="plaintext-only"]';
  const EXCLUDED_SEL = `${ROW},[data-user-message-action],[role="dialog"],[role="search"],[role="navigation"],nav,aside,pre,code,.monaco-editor,.cm-editor,.CodeMirror`;
  const excluded = el => !!el.closest(EXCLUDED_SEL) || inTranscript(el);
  function editorHost(el) {
    if (!el.matches(EDITABLE)) return false;
    // A nested editable node is not a second editor when its ancestor is already editable.
    for (let p = el.parentElement; p; p = p.parentElement) {
      if (p.getAttribute('contenteditable') === 'false') break;
      if (p.matches(EDITABLE)) return false;
    }
    return true;
  }
  function fieldHints(el) {
    return ['name','aria-label','placeholder','data-placeholder','data-testid'].map(a => el.getAttribute(a) || '').join(' ');
  }
  function semanticComposer(el) { return /\b(?:message|prompt|chat|composer|ask|describe (?:a |your |the )?(?:task|project))\b/i.test(fieldHints(el)); }
  function eligibleFields(doc = document) {
    refreshRows(doc);
    return [...doc.querySelectorAll(`textarea,${EDITABLE}`)].filter(el =>
      visible(el) && !excluded(el) && (el.tagName === 'TEXTAREA' || editorHost(el)) &&
      !/\b(?:search|find|filter)\b/i.test(fieldHints(el)));
  }
  function buttonName(el) {
    const direct = el.getAttribute('aria-label') || el.getAttribute('title');
    if (direct) return normalize(direct);
    const labelled = (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)
      .map(id => el.ownerDocument.getElementById(id)?.textContent || '').join(' ');
    return normalize(labelled || el.innerText || el.textContent);
  }
  function labelledSends(doc = document) {
    return [...doc.querySelectorAll('button,[role="button"]')].filter(el => visible(el) && !excluded(el) &&
      /^(?:send|send message|send prompt|submit message)(?:\s*\((?:enter|return)\))?$/i.test(buttonName(el)));
  }
  function localTo(field, button, fields) {
    if (field.form && button.form === field.form && fields.filter(el => field.form.contains(el)).length === 1) return true;
    for (let node = field.parentElement, depth = 0; node && depth < 6; node = node.parentElement, depth++) {
      if (node === field.ownerDocument.body || node === field.ownerDocument.documentElement || node.matches('main,[role="main"]')) break;
      if (containsRow(node)) break;
      if (node.contains(button) && fields.filter(el => node.contains(el)).length === 1) return true;
    }
    return false;
  }
  // A picker input is routinely display:none on itself; what must not be hidden is its ancestor region,
  // otherwise we would target a template or another closed surface.
  function inputLaidOut(el) {
    for (let p = el.parentElement; p && p.nodeType === 1; p = p.parentElement) {
      const style = getComputedStyle(p);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      if (p === el.ownerDocument.body || p === el.ownerDocument.documentElement) return true;
    }
    return true;
  }
  function composerAnchors(field, doc) {
    const anchors = new Set([field]);
    const form = field.form || field.closest('form');
    if (form) { anchors.add(form); for (const inner of form.querySelectorAll('input,button,textarea,[contenteditable]')) anchors.add(inner); }
    return anchors;
  }
  function nearComposer(el, field, doc) {
    const anchors = composerAnchors(field, doc);
    for (let node = el.parentElement, depth = 0; node && depth < 6; node = node.parentElement, depth++) {
      if (node === doc.body || node === doc.documentElement || node.matches('main,[role="main"]')) break;
      if (containsRow(node)) break;
      for (const anchor of anchors) if (anchor === node || node.contains(anchor)) return true;
    }
    return false;
  }
  function composerFileInputs(field, doc = document) {
    if (!field) return [];
    refreshRows(doc);
    // Every composer-local picker counts, including ones we would reject: a second input means we
    // could attach to the wrong control, so ambiguity is resolved by refusing rather than filtering.
    return [...doc.querySelectorAll('input[type="file"]')].filter(el =>
      el.disabled !== true && el.closest('.not-prose') === null &&
      !el.closest('[role="dialog"],[role="search"],[role="navigation"],nav,aside') && !inTranscript(el) && inputLaidOut(el) &&
      nearComposer(el, field, doc));
  }
  function fileInputsFor(field, doc = document) {
    // One drop-zone may expose two identical inputs (button picker + drag area); anything else is ambiguous.
    const inputs = composerFileInputs(field, doc);
    const single = inputs.length === 1 ? inputs : inputs.length === 2 && inputs[0].accept === inputs[1].accept &&
      inputs[0].multiple === inputs[1].multiple ? [inputs[0]] : [];
    return single.filter(el => !el.accept ||
      (globalThis.ArenaAgentAttachments ? globalThis.ArenaAgentAttachments.acceptAllows(el.accept) : true));
  }
  function uploadsFor(field, doc = document) {
    const inputs = fileInputsFor(field, doc);
    if (inputs.length) return { input: inputs[0], button: null, kind: 'input' };
    if (composerFileInputs(field, doc).length) return { input: null, button: null, kind: 'unsupported' };
    // Some pages open their picker through a button with no inspectable file input.
    const buttons = field ? [...field.ownerDocument.querySelectorAll('button,[role="button"]')].filter(el => visible(el) && !excluded(el) &&
      /^(?:attach|upload|add (?:files?|attachments?)|attach files?|upload files?|\u{1f4ce})$/iu.test(buttonName(el)) && nearComposer(el, field, doc)) : [];
    if (buttons.length === 1) return { input: null, button: buttons[0], kind: 'button-only' };
    return { input: null, button: null, kind: 'none' };
  }
  function stageRequestFor(field, pairs) {
    const A = globalThis.ArenaAgentAttachments;
    const target = fileInputsFor(field)[0];
    if (!target) fail('UPLOAD_UNAVAILABLE', 'Arena has no single file input attached to its composer, so the extension cannot place files there. Attach them in the Arena tab and send there; nothing was inserted and no Send click was attempted.');
    if (!A) fail('ADAPTER_ERROR', 'The attachment policy is unavailable. Nothing was inserted or sent.');
    const checked = A.validateAttachments(pairs);
    if (checked.rejected.length || checked.accepted.length !== pairs.length) fail('INVALID_ATTACHMENT', checked.rejected[0]?.reason || 'One of the files is not supported. Nothing was inserted or sent.');
    if (pairs.length > 1 && !target.multiple) fail('UPLOAD_MULTIPLE_UNSUPPORTED', `That Arena file input accepts one file at a time. Send ${pairs.length} files separately in the Arena tab; nothing was inserted or sent.`);
    const token = crypto.randomUUID();
    target.setAttribute('data-arena-agent-stage', token);
    return { input: target, token, names: checked.accepted.map(item => item.name) };
  }
  function composerSummary(doc = document) {
    const all = eligibleFields(doc);
    let upload = 'no file input';
    try { const field = composer(doc); if (field) { const kinds = { input: 'one composer file input', 'button-only': 'an upload button but no usable file input', none: 'no recognizable upload control' }; upload = kinds[uploadsFor(field, doc).kind]; } } catch { /* composer itself is broken */ }
    return `Visible eligible controls: ${all.filter(el => el.tagName === 'TEXTAREA').length} textarea(s), ${all.filter(el => el.tagName !== 'TEXTAREA').length} editable host(s), ${labelledSends(doc).length} labelled Send control(s); upload: ${upload}.`;
  }
  function composer(doc = document) {
    const fields = eligibleFields(doc), sends = labelledSends(doc);
    // Editable hosts require semantic chat hints OR a unique local Send relationship.
    let candidates = fields.filter(el => el.tagName === 'TEXTAREA' || semanticComposer(el) || sends.some(button => localTo(el, button, fields)));
    const semantic = candidates.filter(semanticComposer);
    if (semantic.length) candidates = semantic;
    if (candidates.length > 1) {
      const paired = candidates.filter(el => sends.some(button => localTo(el, button, fields)));
      if (paired.length === 1) candidates = paired;
    }
    if (!candidates.length) fail('COMPOSER_NOT_FOUND', `No eligible Agent message input is ready. ${composerSummary(doc)} Supports native textareas and identifiable contenteditable chat editors; excludes transcript, search, dialogs, and workspace code editors.`);
    if (candidates.length !== 1) fail('AMBIGUOUS_COMPOSER', `Found ${candidates.length} possible Agent message inputs. ${composerSummary(doc)} Refusing to guess which field to edit.`);
    const el = candidates[0];
    if (el.disabled || el.readOnly || el.getAttribute('aria-disabled') === 'true' || el.getAttribute('aria-readonly') === 'true' || el.closest('[inert]'))
      fail('COMPOSER_UNAVAILABLE', 'The Arena composer is unavailable. Check sign-in, pending agent questions, or security verification in the tab.');
    return el;
  }
  function sendButton(doc = document, field = composer(doc)) {
    const fields = eligibleFields(doc), sends = labelledSends(doc);
    const local = sends.filter(button => localTo(field, button, fields));
    if (local.length === 1) return local[0];
    if (local.length > 1) fail('AMBIGUOUS_SEND_BUTTON', 'Multiple Send controls are associated with the selected composer. No Send click was attempted.');
    // An unlabelled submit is acceptable only in the same explicit form as a single
    // semantically identified chat input, with no other data-entry controls or submit choices.
    const form = field.form || field.closest('form');
    if (form && semanticComposer(field) && fields.filter(el => form.contains(el)).length === 1) {
      const others = [...form.querySelectorAll('input,select,textarea')].filter(el => el !== field && visible(el) && !el.matches('input[type="hidden"],input[type="file"]'));
      const submits = [...form.querySelectorAll('button[type="submit"]')].filter(el => visible(el) && !excluded(el));
      if (!others.length && submits.length === 1 && !buttonName(submits[0])) return submits[0];
    }
    if (sends.length === 1 && fields.length === 1) return sends[0];
    if (sends.length > 1) fail('AMBIGUOUS_SEND_BUTTON', 'Multiple page Send controls exist, and none can be uniquely tied to this composer. No Send click was attempted.');
    fail('SEND_BUTTON_NOT_FOUND', `No labelled Send control or unambiguous chat-form submit is associated with the composer. ${composerSummary(doc)} No Send click was attempted.`);
  }
  function composerText(field) {
    return field.tagName === 'TEXTAREA' ? field.value : (field.innerText ?? field.textContent ?? '');
  }
  function writeComposer(field, text) {
    if (composerText(field).trim()) fail('DRAFT_EXISTS', 'The composer gained an unsent draft. Nothing was overwritten or clicked.');
    field.focus();
    const doc = field.ownerDocument, win = doc.defaultView;
    if (field.tagName === 'TEXTAREA') {
      const setter = Object.getOwnPropertyDescriptor(win.HTMLTextAreaElement.prototype, 'value')?.set;
      if (!setter) fail('COMPOSER_NOT_FOUND', 'The native textarea setter is unavailable. No Send click was attempted.');
      setter.call(field, text);
      field.dispatchEvent(new win.InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      return;
    }
    if (!editorHost(field) || !field.isContentEditable) fail('COMPOSER_UNAVAILABLE', 'The selected rich-text input is not editable. No Send click was attempted.');
    const selection = doc.getSelection();
    if (!selection || typeof doc.execCommand !== 'function') fail('RICH_EDITOR_UNSUPPORTED', 'This browser cannot perform a native rich-editor insertion. No Send click was attempted.');
    const anchor = [...field.querySelectorAll('p')].find(el => !el.closest('[contenteditable="false"]')) || field;
    const range = doc.createRange(); range.selectNodeContents(anchor); range.collapse(true);
    selection.removeAllRanges(); selection.addRange(range);
    // Use Chrome's editing pipeline so ProseMirror/Lexical-style input handlers run.
    // Never replace innerHTML/textContent or issue an Enter fallback.
    const inserted = doc.execCommand('insertText', false, text);
    if (!inserted || normalize(composerText(field)) !== normalize(text))
      fail('RICH_EDITOR_REJECTED', 'The rich-text editor did not accept the requested text. No Send click was attempted. Inspect the Arena composer; no second insertion or Send retry was attempted.');
  }
  function enabled(button) {
    return !button.disabled && button.getAttribute('aria-disabled') !== 'true' && getComputedStyle(button).pointerEvents !== 'none';
  }
  function checkAgent(doc = document) {
    if (location.origin !== 'https://arena.ai') fail('WRONG_PAGE', 'Only https://arena.ai is supported.');
    const kind = pageKind(doc);
    if (kind === 'direct') {
      const mode = modeLabel(doc);
      if (mode && !/^direct$/i.test(mode)) fail('WRONG_PAGE', `This Arena chat is in ${mode} mode. Automatic capture supports Agent Mode and Direct (one model) chats only.`);
      return;
    }
    if (kind === 'text-other') fail('WRONG_PAGE', 'Battle and Side-by-Side are not supported. Use Direct (one model) or Agent Mode.');
    if (!/^\/agent\/?$/.test(location.pathname) && !rows(doc).length)
      fail('WRONG_PAGE', 'Open an Agent or Direct conversation. No verified transcript markers were found on this page.');
  }
  function reviewPanel(doc = document) {
    const closers = [...doc.querySelectorAll('button[aria-label="Close review panel"]')]
      .filter(el => visible(el) && !el.closest(`${ROW},.not-prose,nav,aside,[role="navigation"]`));
    if (!closers.length) return null;
    const matches = [];
    for (const close of closers) {
      for (let root = close.parentElement, depth = 0; root && depth < 6; root = root.parentElement, depth++) {
        if (root === doc.body || root === doc.documentElement || root.matches('main,[role="main"]') || root.closest(ROW)) break;
        const question = [...root.querySelectorAll('span,p,legend,h1,h2,h3')].some(el =>
          visible(el) && !el.closest('button') && normalize(el.innerText || el.textContent).toLowerCase() === 'was this task successful?');
        if (!question) continue;
        const buttons = [...root.querySelectorAll('button')].filter(visible);
        const options = buttons.filter(el => el !== close).map(el => normalize(el.innerText || el.textContent).toLowerCase());
        if (buttons.length === 4 && ['yes', 'no', 'keep working'].every(name => options.filter(value => value === name).length === 1)) {
          matches.push({ root, close }); break;
        }
      }
    }
    if (matches.length > 1 || closers.length > 1)
      fail('AMBIGUOUS_REVIEW_PANEL', 'Multiple visible task-review close controls were found. Open Arena and resolve the review yourself. No control from this ambiguous set will be clicked.');
    if (!matches.length)
      fail('UNRECOGNIZED_REVIEW_PANEL', 'A review close control is visible, but its surrounding panel does not match the supplied task-success review. Nothing will be dismissed automatically. Open Arena to continue.');
    return matches[0];
  }
  function conversationReady(doc = document) {
    checkBlocks(doc); checkAgent(doc);
    const list = rows(doc);
    if (running(doc)) fail('AGENT_BUSY', 'Arena is already generating. Wait in the Arena tab before sending another prompt.');
    const last = list.at(-1);
    const settled = row => directEls.has(row.el) ? !directPending(row.el) && (ended(row.el) || !!directProblem(row.el)) : ended(row.el);
    if (last && (last.user || !settled(last))) fail('AGENT_BUSY', 'The last turn in this Arena chat is not marked complete. Finish it in Arena before sending another prompt.');
    return list;
  }
  function inspectControls(doc = document) {
    checkBlocks(doc); checkAgent(doc);
    if (reviewPanel(doc)) return { inputKind: 'review panel', reviewPending: true, uploadKind: 'unknown' };
    const field = composer(doc), button = sendButton(doc, field);
    return { field, button, inputKind: field.tagName === 'TEXTAREA' ? 'textarea' : 'contenteditable', uploadKind: uploadsFor(field, doc).kind, fileInputCount: fileInputsFor(field, doc).length };
  }
  function preflight(doc = document) {
    const list = conversationReady(doc);
    if (reviewPanel(doc)) fail('REVIEW_PANEL_VISIBLE', 'The task-review panel still covers the composer. Close it in Arena before continuing. No feedback option was selected and no Send click was attempted.');
    const field = composer(doc);
    if (composerText(field).trim()) fail('DRAFT_EXISTS', 'Arena already has an unsent draft. Send or clear it yourself; the extension will not overwrite it.');
    sendButton(doc, field); // Existence only: an empty composer normally has a disabled Send.
    return { list, field };
  }
  // Only the supplied clarification-card structure, inside an attributed assistant row.
  function questionsFor(row) {
    const groups = [...row.querySelectorAll('[role="radiogroup"][aria-label]')].filter(group =>
      visible(group) && rowOf(group) === row && !group.closest('.prose,pre,code,nav,aside,[role="dialog"]'));
    const found = [];
    for (const group of groups) {
      const root = group.parentElement, question = normalize(group.getAttribute('aria-label'));
      if (!question || question.length > 1200) continue;
      const header = root?.firstElementChild && root.firstElementChild !== group ? root.firstElementChild : null;
      // A follow-up card in the same conversation may arrive without the supplied header at all.
      const skip = header ? [...header.querySelectorAll('button')].filter(visible) : [];
      const heading = header ? [...header.querySelectorAll('span')].find(el => visible(el) && normalize(el.textContent) === question) : null;
      if (header && !heading) continue;
      // Only a Skip control is tolerated in the header; any other labelled control fails recognition.
      if (skip.length > 1 || (skip.length === 1 && normalize(skip[0].textContent) !== 'Skip')) continue;
      const buttons = [...group.querySelectorAll('button[role="radio"]')].filter(visible);
      // Sequential questions can offer a single choice, so one radio is accepted.
      if (buttons.length < 1 || buttons.length > 6) continue;
      if (root.querySelectorAll('[role="radiogroup"]').length !== 1) continue;
      const options = buttons.map(button => {
        const parts = [...button.querySelectorAll('.body-sm')].filter(visible);
        if (parts.length < 1 || parts.length > 2 || !['true','false'].includes(button.getAttribute('aria-checked'))) return null;
        const label = normalize(parts[0].textContent), description = normalize(parts[1]?.textContent || '');
        return label && label.length <= 500 && description.length <= 1500 ? { label, description, disabled: !enabled(button) || !!button.closest('[inert]'), checked: button.getAttribute('aria-checked') === 'true' } : null;
      });
      if (options.some(option => !option) || new Set(options.map(o => o.label)).size !== options.length) continue;
      const inputs = [...group.querySelectorAll('input[type="text"][placeholder="Revise options or write your own..."][maxlength="2000"]')].filter(visible);
      const submits = [...group.querySelectorAll('button[aria-label="Submit custom response"]')].filter(visible);
      const custom = inputs.length === 1 && submits.length === 1;
      if (!custom && (inputs.length || submits.length)) continue;
      const fields = [...root.querySelectorAll('input,textarea,select,[contenteditable]')].filter(visible);
      if (fields.some(field => !custom || field !== inputs[0])) continue;
      const allowedButtons = new Set([...buttons, ...submits, ...skip]);
      if ([...root.querySelectorAll('button')].filter(visible).some(button => !allowedButtons.has(button))) continue;
      const sensitive = /\b(captcha|verification|password|credential|secret|token|sign[ -]?in|log[ -]?in|permission|approv\w*|authoriz\w*|payment|purchase|delete|destructive|execut\w*)\b|\brun\b.{0,35}\b(command|script|code|bash|shell)\b/i.test([question,...options.map(o=>o.label+' '+o.description)].join(' '));
      const readOnly = sensitive || options.some(option => option.checked);
      const data = { rowId: row.getAttribute('data-chat-message-id'), question, options, custom, readOnly,
        reason: sensitive ? 'This may be an approval, sensitive action or security question. Handle it in Arena.' : readOnly ? 'An option is already selected in Arena. Wait there or check its state.' : '' };
      found.push({ root, group, buttons, input: custom ? inputs[0] : null, submit: custom ? submits[0] : null, data, fingerprint: JSON.stringify(data) });
    }
    if (new Set(found.map(q => q.fingerprint)).size !== found.length)
      fail('AMBIGUOUS_QUESTION', 'Duplicate clarification cards were found. Answer them in Arena; no option was selected.');
    return found;
  }
  // Visible thinking label only (e.g. "Thinking…", "Thought for 12s"). The collapsed body is never
  // opened, read or copied; hidden reasoning is not extracted. English wording heuristic.
  const THINKING_ACTIVE = /^(?:thinking|reasoning)(?:\s*(?:\.{3}|…))?$/i;
  const THINKING_DONE = /^(?:thought|reasoned)\s+for\s+(?:\d+(?:\.\d+)?\s*(?:ms|s|secs?|seconds?|m|mins?|minutes?)|a (?:few seconds|second|moment))$/i;
  function thinkingStatus(row) {
    let found = null;
    const walker = row.ownerDocument.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(), seen = 0; node && seen < 5000; node = walker.nextNode(), seen++) {
      const raw = node.nodeValue.trim();
      if (!raw || raw.length > 40 || !/^(?:thinking|reasoning|thought|reasoned)\b/i.test(raw)) continue;
      const host = node.parentElement;
      if (!host || host.closest('.prose,pre,code,[role="radiogroup"],textarea,input') || rowOf(host) !== row || !visible(host)) continue;
      const classify = label => THINKING_ACTIVE.test(label) ? 'active' : THINKING_DONE.test(label) ? 'done' : '';
      // The text node alone may be the label (its container can also hold the collapsed body, which
      // is never read); otherwise widen over at most three inline ancestors while the text still matches.
      let best = classify(normalize(raw)) ? { state: classify(normalize(raw)), label: normalize(raw) } : null;
      for (let el = host, depth = 0; el && el !== row && depth < 3; el = el.parentElement, depth++) {
        const label = normalize(el.textContent);
        if (label.length > 60) break;
        const state = classify(label);
        if (state) best = { state, label };
      }
      if (best) found = { state: best.state, label: best.label.replace(/\.{3}$/, '…') };
    }
    return found;
  }
  function toolActivity(row) {
    return [...row.querySelectorAll('button[aria-expanded][aria-label="Expand"],button[aria-expanded][aria-label="Collapse"]')]
      .filter(button => visible(button) && rowOf(button) === row && !button.closest('.prose,pre,code,[role="radiogroup"]'))
      .map(button => {
        const labels = [...button.querySelectorAll('.body-sm')].filter(visible).map(el => normalize(el.textContent));
        if (labels.length !== 2 || labels[0] !== 'used' || labels[1] !== 'Bash') return null;
        const duration = normalize(button.querySelector('.font-mono')?.textContent || '');
        if (duration && !/^(?:exit -?\d+ )?\d+(?:\.\d+)?(?:ms|s|m)$/.test(duration)) return null;
        return { tool: 'Bash', duration, status: button.querySelector('.text-interactive-negative') ? 'error' : button.querySelector('.text-interactive-positive') ? 'done' : 'activity' };
      }).filter(Boolean).slice(0,100);
  }
  // With a staged upload the page usually renders its own attachment chips inside the user row.
  // Only a short suffix made of that chip text is tolerated; any change of wording fails closed.
  function promptMatches(tx, text) {
    const shown = normalize(text), expected = normalize(tx.prompt);
    if (shown === expected) return true;
    return !!tx.attachmentLabels && shown.startsWith(expected) && shown.length - expected.length <= 200;
  }
  function matchTurn(tx, doc = document) {
    const list = rows(doc), ids = list.map(r => r.id);
    // Exact prefix, not a page text diff. Virtualization or conversation changes fail closed.
    if (tx.baseline.some((id, i) => ids[i] !== id))
      fail('CONVERSATION_CHANGED', 'The Agent transcript changed or was virtualized. Capture stopped to avoid an unrelated reply. Inspect the Arena tab.');
    const added = list.slice(tx.baseline.length);
    if (!added.length) return { accepted: false };
    const users = added.filter(r => r.user);
    if (users.length !== 1 || !added[0].user)
      fail('AMBIGUOUS_TURN', 'Another turn or an unexpected message appeared. Capture stopped rather than associate the wrong reply.');
    const user = users[0];
    if (!promptMatches(tx, answerText(user.el)))
      fail('PROMPT_MISMATCH', 'Arena showed a different user message. Capture stopped. Check the tab; the extension will not retry.');
    if (tx.userId && tx.userId !== user.id)
      fail('CONVERSATION_CHANGED', 'The submitted message ID changed. Capture stopped.');
    if (tx.seenRows?.some((id, index) => added[index]?.id !== id))
      fail('CONVERSATION_CHANGED', 'Tracked turn rows were removed or reordered. Live capture stopped.');
    const assistants = added.slice(1).filter(r => !r.user);
    const classified = assistants.map(row => ({ row, questions: questionsFor(row.el), tools: toolActivity(row.el), text: answerText(row.el) }));
    const cardGroups = item => [...item.row.el.querySelectorAll('[role="radiogroup"]')].filter(group => visible(group) && !group.closest('.prose,pre,code')).length;
    // Only recognized clarification/tool-only rows may surround the one prose reply. An unanswered
    // or unrecognized question card is interaction UI, never a competing final reply candidate.
    const interaction = item => item.questions.length || cardGroups(item) > 0;
    const replyLike = item => !interaction(item) && (!!item.text || ended(item.row.el));
    const auxiliary = item => !replyLike(item);
    const replies = classified.filter(replyLike);
    if (replies.length > 1) fail('AMBIGUOUS_REPLY', 'Multiple ungrouped assistant replies followed this prompt. Read the result in Arena; capture stopped rather than guessing.');
    const proseOnly = classified.filter(item => item.text);
    // A second live text row is normal while a turn is still running; only two completed prose
    // rows are ambiguous, because either could claim to be this prompt's final answer.
    if (!replies.length && proseOnly.length > 1 && proseOnly.some(item => ended(item.row.el)))
      fail('AMBIGUOUS_REPLY', 'The assistant produced more than one ungrouped reply for this prompt. Read the result in Arena; capture stopped rather than guessing.');
    if (added[0].user && directEls.has(added[0].el)) {
      for (const item of classified) {
        const problem = directProblem(item.row.el);
        if (problem?.code === 'GENERATION_STOPPED') fail('GENERATION_STOPPED', 'The reply was stopped in Arena before it finished. Nothing was retried; read or rerun it in Arena.');
        if (problem) fail(problem.code, `Arena reported a problem with this reply${problem.text ? `: “${problem.text}”` : ''}. Nothing was retried. Check the Arena tab.`);
      }
    }
    const reply = replies[0];
    if (reply && tx.assistantId && tx.assistantId !== reply.row.id)
      fail('AMBIGUOUS_REPLY', 'The assistant message ID changed. Capture stopped.');
    const questions = classified.flatMap(item => item.questions);
    if (questions.length > 12) fail('TOO_MANY_QUESTIONS', 'More than twelve clarification cards are visible. Continue in Arena.');
    const liveText = classified.map(item => item.text).filter(Boolean).join('\n\n');
    if (liveText.length > 200000) fail('REPLY_TOO_LARGE', 'Live output exceeds 200,000 characters. Read it in Arena instead.');
    const tools = classified.flatMap(item => item.tools).slice(-100);
    const thinking = assistants.map(row => thinkingStatus(row.el)).filter(Boolean).at(-1) || null;
    const unknownQuestions = classified.some(item => cardGroups(item) > item.questions.length);
    return { accepted: true, userId: user.id, assistantId: reply?.text ? reply.row.id : undefined,
      turnIds: added.map(row => row.id), questionRows: classified.filter(item => item.questions.length).map(item => item.row.id), questions, tools,
      interactionNotice: unknownQuestions ? 'Some question controls do not match the supported card. Answer those in Arena; they will not be clicked here.' : '',
      liveText, thinking, generating: running(doc),
      complete: !!reply && ended(reply.row.el) && !running(doc) && !questions.length && !classified.some(item => cardGroups(item) > 0),
      text: reply?.text || '', model: reply && directEls.has(reply.row.el) ? modelOf(reply.row.el) : '' };
  }

  // Read-only import of the open conversation's earlier turns, on explicit request only.
  // Each user row is paired with the assistant rows up to the next user row, using the same reply
  // rules as live capture: exactly one plain prose row is the reply; question/tool/summary rows are
  // activity; anything else is reported as unclear instead of guessed. Nothing is clicked or scrolled.
  const HISTORY_MAX_TURNS = 200, HISTORY_MAX_CHARS = 2000000;
  function historyTurns(doc = document) {
    checkBlocks(doc); checkAgent(doc);
    const list = rows(doc);
    const firstUser = list.findIndex(row => row.user);
    const result = { turns: [], startMissing: firstUser !== 0 && list.length > 0, truncated: false, inProgressSkipped: false, total: 0 };
    let chars = 0;
    for (let i = Math.max(firstUser, 0); firstUser >= 0 && i < list.length; i++) {
      if (!list[i].user) continue;
      const user = list[i], assistants = [];
      for (let j = i + 1; j < list.length && !list[j].user; j++) assistants.push(list[j]);
      // The newest turn is still being produced: leave it to live capture instead of importing half of it.
      const isLast = !list.slice(i + 1).some(row => row.user);
      if (isLast && (running(doc) || !assistants.length)) { result.inProgressSkipped = true; break; }
      result.total++;
      const prompt = answerText(user.el);
      const classified = assistants.map(row => ({ row, text: answerText(row.el),
        groups: [...row.el.querySelectorAll('[role="radiogroup"]')].filter(g => visible(g) && !g.closest('.prose,pre,code')).length,
        tools: toolActivity(row.el), thinking: thinkingStatus(row.el) }));
      const replies = classified.filter(item => item.text && !item.groups);
      const status = !prompt ? 'unreadable' : replies.length === 1 ? 'complete' : replies.length ? 'ambiguous' : 'no-reply';
      const reply = status === 'complete' ? replies[0].text : '';
      if (result.turns.length >= HISTORY_MAX_TURNS || chars + prompt.length + reply.length > HISTORY_MAX_CHARS) { result.truncated = true; break; }
      chars += prompt.length + reply.length;
      result.turns.push({ userMessageId: user.id, assistantMessageId: status === 'complete' ? replies[0].row.id : undefined,
        prompt, reply, status, model: status === 'complete' && directEls.has(replies[0].row.el) ? modelOf(replies[0].row.el) : '',
        tools: classified.flatMap(item => item.tools).slice(-100),
        thinking: classified.map(item => item.thinking).filter(Boolean).at(-1) || null });
    }
    return result;
  }
  function historyCount(doc = document) {
    try { return rows(doc).filter(row => row.user).length; } catch { return 0; }
  }

  globalThis.ArenaAgentDOM = { version: '2.3.0', ROW, DomError, fail, visible, checkBlocks, rows, ended, running,
    composer, sendButton, enabled, reviewPanel, conversationReady, inspectControls, preflight, matchTurn, questionsFor, toolActivity, thinkingStatus, historyTurns, historyCount, answerText, normalize, composerText, writeComposer, composerSummary, fileInputsFor, composerFileInputs, uploadsFor, stageRequestFor, nearComposer, promptMatches,
    pageKind, modeLabel, currentModel, modelCatalog, samePage };
})();
