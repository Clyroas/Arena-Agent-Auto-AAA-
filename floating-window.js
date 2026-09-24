// Window creation only; no chat state or credentials are retained in the worker.
let opening = null;
export function openFloatingWindow(api = chrome) {
  if (opening) return opening;
  opening = (async () => {
    const url = api.runtime.getURL('floating.html');
    // Own extension contexts are visible without requesting broad tabs permission.
    const contexts = await api.runtime.getContexts({ documentUrls: [url], contextTypes: ['TAB'] });
    let existing = null;
    for (const context of contexts) {
      try { const win = await api.windows.get(context.windowId); if (win.type === 'popup') { existing = win; break; } }
      catch { /* The window may have closed since enumeration. */ }
    }
    if (existing) {
      const update = { focused: true };
      if (existing.state === 'minimized') update.state = 'normal';
      await api.windows.update(existing.id, update);
      return { windowId: existing.id };
    }
    const win = await api.windows.create({ url, type: 'popup', width: 460, height: 820, focused: true });
    return { windowId: win.id };
  })().finally(() => { opening = null; });
  return opening;
}
