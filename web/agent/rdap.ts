// When a domain was registered, from the registry's public RDAP service. Only the registrable domain name is sent
// (never the full address, path or anything from the page), first to IANA's bootstrap file to learn which registry is
// responsible, then to that registry. The host never contacts the checked site itself. A failure or a slow answer
// simply means "age unknown": it is never a reason for a verdict.

import { domainToASCII } from 'node:url';
import { isObj } from './guard.ts';

export interface DomainInfo {
  /** the name that was asked about, as sent */
  domain: string;
  /** ISO date of registration, or null if the registry did not say */
  created: string | null;
  /** whole days since registration at the moment of the lookup */
  age_days: number | null;
  /** the registrar's name as the registry reports it: text from outside, treat as untrusted */
  registrar: string | null;
}

export type Fetcher = (url: string, init: { signal: AbortSignal; headers: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const BOOTSTRAP = 'https://data.iana.org/rdap/dns.json';
const DAY = 86_400_000;
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** A name fit to put in a request path: ASCII letters, digits and hyphens in at least two labels; never an address. */
export function rdapName(host: string): string | null {
  if (/[\s/\\:@?#%[\]]/.test(host)) return null; // domainToASCII quietly drops what follows such a character
  const ascii = domainToASCII(host.toLowerCase().replace(/\.$/, ''));
  if (ascii === '' || ascii.length > 253) return null;
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/.test(ascii)) return null;
  if (/^[0-9.]+$/.test(ascii)) return null; // an IPv4 address
  return ascii;
}

function safeBase(u: unknown): string | null {
  if (typeof u !== 'string') return null;
  try {
    const url = new URL(u);
    if (url.protocol !== 'https:' || url.username || url.password || /^[0-9.]+$|^\[/.test(url.hostname)) return null;
    return u.endsWith('/') ? u : `${u}/`;
  } catch {
    return null;
  }
}

export function createRdap(opts: { fetcher?: Fetcher; now?: () => number; timeoutMs?: number } = {}): (host: string) => Promise<DomainInfo | null> {
  const fetcher: Fetcher = opts.fetcher ?? ((url, init) => fetch(url, init));
  const now = opts.now ?? Date.now;
  const timeoutMs = opts.timeoutMs ?? 4000;
  let bootstrap: { at: number; byTld: Map<string, string> } | null = null;
  const memo = new Map<string, { at: number; info: DomainInfo | null }>();

  const get = async (url: string): Promise<unknown> => {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const r = await fetcher(url, { signal: ac.signal, headers: { accept: 'application/rdap+json, application/json' } });
      return r.ok ? await r.json() : null;
    } finally {
      clearTimeout(t);
    }
  };

  const baseFor = async (tld: string): Promise<string | null> => {
    if (!bootstrap || now() - bootstrap.at > DAY) {
      const doc = await get(BOOTSTRAP);
      const byTld = new Map<string, string>();
      for (const svc of arr(isObj(doc) ? doc.services : null)) {
        const [tlds, urls] = arr(svc).length === 2 ? (svc as [unknown, unknown]) : [null, null];
        const base = arr(urls).map(safeBase).find((b) => b !== null) ?? null;
        if (base !== null) for (const t of arr(tlds)) if (typeof t === 'string') byTld.set(t.toLowerCase(), base);
      }
      if (byTld.size === 0) return null;
      bootstrap = { at: now(), byTld };
    }
    return bootstrap.byTld.get(tld) ?? null;
  };

  const lookup = async (name: string): Promise<DomainInfo | null> => {
    const base = await baseFor(name.slice(name.lastIndexOf('.') + 1));
    if (base === null) return null;
    const doc = await get(`${base}domain/${name}`);
    if (!isObj(doc)) return null;
    const reg = arr(doc.events).filter(isObj).find((e) => e.eventAction === 'registration');
    const when = typeof reg?.eventDate === 'string' ? Date.parse(reg.eventDate) : NaN;
    const created = Number.isFinite(when) && when <= now() ? new Date(when).toISOString() : null;
    let registrar: string | null = null;
    for (const ent of arr(doc.entities).filter(isObj)) {
      if (!arr(ent.roles).includes('registrar')) continue;
      const card = arr(ent.vcardArray)[1];
      const fn = arr(card).find((p): p is unknown[] => Array.isArray(p) && p[0] === 'fn');
      if (typeof fn?.[3] === 'string' && fn[3] !== '') { registrar = fn[3].slice(0, 80); break; }
    }
    return { domain: name, created, age_days: created === null ? null : Math.floor((now() - Date.parse(created)) / DAY), registrar };
  };

  return async (host) => {
    const name = rdapName(host);
    if (name === null) return null;
    const hit = memo.get(name);
    if (hit && now() - hit.at < DAY) return hit.info;
    let info: DomainInfo | null = null;
    try {
      info = await lookup(name);
    } catch {
      return null; // not remembered: the next task may succeed
    }
    if (memo.size > 500) memo.clear();
    memo.set(name, { at: now(), info });
    return info;
  };
}
