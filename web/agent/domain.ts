// Host helpers for the rules. There is no public-suffix list here (no outside data): the registrable part is the last
// two labels, three for the suffixes in TWO_PART. Unusual suffixes are therefore judged less exactly (spec 008, 3).

const TWO_PART = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'com.au', 'net.au', 'org.au', 'edu.au', 'co.nz', 'co.jp', 'ne.jp', 'or.jp',
  'co.in', 'net.in', 'org.in', 'com.br', 'net.br', 'com.cn', 'net.cn', 'org.cn', 'com.tr', 'com.mx', 'co.za', 'com.ar',
  'com.sg', 'com.hk', 'com.tw', 'co.kr', 'or.kr', 'com.ua', 'com.ru', 'co.id', 'co.il', 'com.pl', 'com.pt', 'com.es',
]);

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

export function isIpHost(host: string): boolean {
  return IPV4.test(host) || host.startsWith('[') || host.includes(':');
}

/** "login.paypal.co.uk" gives "paypal.co.uk"; an address stays as it is. */
export function registrable(host: string): string {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (isIpHost(h)) return h;
  const labels = h.split('.');
  if (labels.length <= 2) return h;
  const last2 = labels.slice(-2).join('.');
  return TWO_PART.has(last2) ? labels.slice(-3).join('.') : last2;
}

/** The label in front of the suffix: "login.paypal.co.uk" gives "paypal". */
export function sld(host: string): string {
  const r = registrable(host);
  if (isIpHost(r)) return r;
  const labels = r.split('.');
  return TWO_PART.has(labels.slice(-2).join('.')) ? (labels.at(-3) ?? '') : (labels.at(-2) ?? labels[0] ?? '');
}

export function parseUrl(raw: unknown): URL | null {
  if (typeof raw !== 'string' || raw.length > 4096) return null;
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/** Latin together with Cyrillic or Greek letters in one name: the mark of a lookalike. */
export function mixedScripts(host: string): boolean {
  for (const label of host.split('.')) {
    const latin = /\p{Script=Latin}/u.test(label);
    const other = /[\p{Script=Cyrillic}\p{Script=Greek}]/u.test(label);
    if (latin && other) return true;
  }
  return false;
}

// Cyrillic and Greek letters that look like Latin ones, for reading a name as the eye does
const LOOKS_LIKE: Record<string, string> = {
  а: 'a', в: 'b', е: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x', і: 'i', ј: 'j', ѕ: 's',
  ӏ: 'l', ԁ: 'd', ԛ: 'q', ԝ: 'w', ο: 'o', α: 'a', ν: 'v', ρ: 'p', ι: 'i', κ: 'k', ε: 'e', τ: 't', υ: 'u',
};

/** The name with look-alike letters replaced by the Latin ones they imitate. */
export function skeleton(host: string): string {
  return [...host.toLowerCase()].map((c) => LOOKS_LIKE[c] ?? c).join('');
}
