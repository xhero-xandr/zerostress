// The gate for addresses (spec 007, 3.3). It decides whether an address may be handed to a microVM at all.
//
// The host never opens the address and never resolves its name: that happens only in the guest, whose network is closed to
// the host and to internal ranges (spec 003). So this check is the first line, not the only one. A name that points to a
// private address, and redirects, are stopped by the guest's network.

export type GateReason = 'bad_url' | 'bad_scheme' | 'credentials' | 'bad_port' | 'bad_host' | 'private_address';

export type GateResult = { ok: true; url: string; host: string } | { ok: false; reason: GateReason };

export const MAX_URL_LENGTH = 2048;
export const ALLOWED_PORTS: readonly string[] = ['', '80', '443', '8080', '8443'];

const FORBIDDEN_SCHEME = /^(javascript|data|file|ftp|mailto|blob|about|view-source|vbscript|tel|sms|ws|wss|gopher):/i;
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
// controls, spaces and the invisible characters that make two addresses look alike
const FORBIDDEN_CHARS = /[\u0000- \u007f-\u009f­؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ]/u;
const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.localdomain', '.lan', '.home', '.corp', '.intranet', '.arpa'];

// [address, prefix length]
const V4_BLOCKED: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];

function v4ToInt(s: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  let n = 0;
  for (let i = 1; i <= 4; i++) {
    const p = Number(m[i]);
    if (p > 255) return null;
    n = n * 256 + p;
  }
  return n;
}

function v4Blocked(n: number): boolean {
  return V4_BLOCKED.some(([a, bits]) => {
    const base = v4ToInt(a)!;
    const size = 2 ** (32 - bits);
    return n >= base && n < base + size;
  });
}

/** The eight 16-bit groups of an IPv6 address as the URL parser writes it (hexadecimal, `::` allowed), or null. */
function v6Groups(s: string): number[] | null {
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (part === '') return [];
    const out: number[] = [];
    for (const g of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = parse(halves[0]!);
  if (head === null) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const tail = parse(halves[1]!);
  if (tail === null || head.length + tail.length > 7) return null;
  return [...head, ...new Array<number>(8 - head.length - tail.length).fill(0), ...tail];
}

/**
 * IPv6 is an allow-list: only global unicast (2000::/3) outside the ranges that carry an IPv4 address or are for
 * documentation. That excludes loopback, unspecified, unique-local, link-local, multicast, v4-mapped, NAT64 and the rest.
 * 6to4 and Teredo are refused whole, because their embedded IPv4 can be anything.
 */
function v6Allowed(g: number[]): boolean {
  const g0 = g[0]!;
  const g1 = g[1]!;
  if ((g0 & 0xe000) !== 0x2000) return false;
  if (g0 === 0x2002) return false;
  if (g0 === 0x2001 && (g1 === 0x0000 || g1 === 0x0db8)) return false;
  return true;
}

export function checkAddress(raw: unknown): GateResult {
  if (typeof raw !== 'string') return { ok: false, reason: 'bad_url' };
  const text = raw.trim();
  if (text === '' || text.length > MAX_URL_LENGTH) return { ok: false, reason: 'bad_url' };
  if (FORBIDDEN_CHARS.test(text)) return { ok: false, reason: 'bad_url' };
  if (FORBIDDEN_SCHEME.test(text)) return { ok: false, reason: 'bad_scheme' };

  let u: URL;
  try {
    u = new URL(HAS_SCHEME.test(text) ? text : `https://${text}`);
  } catch {
    return { ok: false, reason: 'bad_url' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, reason: 'bad_scheme' };
  if (u.username !== '' || u.password !== '') return { ok: false, reason: 'credentials' };
  if (!ALLOWED_PORTS.includes(u.port)) return { ok: false, reason: 'bad_port' };

  let host = u.hostname.toLowerCase();
  if (host.endsWith('.')) host = host.slice(0, -1);
  if (host === '') return { ok: false, reason: 'bad_host' };

  if (host.startsWith('[') && host.endsWith(']')) {
    const g = v6Groups(host.slice(1, -1));
    if (g === null) return { ok: false, reason: 'bad_host' };
    if (!v6Allowed(g)) return { ok: false, reason: 'private_address' };
  } else if (/^[\d.]+$/.test(host)) {
    // the URL parser has already written every numeric form (decimal, octal, hexadecimal, short) as four decimal parts
    const n = v4ToInt(host);
    if (n === null) return { ok: false, reason: 'bad_host' };
    if (v4Blocked(n)) return { ok: false, reason: 'private_address' };
  } else {
    if (host === 'localhost' || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) return { ok: false, reason: 'private_address' };
    if (!host.includes('.')) return { ok: false, reason: 'bad_host' };
  }

  // what we pass on is the parser's own normal form, never the text the person typed
  u.hash = '';
  return { ok: true, url: u.href, host };
}

/** Our sentence for each refusal. It never repeats the address. */
export const GATE_TEXT: Readonly<Record<GateReason, string>> = {
  bad_url: 'That does not look like a web address. Paste the whole link, for example https://example.com/page.',
  bad_scheme: 'Only links that start with http or https can be checked.',
  credentials: 'The link contains a user name or password. Remove them and try again.',
  bad_port: 'This port cannot be checked. Use an ordinary website address.',
  bad_host: 'The site name in the link could not be read.',
  private_address: 'This is an internal or service address. We never open those.',
};
