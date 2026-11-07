// What others already know about an address, asked without opening it: Google Safe Browsing (is the URL on Google's
// lists), Spamhaus DBL (is the domain listed for phishing, malware, spam), VirusTotal (do antivirus engines flag the
// domain). Each only adds to what we saw ourselves: a listing may raise the verdict, a clean record never lowers it
// (docs/containment.md, rule 8). Thin fetch and DNS clients, a deadline on every call, only the fields we use read.
// The keys live in config/web.env and only ever travel in a header, a query string to Google, or a DNS name to Spamhaus.
import { resolve4 } from 'node:dns/promises';
import { registrable } from './domain.ts';

export interface Reputation {
  /** Google's threat types for the address or where it led; [] when Google knows nothing bad; null when not asked */
  google: string[] | null;
  /** why Spamhaus lists the domain (phish, malware, botnet, spam; "abused_" when a legitimate site was abused), "clean", or null */
  spamhaus: string | null;
  /** how many antivirus engines call the domain malicious or suspicious, of how many; null when not asked */
  virustotal: { malicious: number; suspicious: number; total: number } | null;
  /** urlscan.io's verdict on the latest scan of the domain anyone made there; null when there is none or not asked */
  urlscan?: { malicious: boolean; scanned_at: string } | null;
}

export interface ReputationKeys { safeBrowsing?: string; virustotal?: string; spamhausDqs?: string; urlscan?: string }
export interface ReputationDeps {
  fetch?: typeof fetch;
  resolve4?: (name: string) => Promise<string[]>;
  now?: () => number;
  timeoutMs?: number;
  /** VirusTotal's free key allows four lookups a minute: beyond that the domain is simply not asked */
  vtPerMinute?: number;
}

const DBL: Record<string, string> = {
  '127.0.1.2': 'spam', '127.0.1.4': 'phish', '127.0.1.5': 'malware', '127.0.1.6': 'botnet',
  '127.0.1.102': 'abused_spam', '127.0.1.103': 'abused_redirector', '127.0.1.104': 'abused_phish', '127.0.1.105': 'abused_malware', '127.0.1.106': 'abused_botnet',
};
const THREATS = new Set(['MALWARE', 'SOCIAL_ENGINEERING', 'UNWANTED_SOFTWARE', 'POTENTIALLY_HARMFUL_APPLICATION']);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const count = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 10_000 ? v : 0);

