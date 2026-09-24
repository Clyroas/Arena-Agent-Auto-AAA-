// Pure attachment rules shared by the panel UI and the page adapter.
// Files are only ever read from a user pick/paste/drop in this panel; no filesystem access.
// Dual format: an ESM module for the extension pages and a window global for the classic content script.
const ArenaAgentAttachments = (() => {
  'use strict';
  const ATTACHMENT_POLICY = Object.freeze({
    maxFiles: 4, maxBytes: 8 * 1024 * 1024,
    accept: '.png,.jpg,.jpeg,.webp,.gif,.pdf,.txt,.md,.csv,.html,.htm,.xml,.css,.js,.json',
    types: ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf', 'text/plain',
      'text/markdown', 'text/csv', 'text/html', 'application/xml', 'text/css', 'text/javascript',
      'application/javascript', 'application/json'],
  });
  const EXT = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
    pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', html: 'text/html',
    htm: 'text/html', xml: 'application/xml', css: 'text/css', js: 'text/javascript', json: 'application/json' };
  // Accept attributes may be extensions (.png), MIME types (image/png) or the generic 'file'.
  function isAcceptedToken(token) {
    const value = String(token).trim().toLowerCase();
    if (!value || value === 'file' || value === '*/*') return true;
    if (/^\.[a-z0-9]+$/.test(value)) return value.slice(1) in EXT;
    return ATTACHMENT_POLICY.types.includes(value);
  }
  function acceptAllows(accept) {
    const tokens = String(accept || '').split(/[,\s]+/).filter(Boolean);
    return tokens.every(isAcceptedToken);
  }
  function attachmentKind(name = '', type = '') {
    const ext = String(name).toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || '';
    if (EXT[ext]) return EXT[ext];
    const mime = String(type).toLowerCase();
    return ATTACHMENT_POLICY.types.includes(mime) ? mime : '';
  }
  function validateAttachments(files = []) {
    const accepted = [], rejected = [];
    for (const file of files) {
      const name = String(file.name || '').trim();
      const type = attachmentKind(name, file.type);
      if (!name || name.length > 240) { rejected.push({ name: name || 'Unnamed file', reason: 'The filename is missing or too long.' }); continue; }
      if (!type) { rejected.push({ name, reason: 'This type is not in the supported list.' }); continue; }
      if (!(Number(file.size) > 0)) { rejected.push({ name, reason: 'The file is empty.' }); continue; }
      if (file.size > ATTACHMENT_POLICY.maxBytes) { rejected.push({ name, reason: `The file is larger than ${Math.round(ATTACHMENT_POLICY.maxBytes / 1048576)} MB.` }); continue; }
      accepted.push({ name, type, size: Number(file.size) });
    }
    if (accepted.length > ATTACHMENT_POLICY.maxFiles) {
      for (const file of accepted.splice(ATTACHMENT_POLICY.maxFiles)) rejected.push({ name: file.name, reason: `Only ${ATTACHMENT_POLICY.maxFiles} files fit in one message.` });
    }
    return { accepted, rejected };
  }
  function bytesToBase64(bytes) {
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    return btoa(binary);
  }
  function base64ToBytes(text) {
    const binary = atob(String(text));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  function formatBytes(size) {
    const value = Number(size);
    if (!Number.isFinite(value) || value < 0) return 'unknown size';
    if (value < 1024) return `${value} B`;
    if (value < 1048576) return `${(value / 1024).toFixed(value < 10240 ? 1 : 0)} KB`;
    return `${(value / 1048576).toFixed(1)} MB`;
  }
  return { ATTACHMENT_POLICY, isAcceptedToken, acceptAllows, attachmentKind, validateAttachments, bytesToBase64, base64ToBytes, formatBytes };
})();
// The same text is imported as an ES module by the panel and injected as a classic script
// into the page, so no ESM syntax is allowed here; the panel reads the globals below.
globalThis.ArenaAgentAttachments = ArenaAgentAttachments;
