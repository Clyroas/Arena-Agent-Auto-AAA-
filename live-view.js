// Text-only rendering. Options are local selections until the user explicitly submits.
export class LiveView {
  constructor(parent, onAnswer) {
    this.doc = parent.ownerDocument; this.onAnswer = onAnswer; this.cards = new Map();
    this.root = this.node('section', 'live-output'); this.root.setAttribute('aria-label', 'Live Agent activity');
    this.heading = this.node('h3', 'live-heading', 'Live activity · not a final answer');
    this.notice = this.node('p', 'live-notice hint');
    this.text = this.node('div', 'live-text'); this.tools = this.node('ul', 'live-tools'); this.questions = this.node('div', 'live-questions');
    this.thinking = this.node('p', 'live-thinking');
    this.root.append(this.heading, this.thinking, this.text, this.tools, this.notice, this.questions); parent.append(this.root); this.root.hidden = true;
  }
  node(tag, className, text = '') { const el = this.doc.createElement(tag); el.className = className; el.textContent = text; return el; }
  createCard(question, turnId) {
    const card = this.node('section', 'question-card'); card.setAttribute('aria-label', question.question);
    const title = this.node('h4', 'question-title', question.question);
    const group = this.node('div', 'question-options'); group.setAttribute('role', 'radiogroup'); group.setAttribute('aria-label', question.question);
    const checked = question.options.findIndex(option => option.checked);
    const item = { card, question, buttons: [], selected: checked >= 0 ? checked : null, mode: 'option', submitted: false };
    const refresh = () => {
      const locked = item.locked || item.submitted;
      item.buttons.forEach((button, index) => { button.disabled = locked || question.options[index].disabled; button.setAttribute('aria-checked', String(item.mode === 'option' && item.selected === index)); });
      if (item.input) item.input.disabled = locked;
      item.submit.disabled = locked || (item.mode === 'custom' ? !item.input?.value.trim() : item.selected === null);
      item.submit.textContent = item.mode === 'custom' ? 'Submit custom answer' : 'Submit selected answer';
    };
    question.options.forEach((option, index) => {
      const button = this.node('button', 'question-option'); button.type = 'button'; button.setAttribute('role', 'radio'); button.setAttribute('aria-checked', 'false');
      button.append(this.node('strong', '', option.label), this.node('span', '', option.description));
      button.addEventListener('click', () => { item.selected = index; item.mode = 'option'; refresh(); });
      group.append(button); item.buttons.push(button);
    });
    card.append(title, group);
    if (question.custom) {
      const label = this.node('label', 'custom-answer-label', 'Or write your own answer');
      const input = this.node('input', 'custom-answer'); input.type = 'text'; input.maxLength = 2000; input.placeholder = 'Your answer…';
      label.append(input); card.append(label); item.input = input;
      input.addEventListener('input', () => { item.mode = 'custom'; refresh(); });
    }
    item.submit = this.node('button', 'primary question-submit', 'Submit selected answer'); item.submit.type = 'button';
    item.status = this.node('p', 'question-status', 'Nothing is sent until you submit.'); item.status.setAttribute('role', 'status');
    item.submit.addEventListener('click', () => {
      if (item.submit.disabled || item.submitted) return;
      item.submitted = true; item.status.textContent = 'Sending your chosen answer once…'; refresh();
      this.onAnswer(turnId, { token: question.token, kind: item.mode, ...(item.mode === 'custom' ? { text: item.input.value } : { index: item.selected }) });
    });
    card.append(item.submit, item.status); item.refresh = refresh; refresh(); return item;
  }
  render(turn, active) {
    const live = turn.live || { text: '', tools: [], questions: [] };
    const preview = turn.reply ? '' : live.text || '';
    this.heading.textContent = turn.imported ? 'Activity shown on the Arena page' : turn.reply ? 'Activity during this turn' : active ? 'Live activity · not a final answer' : 'Stopped activity · not a final answer';
    this.text.textContent = preview; this.text.hidden = !preview;
    const signature = JSON.stringify(live.tools || []);
    if (signature !== this.toolSignature) {
      this.tools.replaceChildren(...(live.tools || []).map(tool => this.node('li', `tool-activity tool-${tool.status}`, `Used ${tool.tool}${tool.duration ? ' · ' + tool.duration : ''}${tool.status === 'error' ? ' · error reported' : tool.status === 'done' ? ' · completed' : ''}`)));
      this.toolSignature = signature;
    }
    this.tools.hidden = !live.tools?.length;
    // Only Arena's visible label is mirrored; its collapsed thought text is never opened or copied.
    const thinking = live.thinking?.label ? `${live.thinking.label} · thought text stays collapsed in Arena` : '';
    if (this.thinking.textContent !== thinking) this.thinking.textContent = thinking;
    this.thinking.hidden = !thinking; this.thinking.dataset.state = live.thinking?.state || '';
    this.notice.textContent = live.interactionNotice || ''; this.notice.hidden = !live.interactionNotice;
    const tokens = new Set((live.questions || []).map(question => question.token));
    for (const [token, item] of this.cards) if (!tokens.has(token)) { item.card.remove(); this.cards.delete(token); }
    for (const question of live.questions || []) {
      let item = this.cards.get(question.token);
      if (!item) { item = this.createCard(question, turn.id); this.cards.set(question.token, item); this.questions.append(item.card); }
      item.locked = !active || question.readOnly || question.busy || !!question.answerState;
      if (question.answerState || question.reason || !active) item.status.textContent = question.answerState || question.reason || 'Tracking stopped. Handle this question in Arena.';
      item.refresh();
    }
    this.root.hidden = !preview && !live.tools?.length && !live.questions?.length && !live.interactionNotice && !thinking;
  }
}
