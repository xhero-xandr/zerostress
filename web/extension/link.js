// The one thing the extension does: turn a link into the address of a check at ZeroStress. It never reads a page; the
// link is handed over in "/?u=", where the person still presses "Check" (web/client: linkFromQuery).
export const SERVICE = 'https://zerostress.space/';

/** The check page for a link, or null for anything that is not a web address (javascript:, data:, file:, ...). */
export function checkUrl(link, service = SERVICE) {
  let u;
  try { u = new URL(String(link).trim()); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.href.length > 2048) return null;
  // a link to the service itself needs no check
  if (u.origin === new URL(service).origin) return null;
  return `${service}?u=${encodeURIComponent(u.href)}`;
}
