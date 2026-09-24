import { LiveView } from './live-view.js';
// Presentation only: no tab, transport, credential, or storage access.
export class ConversationView {
  constructor(doc = document, onAnswer = () => {}) {
    this.onAnswer = onAnswer;
    this.doc = doc;
    this.scroll = doc.getElementById('chat-scroll');
    this.history = doc.getElementById('history');
    this.latest = doc.getElementById('latest-reply');
    this.announcement = doc.getElementById('chat-announcement');
    this.nodes = new Map();
    this.following = true; this.unseen = false; this.count = 0; this.frame = null;
    this.lastSignature = ''; this.lastPending = ''; this.positioning = false;
    this.scroll.addEventListener('scroll', () => {
      if (this.positioning) return;
      this.following = this.nearBottom();
      if (this.following) this.unseen = false;
      this.updateJump();
    }, { passive: true });
    this.latest.addEventListener('click', () => { this.following = true; this.unseen = false; this.toBottom(); });
    this.resize = new ResizeObserver(() => {
      if (this.following) this.toBottom(); else this.updateJump();
    });
    this.resize.observe(this.scroll);
    // The toolbar and composer float over the chat as glass; their heights pad the scroller.
    const root = doc.documentElement, toolbar = doc.getElementById('toolbar'), dock = doc.querySelector('.composer-dock');
    this.layoutResize = new ResizeObserver(() => {
      const top = `${Math.ceil(toolbar.getBoundingClientRect().height)}px`, bottom = `${Math.ceil(dock.getBoundingClientRect().height)}px`;
      if (root.style.getPropertyValue('--toolbar-h') !== top) root.style.setProperty('--toolbar-h', top);
      if (root.style.getPropertyValue('--composer-h') !== bottom) root.style.setProperty('--composer-h', bottom);
      if (this.following) this.toBottom(); else this.updateJump();
    });
    for (const node of [toolbar, dock]) if (node) this.layoutResize.observe(node);
  }
  nearBottom() { return this.scroll.scrollHeight - this.scroll.clientHeight - this.scroll.scrollTop <= 64; }
  updateJump() {
    this.latest.hidden = this.nearBottom();
    this.latest.textContent = this.unseen ? 'New reply ↓' : 'Latest reply ↓';
  }
  toBottom() { this.scroll.scrollTop = this.scroll.scrollHeight; this.updateJump(); }
  create(turn, index) {
    const el = (tag, className, text) => {
      const node = this.doc.createElement(tag); node.className = className;
      if (text) node.textContent = text; return node;
    };
    const article = el('article', 'turn'); article.dataset.turnId = turn.id;
    article.setAttribute('aria-label', `Turn ${index + 1}`);
    const userGroup = el('div', 'user-message');
    const userMeta = el('div', 'message-meta user-meta');
    const indexLabel = el('span', 'message-index', `Turn ${index + 1}`);
    userMeta.append(el('span', 'message-speaker', 'You'), indexLabel);
    if (turn.imported) { article.classList.add('imported'); userMeta.append(el('span', 'imported-badge', 'From Arena page')); }
    const prompt = el('div', 'bubble user'); prompt.textContent = turn.prompt;
    const attachments = el('p', 'turn-attachments'); attachments.hidden = true;
    userGroup.append(userMeta, prompt, attachments);
    const assistant = el('div', 'assistant-message'); assistant.hidden = true;
    const assistantMeta = el('div', 'message-meta');
    const avatar = el('span', 'assistant-mark', 'a'); avatar.setAttribute('aria-hidden', 'true');
    const replyLabel = el('span', 'message-index reply-label', '');
    assistantMeta.append(avatar, el('span', 'message-speaker', 'Arena'), replyLabel);
    const reply = el('div', 'bubble assistant');
    assistant.append(assistantMeta, reply);
    const outcome = el('p', 'turn-outcome'); outcome.hidden = true;
    article.append(userGroup);
    const live = new LiveView(article, this.onAnswer);
    article.append(outcome);
    this.history.append(article);
    return { article, prompt, assistant, reply, outcome, live, attachments, indexLabel, replyLabel, labelText: null, status: '', text: '', attachmentText: null };
  }
  render(turns, pending, state) {
    const originalTop = this.scroll.scrollTop;
    const added = turns.length > this.count;
    const signature = turns.map(t => `${t.id}:${t.status}:${t.reply.length}:${t.liveRevision || 0}`).join('|');
    const pendingSignature = `${pending?.id || ''}:${pending?.status || ''}`;
    const changed = signature !== this.lastSignature || pendingSignature !== this.lastPending;
    let receivedReply = false;
    const ids = new Set(turns.map(t => t.id));
    for (const [id, item] of this.nodes) {
      if (!ids.has(id)) { item.article.remove(); this.nodes.delete(id); }
    }
    for (const [index, turn] of turns.entries()) {
      let item = this.nodes.get(turn.id);
      if (!item) { item = this.create(turn, index); this.nodes.set(turn.id, item); }
      item.live.render(turn, pending?.id === turn.id && state !== 'error' && turn.status !== 'cancelled');
      const size = bytes => globalThis.ArenaAgentAttachments?.formatBytes(bytes) ?? `${bytes} B`;
      const attachmentSummary = (turn.attachments || []).map(a => `${a.name} (${size(a.size)})`).join(', ');
      if (item.attachmentText !== attachmentSummary) {
        item.attachments.textContent = attachmentSummary ? `Attached: ${attachmentSummary}` : '';
        item.attachments.hidden = !attachmentSummary; item.attachmentText = attachmentSummary;
      }
      if (item.text !== turn.reply) {
        receivedReply ||= !!turn.reply;
        item.reply.textContent = turn.reply; item.text = turn.reply;
      }
      // Direct replies name the model Arena shows on the reply card; Agent replies stay "Agent reply".
      const label = `${turn.model ? turn.model : turn.mode === 'direct' ? 'Direct reply' : 'Agent reply'}${turn.imported ? ' · from Arena page' : ''}`;
      if (item.labelText !== label) { item.replyLabel.textContent = label; item.labelText = label; }
      item.assistant.hidden = !turn.reply;
      if (turn.reply && !item.assistant.isConnected) item.article.insertBefore(item.assistant, item.outcome);
      if (!turn.reply && item.assistant.isConnected) item.assistant.remove();
      if (item.status !== turn.status) {
        item.article.dataset.state = turn.status;
        const outcome = turn.outcomeText ? turn.outcomeText : turn.status === 'cancelled' ? 'Tracking stopped in this panel. The Arena task may continue.' : turn.status === 'error' && pending?.id !== turn.id ? 'No reply captured. Check the Arena tab.'
          : turn.status === 'imported-no-reply' ? 'No reply text is on the page for this message (it may have been only tool activity or a question). Read it in Arena.'
          : turn.status === 'imported-ambiguous' ? 'Several separate replies are on the page for this message, so none was picked. Read it in Arena.'
          : turn.status === 'imported-unreadable' ? 'This message’s text could not be read from the page.' : '';
        item.outcome.textContent = outcome; item.outcome.hidden = !outcome;
        item.status = turn.status;
      }
    }
    const order = turns.map(t => t.id).join('|');
    if (order !== this.order) {
      turns.forEach((turn, index) => { const item = this.nodes.get(turn.id); if (!item) return; this.history.append(item.article);
        item.indexLabel.textContent = `Turn ${index + 1}`; item.article.setAttribute('aria-label', `Turn ${index + 1}`); });
      this.order = order;
    }
    this.doc.getElementById('history-section').hidden = !turns.length;
    this.doc.getElementById('chat-empty').hidden = !!turns.length;
    this.doc.getElementById('empty-help').textContent = state === 'ready' ? 'Ask anything below. Your messages and the Agent’s replies appear here.' : 'Connect your signed-in Arena Agent tab to start chatting from here.';
    this.doc.getElementById('turn-count').textContent = `${turns.length} ${turns.length === 1 ? 'turn' : 'turns'}`;
    if (!turns.length) { this.following = true; this.unseen = false; this.announcement.textContent = ''; }
    if (added) this.following = true; // An explicit new Send intentionally shows the new turn.
    if (receivedReply) {
      this.announcement.textContent = `Reply received for turn ${turns.length}.`;
      if (!this.following) this.unseen = true;
    }
    this.count = turns.length; this.lastSignature = signature; this.lastPending = pendingSignature;
    if (changed) {
      if (this.frame) cancelAnimationFrame(this.frame);
      this.positioning = true;
      this.frame = requestAnimationFrame(() => {
        if (this.following) this.toBottom(); else this.scroll.scrollTop = originalTop;
        this.positioning = false; this.frame = null; this.updateJump();
      });
    } else this.updateJump();
  }
}
