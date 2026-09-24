// Pure: turns the adapter's visible-activity snapshot into a one-line status for the pending card.
// It only summarizes data already shown elsewhere (visible labels, tool headers, public live text).
const RECENT_TEXT_MS = 4000;

export function formatElapsed(ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  const pad = n => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function latestSentence(text, max = 140) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  const parts = clean.split(/(?<=[.!?…])\s+/).filter(Boolean);
  let last = parts.at(-1) || clean;
  // A one- or two-word fragment just after a full stop is hard to read; include the prior sentence.
  if (last.split(' ').length < 3 && parts.length > 1) last = `${parts.at(-2)} ${last}`;
  if (last.length <= max) return last;
  const cut = last.slice(-max);
  const space = cut.indexOf(' ');
  return `…${space > 0 && space < 30 ? cut.slice(space + 1) : cut}`;
}

export function liveStatus(turn, now = Date.now()) {
  if (!turn) return null;
  const live = turn.live || {};
  const tools = Array.isArray(live.tools) ? live.tools : [];
  const lastTool = tools.at(-1);
  const since = turn.acceptedAt ? formatElapsed(now - turn.acceptedAt) : '';
  const quiet = turn.lastActivityAt ? Math.floor((now - turn.lastActivityAt) / 1000) : null;
  const meta = [since && `${since} elapsed`, quiet !== null && quiet >= 10 ? `last change ${formatElapsed(quiet * 1000)} ago` : ''].filter(Boolean).join(' · ');
  const result = (step, detail, kind) => ({ step, detail, kind, meta });

  if (turn.status === 'error') return result('Capture stopped', 'Read the error above and check the Arena tab.', 'error');
  if (turn.phase === 'reconnecting') return result('Reconnecting to Arena', 'The connection dropped. Reattaching to the same tab to keep tracking this reply — nothing is resent.', 'reconnecting');
  if (turn.status === 'sending') {
    if (turn.phase === 'upload') return result('Uploading your files', 'Placing the staged files into Arena’s composer before the one Send click.', 'sending');
    if (turn.phase === 'review') return result('Closing the task review', 'Only the neutral Close control is used; no feedback is selected.', 'sending');
    return result('Sending your message', 'Attempting exactly one Send click in Arena.', 'sending');
  }
  if (live.questions?.length) return result('Waiting for your answer', 'Arena asked a question below. Nothing is chosen for you.', 'question');
  if (live.interactionNotice) return result('Waiting for you in Arena', 'Arena shows a control this panel does not operate.', 'question');
  const textFresh = !!live.text && turn.textChangedAt && now - turn.textChangedAt < RECENT_TEXT_MS;
  if (live.thinking?.state === 'active' && !textFresh)
    return result('Thinking', `Arena shows “${live.thinking.label}”. The thought text stays collapsed in Arena.`, 'thinking');
  if (lastTool?.status === 'activity' && !textFresh)
    return result(`Using ${lastTool.tool}${lastTool.duration ? ` · ${lastTool.duration}` : ''}`, `${tools.length} tool step${tools.length === 1 ? '' : 's'} so far.`, 'tool');
  if (textFresh) return result('Writing', latestSentence(live.text), 'writing');
  const done = [live.thinking?.state === 'done' ? live.thinking.label : '',
    tools.length ? `${tools.length} tool step${tools.length === 1 ? '' : 's'}${lastTool ? ` · last: ${lastTool.tool}${lastTool.duration ? ` (${lastTool.duration})` : ''}${lastTool.status === 'error' ? ', error reported' : ''}` : ''}` : '']
    .filter(Boolean).join(' · ');
  if (live.text) return result(live.generating ? 'Working' : 'Finishing up', done || latestSentence(live.text), 'working');
  return result('Working', done || (live.generating ? 'Arena is generating. Waiting for its first visible update.' : 'Waiting for Arena’s first visible update.'), 'working');
}
