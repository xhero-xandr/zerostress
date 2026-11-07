// Who sent an email: what can be learnt about the sender's domain without opening anything (spec 012). Only the domain
// comes here, never the address or the email. The registry says how old it is; DNS says whether it publishes the mail
// policies an honest sender usually has (SPF, DMARC and its strength, MX); its name says whether it imitates a brand
// or is a free mailbox, where a "PayPal" in the sender's name means nothing.
import { resolveMx, resolveTxt } from 'node:dns/promises';
import { BRANDS } from '../agent/lists.ts';
import { registrable, skeleton, sld } from '../agent/domain.ts';
import type { DomainInfo } from '../agent/rdap.ts';

export interface SenderInfo {
  domain: string;
  age_days: number | null;
  created: string | null;
  /** the receiving servers are told what to do with mail that fails the checks: reject it, quarantine it, or nothing */
  dmarc: 'reject' | 'quarantine' | 'none' | null;
  spf: boolean;
  mx: boolean;
  /** the brand this domain belongs to, by its name (paypal.com), or null */
  brand: string | null;
  /** the brand this domain imitates (paypa1.com, paypal-secure.com), or null */
  lookalike: string | null;
  /** a free mailbox service: anyone can have an address there */
  freemail: boolean;
}

const FREEMAIL = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'yahoo.com', 'ymail.com', 'aol.com', 'icloud.com', 'me.com', 'mac.com', 'proton.me', 'protonmail.com', 'pm.me', 'gmx.com', 'gmx.net', 'gmx.de', 'web.de', 'mail.com', 'zoho.com', 'yandex.ru', 'yandex.com', 'ya.ru', 'mail.ru', 'bk.ru', 'inbox.ru', 'list.ru', 'rambler.ru', 'qq.com', '163.com', 'tutanota.com', 'tuta.io']);
export const DOMAIN = /^(?=.{3,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** the brand a domain's own name belongs to, and the brand it imitates */
export function brandOf(domain: string): { brand: string | null; lookalike: string | null } {
  const own = sld(domain);
  const name = (b: (typeof BRANDS)[number]) => b.words[0]!;
  const brand = BRANDS.find((b) => b.slds.includes(own));
  if (brand) return { brand: name(brand), lookalike: null };
  const shape = sld(skeleton(domain));
  const parts = own.split(/[-_.]/).filter(Boolean);
  const imitated = BRANDS.find((b) => b.slds.includes(shape) || (b.slds[0]!.length >= 4 && parts.length > 1 && parts.some((p) => b.slds.includes(p))) || b.slds.some((s) => s.length >= 5 && own !== s && near(own, s)));
  return { brand: null, lookalike: imitated ? name(imitated) : null };
}

/** one letter changed, added or dropped (paypall, paypl, paypa1 after its skeleton) */
function near(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return a.slice(i + 1) === b.slice(i + 1) || a.slice(i) === b.slice(i + 1) || a.slice(i + 1) === b.slice(i);
}

export interface SenderDeps {
  rdap?: (host: string) => Promise<DomainInfo | null>;
  txt?: (name: string) => Promise<string[][]>;
  mx?: (name: string) => Promise<unknown[]>;
  timeoutMs?: number;
}

export function createSenderCheck(deps: SenderDeps = {}) {
  const txt = deps.txt ?? resolveTxt;
  const mx = deps.mx ?? resolveMx;
  const limit = deps.timeoutMs ?? 5000;
  const within = <T,>(p: Promise<T>, fallback: T): Promise<T> =>
    Promise.race([p.catch(() => fallback), new Promise<T>((r) => setTimeout(() => r(fallback), limit).unref())]);
  const cache = new Map<string, { at: number; info: Promise<SenderInfo> }>();

  async function look(domain: string): Promise<SenderInfo> {
    const reg = registrable(domain);
    const [whois, own, dmarcTxt, mxs] = await Promise.all([
      deps.rdap ? within(deps.rdap(reg), null) : Promise.resolve(null),
      within(txt(domain), [] as string[][]),
      within(txt(`_dmarc.${domain}`).then((r) => (r.length ? r : txt(`_dmarc.${reg}`))), [] as string[][]),
      within(mx(domain), [] as unknown[]),
    ]);
    const flat = (r: string[][]) => r.map((x) => x.join('')).map((x) => x.trim());
    const dm = flat(dmarcTxt).find((x) => /^v=DMARC1\b/i.test(x));
    const p = dm ? /(?:^|;)\s*p\s*=\s*(reject|quarantine|none)\b/i.exec(dm)?.[1]?.toLowerCase() : undefined;
    return {
      domain,
      age_days: whois?.age_days ?? null,
      created: whois?.created ?? null,
      dmarc: (p as SenderInfo['dmarc']) ?? null,
      spf: flat(own).some((x) => /^v=spf1\b/i.test(x)),
      mx: mxs.length > 0,
      ...brandOf(reg),
      freemail: FREEMAIL.has(reg),
    };
  }

  return (domain: string): Promise<SenderInfo> => {
    const now = Date.now();
    const hit = cache.get(domain);
    if (hit && now - hit.at < 3_600_000) return hit.info;
    const info = look(domain);
    cache.set(domain, { at: now, info });
    if (cache.size > 2000) cache.delete(cache.keys().next().value!);
    return info;
  };
}
