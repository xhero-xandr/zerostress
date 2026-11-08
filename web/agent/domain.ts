// Host helpers for the rules. There is no public-suffix list here (no outside data): the registrable part is the last
// two labels; three for the suffixes in TWO_PART and a country's usual second levels (com.et, co.th, org.ng); one more
// than the service for the hosting services in SHARED_HOSTS. Unusual suffixes are judged less exactly (spec 008, 3).

const TWO_PART = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'com.au', 'net.au', 'org.au', 'edu.au', 'co.nz', 'co.jp', 'ne.jp', 'or.jp',
  'co.in', 'net.in', 'org.in', 'com.br', 'net.br', 'com.cn', 'net.cn', 'org.cn', 'com.tr', 'com.mx', 'co.za', 'com.ar',
  'com.sg', 'com.hk', 'com.tw', 'co.kr', 'or.kr', 'com.ua', 'com.ru', 'co.id', 'co.il', 'com.pl', 'com.pt', 'com.es',
]);
const COUNTRY_SECOND = /^(?:com|net|org|co|gov|edu|ac|or|ne|go|mil|gob|nic|biz|info)\.[a-z]{2}$/;

/** Services where anyone gets a name of their own (alice.github.io, shop-x.vercel.app): each name is a site of its own,
 * and what is known about the service says nothing about it. */
export const SHARED_HOSTS: ReadonlySet<string> = new Set([
  'github.io', 'gitlab.io', 'vercel.app', 'now.sh', 'netlify.app', 'pages.dev', 'workers.dev', 'r2.dev', 'trycloudflare.com',
  'web.app', 'firebaseapp.com', 'appspot.com', 'herokuapp.com', 'onrender.com', 'fly.dev', 'railway.app', 'replit.app', 'repl.co',
  'glitch.me', 'surge.sh', 'azurewebsites.net', 'azurestaticapps.net', 'cloudfront.net', 'amplifyapp.com', 'blogspot.com',
  'wordpress.com', 'wixsite.com', 'weebly.com', 'weeblysite.com', 'webflow.io', 'framer.app', 'framer.website', 'gitbook.io',
  'notion.site', 'carrd.co', 'square.site', 'godaddysites.com', 'mystrikingly.com', 'tumblr.com', 'ngrok-free.app', 'ngrok.io',
  'ngrok.app', '000webhostapp.com', 'canva.site', 'my.canva.site', 'webcindario.com', 'meusitehostgator.com.br', 'site123.me',
  'jimdosite.com', 'myshopify.com', 'typedream.app', 'lovable.app', 'deno.dev', 'pythonanywhere.com', 'ipfs.io', 'dweb.link',
]);

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

export function isIpHost(host: string): boolean {
  return IPV4.test(host) || host.startsWith('[') || host.includes(':');
}

/** "login.paypal.co.uk" gives "paypal.co.uk", "x.alice.github.io" gives "alice.github.io"; an address stays as it is. */
export function registrable(host: string): string {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (isIpHost(h)) return h;
  const labels = h.split('.');
  for (let n = Math.min(3, labels.length - 1); n >= 2; n--) {
    if (SHARED_HOSTS.has(labels.slice(-n).join('.'))) return labels.slice(-n - 1).join('.');
  }
  if (labels.length <= 2) return h;
  const last2 = labels.slice(-2).join('.');
  return TWO_PART.has(last2) || COUNTRY_SECOND.test(last2) ? labels.slice(-3).join('.') : last2;
}

/** The first label of the registrable part: "login.paypal.co.uk" gives "paypal", "alice.github.io" gives "alice". */
export function sld(host: string): string {
  const r = registrable(host);
  return isIpHost(r) ? r : (r.split('.')[0] ?? '');
}

/** the address is a name of its own on a service where anyone gets one */
export function onSharedHost(host: string): boolean {
  const r = registrable(host);
  return [...SHARED_HOSTS].some((s) => r.endsWith(`.${s}`));
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
