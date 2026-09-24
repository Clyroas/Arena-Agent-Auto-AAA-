// Only numeric normal-window bounds are saved. No additional Chrome permissions.
export function fitBounds(saved, screen) {
  const left = Number.isFinite(screen.availLeft) ? screen.availLeft : 0;
  const top = Number.isFinite(screen.availTop) ? screen.availTop : 0;
  const availableWidth = Math.max(320, screen.availWidth || 1280);
  const availableHeight = Math.max(360, screen.availHeight || 900);
  const number = (value, fallback) => Number.isFinite(value) ? Math.round(value) : fallback;
  const width = Math.min(availableWidth, Math.max(320, number(saved?.width, 460)));
  const height = Math.min(availableHeight, Math.max(360, number(saved?.height, 820)));
  return {
    width, height,
    left: Math.min(left + availableWidth - width, Math.max(left, number(saved?.left, left + availableWidth - width - 24))),
    top: Math.min(top + availableHeight - height, Math.max(top, number(saved?.top, top + 24)))
  };
}
export async function setupFloatingGeometry() {
  const KEY = 'arenaAgentWindowBounds';
  const status = document.getElementById('window-status');
  try {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(KEY)); } catch { /* use safe defaults */ }
    const current = await chrome.windows.getCurrent();
    if (current.type !== 'popup') return; // Do not resize ordinary tabs or a browser's main window.
    let restoring = true;
    const record = win => {
      if (restoring || win.id !== current.id || win.state !== 'normal') return;
      if (![win.width, win.height, win.left, win.top].every(Number.isFinite)) return;
      try { localStorage.setItem(KEY, JSON.stringify({ width: win.width, height: win.height, left: win.left, top: win.top })); }
      catch { if (status) status.textContent = 'Window moves normally, but Chrome could not save its size and position.'; }
    };
    chrome.windows.onBoundsChanged.addListener(record);
    window.addEventListener('pagehide', () => chrome.windows.onBoundsChanged.removeListener(record), { once: true });
    let restored;
    const bounds = fitBounds(saved || { left: current.left, top: current.top }, window.screen);
    try { restored = await chrome.windows.update(current.id, bounds); }
    catch {
      // Display/work-area changes can invalidate a formerly valid position. Keep Chrome's safe location.
      restored = await chrome.windows.update(current.id, { width: bounds.width, height: bounds.height });
      if (status) status.textContent = 'Saved position was unavailable; using Chrome’s current position. Drag the title bar or edges to adjust.';
    }
    restoring = false; record(restored);
  } catch {
    if (status) status.textContent = 'Could not restore saved window bounds. Move or resize this window normally.';
  }
}
