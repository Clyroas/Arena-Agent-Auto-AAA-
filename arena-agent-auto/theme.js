// Appearance only. Theme is stored separately from text/color preferences and window bounds; no chat/account data is stored.
(() => {
  'use strict';
  const KEY = 'arenaAgentTheme';
  const normalise = value => ['light', 'dark', 'system'].includes(value) ? value : 'system';
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  let preference = 'system';
  try { preference = normalise(localStorage.getItem(KEY)); } catch { /* use system if storage is unavailable */ }
  let control = null, status = null;
  function apply() {
    const resolved = preference === 'system' ? (media.matches ? 'dark' : 'light') : preference;
    document.documentElement.dataset.theme = resolved;
    document.documentElement.dataset.themePreference = preference;
    if (control) control.value = preference;
  }
  // Runs in the head before the panel is painted to avoid a light flash in dark mode.
  apply();
  media.addEventListener('change', () => { if (preference === 'system') apply(); });
  window.addEventListener('storage', event => {
    if (event.key === KEY || event.key === null) {
      preference = normalise(event.newValue); apply();
    }
  });
  function bind() {
    control = document.getElementById('theme-select');
    status = document.getElementById('theme-status');
    if (!control) return;
    apply();
    control.addEventListener('change', () => {
      preference = normalise(control.value); apply();
      try {
        localStorage.setItem(KEY, preference);
        if (status) { status.textContent = `${preference === 'system' ? 'System' : preference === 'dark' ? 'Dark' : 'Light'} theme selected.`; status.className = 'sr-only'; }
      } catch {
        if (status) { status.textContent = 'Theme applied for this panel, but Chrome could not save the preference.'; status.className = 'hint theme-save-error'; }
      }
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind, { once: true });
  else bind();
})();
