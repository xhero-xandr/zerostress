// The plumbing the routes share (spec 007): answers in one shape, bodies read up to a limit, who is asking, the same-page
// check, and a per-address count of asks a minute. No route of its own lives here.

import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context } from 'hono';
import { errorText } from './text.ts';

export const MAX_BODY = 4096;
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function defaultClientIp(c: Context): string {
  let peer = '0.0.0.0';
  try { peer = getConnInfo(c).remote.address ?? peer; } catch { /* not a socket (a test) */ }
  // only our own proxy, on this machine, may say who the person is, and it sets X-Real-IP itself from an address it has
  // checked (deploy/zerostress-web.Caddyfile); a header that came from the outside is never read
  if (LOOPBACK.has(peer)) {
    const h = c.req.header('x-real-ip');
    if (h && h.length < 64 && /^[0-9a-fA-F:.]+$/.test(h)) return h;
  }
  return peer;
}

export const json = (c: Context, status: 200 | 202 | 400 | 403 | 404 | 409 | 413 | 415 | 429 | 500 | 503, body: unknown, headers: Record<string, string> = {}): Response =>
  c.json(body as object, status, { 'cache-control': 'no-store', ...headers });

export const fail = (c: Context, status: 400 | 403 | 404 | 413 | 415 | 429 | 500 | 503, code: string, headers: Record<string, string> = {}): Response =>
  json(c, status, { code, message: errorText(code) }, headers);

/** The body, read up to `max` bytes; null if it is longer (the rest is never read). */
export async function readCappedBytes(c: Context, max: number): Promise<Buffer | null> {
  const stream = c.req.raw.body;
  if (!stream) return Buffer.alloc(0);
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** the same page as the sender, when the browser says which page that is */
export function sameOrigin(c: Context): boolean {
  const origin = c.req.header('origin');
  if (origin === undefined) return true;
  try { return new URL(origin).host === c.req.header('host'); } catch { return false; }
}

/** A JSON object from a POST: the same page as the sender, the right type, a small body. Anything else is a plain refusal. */
export async function readJsonBody(c: Context): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; res: Response }> {
  if (!sameOrigin(c)) return { ok: false, res: fail(c, 403, 'forbidden') };
  if (!(c.req.header('content-type') ?? '').toLowerCase().startsWith('application/json')) return { ok: false, res: fail(c, 415, 'bad_request') };
  const declared = Number(c.req.header('content-length') ?? 0);
  if (declared > MAX_BODY) return { ok: false, res: fail(c, 413, 'bad_request') };
  // a body sent in chunks has no length to check first: it is read only up to the limit and then cut off
  const bytes = await readCappedBytes(c, MAX_BODY);
  if (bytes === null) return { ok: false, res: fail(c, 413, 'bad_request') };
  let body: unknown;
  try { body = JSON.parse(bytes.toString('utf8')); } catch { return { ok: false, res: fail(c, 400, 'bad_request') }; }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { ok: false, res: fail(c, 400, 'bad_request') };
  return { ok: true, body: body as Record<string, unknown> };
}

/** Counts asks a minute per address: true while the address is within `max`, and the ask is counted. */
export function askCounter(max: number): (who: string) => boolean {
  const asks = new Map<string, number[]>();
  return (who) => {
    const t = Date.now();
    const recent = (asks.get(who) ?? []).filter((x) => t - x < 60_000);
    if (recent.length >= max) return false;
    asks.set(who, [...recent, t]);
    if (asks.size > 10_000) asks.clear();
    return true;
  };
}
