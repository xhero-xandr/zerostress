// Cloudflare's URL Scanner as a second opinion on pages the sandbox could not read (a bot wall): Cloudflare opens the
// page in its own browser, on its own servers, as a verified bot. A thin fetch client like model.ts: one fixed host,
// a deadline on every call, no redirects, and only the fields we use are read, each checked for its shape.
//
// Privacy first: a scan on the free plan is public at Cloudflare, so we look for a recent public scan of exactly this
// address before anything else, and send a new one only when the person said yes to publishing it.

import type { ScannerConfig } from './config.ts';
import { parseUrl } from './domain.ts';

const API = 'https://api.cloudflare.com/client/v4/accounts';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const MAX_SHOT = 4 * 1024 * 1024;
const MAX_JSON = 8 * 1024 * 1024;

export interface ScanOpinion {
  uuid: string;
  /** found: someone's recent public scan of this very address; submitted: a new public scan we sent with consent */
  source: 'found' | 'submitted';
  /** when Cloudflare scanned it, ISO */
  scanned_at: string;
  /** where Cloudflare's browser ended up (from the page: untrusted) */
  final_url: string;
  status: number | null;
  /** the page's title as Cloudflare saw it (from the page: untrusted) */
  title: string;
  /** Cloudflare's own verdict; null when it gave none */
  malicious: boolean | null;
}

export type ScanOutcome =
  | { ok: true; opinion: ScanOpinion; screenshot: Uint8Array | null }
  | { ok: false; reason: 'not_found' | 'needs_consent' | 'refused' | 'unavailable' | 'quota' }
  /** still scanning; `submitted` is the scan we sent, to be polled on the next ask instead of sending another */
  | { ok: false; reason: 'pending'; submitted?: string };

