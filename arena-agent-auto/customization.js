// Persist only whitelisted appearance choices, never message or account data.
(() => {
  'use strict';
  const KEY = 'arenaAgentAppearance';
  const defaults = { fontSize: 14, accent: 'blue' };
  const normalize = value => ({
    fontSize: [12, 13, 14, 16, 18].includes(value?.fontSize) ? value.fontSize : defaults.fontSize,
    accent: ['green', 'blue', 'violet', 'amber'].includes(value?.accent) ? value.accent : defaults.accent
  });
  let prefs;
  try { prefs = normalize(JSON.parse(localStorage.getItem(KEY))); } catch { prefs = { ...defaults }; }
  let font, accent, status;
  function apply() {
    document.documentElement.style.setProperty('--chat-font-size', `${prefs.fontSize}px`);
    document.documentElement.dataset.accent = prefs.accent;
    if (font) font.value = String(prefs.fontSize);
    if (accent) accent.value = prefs.accent;
  }
  function save() {
    apply();
    try { localStorage.setItem(KEY, JSON.stringify(prefs)); status.textContent = 'Text size and accent saved. Chat is not saved.'; }
    catch { status.textContent = 'Appearance applied, but Chrome could not save it.'; }
  }
  apply();
  window.addEventListener('storage', event => {
    if (event.key !== KEY && event.key !== null) return;
    try { prefs = normalize(JSON.parse(event.newValue)); } catch { prefs = { ...defaults }; }
    apply();
  });
  function bind() {
    font = document.getElementById('font-size'); accent = document.getElementById('accent-color'); status = document.getElementById('appearance-status');
    if (!font || !accent || !status) return;
    apply();
    font.addEventListener('change', () => { prefs = normalize({ ...prefs, fontSize: Number(font.value) }); save(); });
    accent.addEventListener('change', () => { prefs = normalize({ ...prefs, accent: accent.value }); save(); });
    document.getElementById('reset-appearance').addEventListener('click', () => { prefs = { ...defaults }; save(); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind, { once: true });
  else bind();
})();
