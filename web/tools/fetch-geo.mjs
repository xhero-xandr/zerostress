// Downloads the DB-IP Lite country and ASN files (CC BY 4.0, https://db-ip.com/db/lite.php) into a directory, for
// agent/geo.ts. Run on the host by the deploy script, not by the service. This month's file is tried first, then the
// previous month's (the new one appears a few days into the month). Each file is checked before it replaces the old one.
//
//   node tools/fetch-geo.mjs /var/lib/zerostress-web/geo
import { gunzipSync } from 'node:zlib';
import { mkdirSync, renameSync, writeFileSync, existsSync, statSync } from 'node:fs';

const dir = process.argv[2];
if (!dir) { console.error('usage: fetch-geo.mjs <directory>'); process.exit(2); }
mkdirSync(dir, { recursive: true });

const MIN_LINES = { 'dbip-country-lite': 100_000, 'dbip-asn-lite': 100_000 };
const months = (() => {
  const d = new Date();
  const m = (x) => `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, '0')}`;
  return [m(d), m(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)))];
})();

let failed = false;
for (const [name, min] of Object.entries(MIN_LINES)) {
  const target = `${dir}/${name}.csv.gz`;
  if (existsSync(target) && Date.now() - statSync(target).mtimeMs < 20 * 86_400_000 && !process.env.FORCE) { console.log(`${name}: fresh enough`); continue; }
  let done = false;
  for (const month of months) {
    const res = await fetch(`https://download.db-ip.com/free/${name}-${month}.csv.gz`, { signal: AbortSignal.timeout(120_000) }).catch(() => null);
    if (!res?.ok) continue;
    const body = Buffer.from(await res.arrayBuffer());
    let lines = 0;
    try { lines = gunzipSync(body).toString('utf8').split('\n').length; } catch { /* not a gzip file */ }
    if (lines < min) { console.error(`${name}-${month}: ${lines} lines, refused`); continue; }
    writeFileSync(`${target}.tmp`, body, { mode: 0o644 });
    renameSync(`${target}.tmp`, target);
    console.log(`${name}: ${month}, ${lines} lines`);
    done = true;
    break;
  }
  if (!done) { console.error(`${name}: could not be fetched`); failed = true; }
}
process.exit(failed ? 1 : 0);
