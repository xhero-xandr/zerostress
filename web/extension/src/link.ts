// Which links the agent will take: web addresses only, never the service itself.
export const SERVICE = 'https://zerostress.space/';

/** The link as a web address worth checking, or null (javascript:, data:, file:, our own site, too long). */
export function webLink(link: unknown, service = SERVICE): string | null {
  let u: URL;
  try { u = new URL(String(link ?? '').trim()); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.href.length > 2048) return null;
  if (u.origin === new URL(service).origin) return null;
  return u.href;
}