export interface UrlScanDeps {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** how long a new scan may take before we give up (Cloudflare suggests polling every 10-30 s) */
  waitMs?: number;
  pollMs?: number;
  /** how old a found scan may be */
  maxAgeDays?: number;
  /** new public scans the whole service may send per day (UTC): each is published under our account */
  maxScansPerDay?: number;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const cut = (v: unknown, n: number): string => (typeof v === 'string' ? v.slice(0, n) : '');

/** The search value for one address, quoted; an address with a quote or a backslash is not searched at all. */
export function searchFor(url: string): string | null {
  if (/["\\\s]/.test(url) || url.length > 2048) return null;
  return `task.url:"${url}"`;
}

export function createUrlScanClient(cfg: ScannerConfig, deps: UrlScanDeps = {}) {
  const f = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const waitMs = deps.waitMs ?? 75_000;
  const pollMs = deps.pollMs ?? 10_000;
  const maxAge = (deps.maxAgeDays ?? 30) * 86_400_000;
  const maxScans = deps.maxScansPerDay ?? 50;
  let scans = { day: '', count: 0 };
  const base = `${API}/${cfg.accountId}/urlscanner/v2`;
  const auth = { authorization: `Bearer ${cfg.token}` };

  async function call(path: string, init: RequestInit = {}, ms = 15_000): Promise<Response | null> {
    try {
      return await f(`${base}${path}`, { ...init, headers: { ...auth, ...(init.headers ?? {}) }, redirect: 'error', signal: AbortSignal.timeout(ms) });
    } catch {
      return null;
    }
  }
  async function json(res: Response): Promise<unknown> {
    const len = Number(res.headers.get('content-length') ?? 0);
    if (len > MAX_JSON) return null;
    const text = await res.text().catch(() => '');
    if (text.length > MAX_JSON) return null;
    try { return JSON.parse(text); } catch { return null; }
  }

  /** The most recent finished public scan of exactly this address, not older than maxAgeDays. */
  async function find(url: string): Promise<{ uuid: string; time: string } | null> {
    const q = searchFor(url);
    if (!q) return null;
    const res = await call(`/search?q=${encodeURIComponent(q)}&size=10`);
    if (!res?.ok) return null;
    const body = await json(res);
    const hits = (isObj(body) && Array.isArray(body.results) ? body.results : []).filter(isObj).map((x) => (isObj(x.task) ? x.task : {}));
    const fresh = hits
      .filter((t) => t.url === url && typeof t.uuid === 'string' && UUID.test(t.uuid) && t.success !== false && typeof t.time === 'string' && now() - Date.parse(t.time) < maxAge)
      .sort((a, b) => String(b.time).localeCompare(String(a.time)));
    return fresh[0] ? { uuid: fresh[0].uuid as string, time: fresh[0].time as string } : null;
  }

  /** A finished scan's fields we use, or null while it is not finished (Cloudflare answers 404 then). */
  async function read(uuid: string, source: ScanOpinion['source']): Promise<ScanOpinion | null> {
    const res = await call(`/result/${uuid}`);
    if (!res?.ok) return null;
    const r = await json(res);
    if (!isObj(r)) return null;
    const page = isObj(r.page) ? r.page : {};
    const task = isObj(r.task) ? r.task : {};
    const overall = isObj(r.verdicts) && isObj(r.verdicts.overall) ? r.verdicts.overall : {};
    const status = Number(page.status);
    const final = parseUrl(page.url);
    return {
      uuid,
      source,
      scanned_at: typeof task.time === 'string' && !Number.isNaN(Date.parse(task.time)) ? new Date(task.time).toISOString() : new Date(now()).toISOString(),
      final_url: final && /^https?:$/.test(final.protocol) ? cut(final.href, 2048) : '',
      status: Number.isInteger(status) && status >= 100 && status < 600 ? status : null,
      title: cut(page.title, 200),
      malicious: typeof overall.malicious === 'boolean' ? overall.malicious : null,
    };
  }

  async function screenshot(uuid: string): Promise<Uint8Array | null> {
    const res = await call(`/screenshots/${uuid}.png?resolution=desktop`, {}, 20_000);
    if (!res?.ok || Number(res.headers.get('content-length') ?? 0) > MAX_SHOT) return null;
    const buf = new Uint8Array(await res.arrayBuffer().catch(() => new ArrayBuffer(0)));
    return buf.length >= 8 && buf.length <= MAX_SHOT && PNG.every((x, i) => buf[i] === x) ? buf : null;
  }

  async function finish(uuid: string, source: ScanOpinion['source']): Promise<ScanOutcome> {
    const opinion = await read(uuid, source);
    if (!opinion) return { ok: false, reason: 'pending' };
    return { ok: true, opinion, screenshot: await screenshot(uuid) };
  }

  /** Polls a scan we sent until it is finished or the wait is over. */
  async function waitFor(uuid: string): Promise<ScanOutcome> {
    const until = now() + waitMs;
    while (now() < until) {
      await sleep(pollMs);
      const done = await finish(uuid, 'submitted');
      if (done.ok) return done;
    }
    return { ok: false, reason: 'pending', submitted: uuid };
  }

  return {
    /**
     * A second opinion on one address. Without `publish` only a recent public scan of this exact address is used;
     * with it, a new public scan is sent when none is found, and waited for. `submitted` is a scan sent on an earlier
     * ask that was still running: it is polled, and nothing new is sent.
     */
    async opinion(url: string, publish: boolean, submitted?: string): Promise<ScanOutcome> {
      if (!cfg.enabled) return { ok: false, reason: 'unavailable' };
      if (submitted !== undefined) return UUID.test(submitted) ? waitFor(submitted) : { ok: false, reason: 'unavailable' };
      const found = await find(url);
      if (found) return finish(found.uuid, 'found');
      if (!publish) return { ok: false, reason: 'needs_consent' };
      if (!searchFor(url)) return { ok: false, reason: 'refused' };
      const day = new Date(now()).toISOString().slice(0, 10);
      if (scans.day !== day) scans = { day, count: 0 };
      if (scans.count >= maxScans) return { ok: false, reason: 'quota' };
      scans.count++;
      const res = await call('/scan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url, screenshotsResolutions: ['desktop'] }) });
      if (!res) return { ok: false, reason: 'unavailable' };
      if (res.status === 409) {
        // scanned a moment ago by someone: that scan is the answer, once it shows up in the search
        await sleep(pollMs);
        const again = await find(url);
        return again ? finish(again.uuid, 'found') : { ok: false, reason: 'pending' };
      }
      const body = await json(res);
      const uuid = isObj(body) && typeof body.uuid === 'string' && UUID.test(body.uuid) ? body.uuid : null;
      if (!res.ok || !uuid) return { ok: false, reason: res.status === 400 || res.status === 422 ? 'refused' : 'unavailable' };
      return waitFor(uuid);
    },
  };
}

export type UrlScanClient = ReturnType<typeof createUrlScanClient>;
