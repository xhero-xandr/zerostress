// Country and network (ASN) of an IPv4 address, from the DB-IP Lite files kept on the host (CC BY 4.0, attribution
// "IP Geolocation by DB-IP" is shown in the report). Nothing leaves the machine at lookup time: the tables are read once
// at start. IPv6 is not covered: the sandbox network is IPv4 and an unknown address simply gets no country.

import { gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';

export interface GeoInfo {
  /** two capital letters, or null when the database does not know */
  country: string | null;
  asn: number | null;
  /** the network owner as registered; set by whoever owns the network, so treat as untrusted text */
  org: string | null;
}

export type GeoLookup = (ip: string) => GeoInfo;

const V4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

export function ipv4ToInt(ip: string): number | null {
  const m = V4.exec(ip);
  if (!m) return null;
  let n = 0;
  for (let i = 1; i <= 4; i++) {
    const part = Number(m[i]);
    if (part > 255) return null;
    n = n * 256 + part;
  }
  return n;
}

interface Table {
  starts: Float64Array;
  ends: Float64Array;
  /** index into `values` */
  at: Uint32Array;
  values: string[];
}

/** Last range whose start is <= x, if it also ends at or after x. */
function find(t: Table, x: number): string | null {
  let lo = 0;
  let hi = t.starts.length - 1;
  let hit = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (t.starts[mid]! <= x) { hit = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return hit >= 0 && t.ends[hit]! >= x ? (t.values[t.at[hit]!] ?? null) : null;
}

/** A CSV line "start,end,value" where the value may be quoted and may contain commas. */
function parseLine(line: string): [string, string, string] | null {
  const a = line.indexOf(',');
  const b = a < 0 ? -1 : line.indexOf(',', a + 1);
  if (b < 0) return null;
  return [line.slice(0, a), line.slice(a + 1, b), line.slice(b + 1)];
}

function table(csv: string): Table {
  const starts: number[] = [];
  const ends: number[] = [];
  const at: number[] = [];
  const values: string[] = [];
  const index = new Map<string, number>();
  for (const line of csv.split('\n')) {
    const p = parseLine(line.trimEnd());
    if (!p) continue;
    const s = ipv4ToInt(p[0]);
    const e = ipv4ToInt(p[1]);
    if (s === null || e === null || e < s) continue; // IPv6 and malformed lines
    let i = index.get(p[2]);
    if (i === undefined) { i = values.length; values.push(p[2]); index.set(p[2], i); }
    starts.push(s); ends.push(e); at.push(i);
  }
  // the files are sorted, but a wrong order would silently break the search: sort by start to be sure
  const order = starts.map((_, i) => i).sort((x, y) => starts[x]! - starts[y]!);
  return {
    starts: Float64Array.from(order, (i) => starts[i]!),
    ends: Float64Array.from(order, (i) => ends[i]!),
    at: Uint32Array.from(order, (i) => at[i]!),
    values,
  };
}

const unquote = (s: string): string => (s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1).replace(/""/g, '"') : s);

/** Builds the lookup from the text of the two files (country: start,end,CC; asn: start,end,number,"organisation"). */
export function createGeo(countryCsv: string, asnCsv: string): GeoLookup {
  const countries = table(countryCsv);
  const asns = table(asnCsv);
  return (ip) => {
    const x = ipv4ToInt(ip);
    if (x === null) return { country: null, asn: null, org: null };
    const c = find(countries, x);
    const a = find(asns, x);
    let asn: number | null = null;
    let org: string | null = null;
    if (a !== null) {
      const comma = a.indexOf(',');
      const num = comma < 0 ? a : a.slice(0, comma);
      asn = /^\d{1,10}$/.test(num) ? Number(num) : null;
      org = comma < 0 ? null : unquote(a.slice(comma + 1)).slice(0, 80) || null;
    }
    // DB-IP uses ZZ for "no country"
    return { country: c !== null && /^[A-Z]{2}$/.test(c) && c !== 'ZZ' ? c : null, asn, org };
  };
}

/** Reads dbip-country-lite.csv.gz and dbip-asn-lite.csv.gz from a directory; null if they are not there. */
export function loadGeo(dir: string): GeoLookup | null {
  try {
    const read = (name: string) => gunzipSync(readFileSync(`${dir}/${name}`)).toString('utf8');
    return createGeo(read('dbip-country-lite.csv.gz'), read('dbip-asn-lite.csv.gz'));
  } catch {
    return null;
  }
}
