// Main-world helper: runs once per explicit Send that carries user-staged files.
// Self-contained by design (chrome.scripting serializes only this function). It reads nothing from the
// page except the marker attribute we set, touches only our own staged bytes, and returns only our own
// file metadata. No page variables, storage, cookies or credentials are ever read or returned.
export async function arenaAgentStageFiles(request) {
  'use strict';
  const fail = reason => ({ ok: false, reason });
  try {
    const token = String(request?.token || '');
    const files = Array.isArray(request?.files) ? request.files : null;
    if (!/^[0-9a-f-]{36}$/.test(token) || !files?.length || files.length > 4) return fail('The staging request was malformed.');
    const allowed = ['png','jpg','jpeg','webp','gif','pdf','txt','md','csv','html','htm','xml','css','js','json'];
    const mimes = ['image/png','image/jpeg','image/webp','image/gif','application/pdf','text/plain','text/markdown','text/csv','text/html','application/xml','text/css','text/javascript','application/javascript','application/json'];
    const matches = [...document.querySelectorAll(`input[type="file"][data-arena-agent-stage="${CSS.escape ? CSS.escape(token) : token}"]`)];
    if (matches.length !== 1) return fail('The staged file input was replaced or duplicated in the page.');
    const input = matches[0];
    if (input.disabled || input.closest('[inert]')) return fail('The page file input is unavailable.');
    if (files.length > 1 && !input.multiple) return fail('The page file input accepts only one file.');
    if (input.accept) {
      const tokens = String(input.accept).split(/[,\s]+/).filter(Boolean);
      const ok = tokens.every(token => token === 'file' || token === '*/*' || (/^\.[a-z0-9]+$/.test(token) ? allowed.includes(token.slice(1)) : mimes.includes(token.toLowerCase())));
      if (!ok) return fail('The page file input restricts file types that do not match the staged files.');
    }
    const decode = text => { const binary = atob(String(text)); const bytes = new Uint8Array(binary.length); for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i); return bytes; };
    const transfer = new DataTransfer();
    const staged = [];
    for (const item of files) {
      const name = String(item?.name || ''), type = String(item?.type || '');
      const bytes = decode(item?.data || '');
      if (!name || bytes.byteLength === 0 || bytes.byteLength > 8 * 1024 * 1024) return fail('A staged file was empty or too large.');
      transfer.items.add(new File([bytes], name, { type }));
      staged.push({ name, type, size: bytes.byteLength });
    }
    try { Object.defineProperty(input, 'files', { configurable: true, value: transfer.files }); }
    catch { return fail('This browser did not allow the page file input to be filled.'); }
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    const seen = [...(input.files || [])].map(file => ({ name: file.name, size: file.size, type: file.type }));
    if (seen.length !== staged.length || staged.some((file, index) => seen[index]?.name !== file.name || seen[index]?.size !== file.size))
      return fail('The page file input did not report the staged files.');
    return { ok: true, files: seen };
  } catch { return fail('The file staging step failed in the page.'); }
}