export function createReputation(keys: ReputationKeys, deps: ReputationDeps = {}) {
  const f = deps.fetch ?? fetch;
  const dns = deps.resolve4 ?? resolve4;
  const now = deps.now ?? Date.now;
  const limit = deps.timeoutMs ?? 6000;
  const vtPerMinute = deps.vtPerMinute ?? 4;
  const vtTimes: number[] = [];
  const cache = new Map<string, { at: number; value: Promise<unknown> }>();
  const memo = <T,>(key: string, ttlMs: number, make: () => Promise<T>): Promise<T> => {
    const hit = cache.get(key);
    if (hit && now() - hit.at < ttlMs) return hit.value as Promise<T>;
    const value = make();
    cache.set(key, { at: now(), value });
    // a failed or skipped lookup is not remembered: the next check asks again
    void value.then((v) => { if (v === null) cache.delete(key); }, () => cache.delete(key));
    if (cache.size > 5000) cache.delete(cache.keys().next().value!);
    return value;
  };
  const within = <T,>(p: Promise<T>, fallback: T): Promise<T> =>
    Promise.race([p.catch(() => fallback), new Promise<T>((r) => setTimeout(() => r(fallback), limit).unref())]);

  async function google(urls: string[]): Promise<string[] | null> {
    if (!keys.safeBrowsing || urls.length === 0) return null;
    const res = await f(`https://safebrowsing.googleapis.com/v4/threatMatches:find?key=${encodeURIComponent(keys.safeBrowsing)}`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(limit), headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client: { clientId: 'zerostress', clientVersion: '0.9' }, threatInfo: { threatTypes: [...THREATS], platformTypes: ['ANY_PLATFORM'], threatEntryTypes: ['URL'], threatEntries: urls.slice(0, 20).map((url) => ({ url })) } }),
    });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    const matches = isObj(body) && Array.isArray(body.matches) ? body.matches : [];
    return [...new Set(matches.filter(isObj).map((m) => m.threatType).filter((t): t is string => typeof t === 'string' && THREATS.has(t)))];
  }

  async function spamhaus(domain: string): Promise<string | null> {
    if (!keys.spamhausDqs || !/^[a-z0-9.-]{3,253}$/.test(domain)) return null;
    try {
      const answers = await dns(`${domain}.${keys.spamhausDqs}.dbl.dq.spamhaus.net`);
      // 127.255.255.x is Spamhaus saying the query itself was wrong: that is "not known", not "clean"
      if (answers.some((a) => a.startsWith('127.255.255.'))) return null;
      return answers.map((a) => DBL[a]).find(Boolean) ?? null;
    } catch (e) {
      const code = (e as { code?: string }).code;
      return code === 'ENOTFOUND' || code === 'ENODATA' ? 'clean' : null;
    }
  }

  async function virustotal(domain: string): Promise<Reputation['virustotal']> {
    if (!keys.virustotal) return null;
    const t = now();
    while (vtTimes.length && t - vtTimes[0]! > 60_000) vtTimes.shift();
    if (vtTimes.length >= vtPerMinute) return null;
    vtTimes.push(t);
    const res = await f(`https://www.virustotal.com/api/v3/domains/${encodeURIComponent(domain)}`, { headers: { 'x-apikey': keys.virustotal }, redirect: 'error', signal: AbortSignal.timeout(limit) });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    const stats = isObj(body) && isObj(body.data) && isObj(body.data.attributes) && isObj(body.data.attributes.last_analysis_stats) ? body.data.attributes.last_analysis_stats : null;
    if (!stats) return null;
    const total = Object.values(stats).reduce<number>((s, v) => s + count(v), 0);
    return { malicious: count(stats.malicious), suspicious: count(stats.suspicious), total };
  }

  async function urlscan(domain: string): Promise<Reputation['urlscan']> {
    if (!keys.urlscan || !/^[a-z0-9.-]{3,253}$/.test(domain)) return null;
    const h = { 'api-key': keys.urlscan };
    const found = await f(`https://urlscan.io/api/v1/search/?q=${encodeURIComponent(`page.domain:"${domain}"`)}&size=1`, { headers: h, redirect: 'error', signal: AbortSignal.timeout(limit) });
    if (!found.ok) return null;
    const list: unknown = await found.json();
    const id = isObj(list) && Array.isArray(list.results) && isObj(list.results[0]) ? list.results[0]._id : null;
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) return null;
    const res = await f(`https://urlscan.io/api/v1/result/${id}/`, { headers: h, redirect: 'error', signal: AbortSignal.timeout(limit) });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    const v = isObj(body) && isObj(body.verdicts) && isObj(body.verdicts.overall) ? body.verdicts.overall : null;
    const at = isObj(body) && isObj(body.task) && typeof body.task.time === 'string' && !Number.isNaN(Date.parse(body.task.time)) ? new Date(body.task.time).toISOString() : '';
    return v && typeof v.malicious === 'boolean' ? { malicious: v.malicious, scanned_at: at } : null;
  }

  return {
    enabled: Boolean(keys.safeBrowsing || keys.virustotal || keys.spamhausDqs || keys.urlscan),
    /** an address (and where it led) and its site's domain */
    async check(urls: string[], host: string): Promise<Reputation> {
      const domain = registrable(host.toLowerCase());
      const list = [...new Set(urls.filter((u) => /^https?:\/\//i.test(u)))];
      const [g, s, v, u] = await Promise.all([
        within(memo(`g:${list.join(' ')}`, 30 * 60_000, () => google(list)), null),
        domain ? within(memo(`s:${domain}`, 60 * 60_000, () => spamhaus(domain)), null) : Promise.resolve(null),
        domain ? within(memo(`v:${domain}`, 6 * 3_600_000, () => virustotal(domain)), null) : Promise.resolve(null),
        domain ? within(memo(`u:${domain}`, 3_600_000, () => urlscan(domain)), null) : Promise.resolve(null),
      ]);
      return { google: g, spamhaus: s, virustotal: v, urlscan: u };
    },
  };
}
export type ReputationClient = ReturnType<typeof createReputation>;
