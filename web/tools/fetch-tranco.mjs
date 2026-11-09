// Downloads the Tranco list (https://tranco-list.eu, a research ranking of the most visited sites) and keeps its top
// 100,000 names, one per line, for agent/popularity.ts. Run on the host by the deploy script, not by the service. The
// list is fetched here and not shipped in git: the site states no licence for it, so it is not redistributed. It is
// described in: Le Pochat et al., "Tranco: A Research-Oriented Top Sites Ranking Hardened Against Manipulation", NDSS 2019.
//
//   node tools/fetch-tranco.mjs /zerostress/data/tranco
import { existsSync, mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { firstZipEntry } from '../agent/zip-first.ts';

const dir = process.argv[2];
if (!dir) { console.error('usage: fetch-tranco.mjs <directory>'); process.exit(2); }
mkdirSync(dir, { recursive: true });
const target = `${dir}/top-100k.txt`;
if (existsSync(target) && Date.now() - statSync(target).mtimeMs < 6 * 86_400_000 && !process.env.FORCE) { console.log('tranco: fresh enough'); process.exit(0); }

const KEEP = 100_000;
const MIN = 90_000;
const NAME = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/;
const res = await fetch('https://tranco-list.eu/download/daily/top-1m.csv.zip', { signal: AbortSignal.timeout(120_000) }).catch(() => null);
if (!res?.ok) { console.error('tranco: could not be fetched'); process.exit(1); }
const zip = new Uint8Array(await res.arrayBuffer());
if (zip.length > 40_000_000) { console.error('tranco: the download is too large, refused'); process.exit(1); }
let names = [];
try {
  const rows = firstZipEntry(zip, 64 * 1024 * 1024).toString('utf8').split('\n', KEEP);
  for (let i = 0; i < rows.length; i++) {
    const [rank, name] = rows[i].trim().split(',');
    // a row out of order is a broken file, not something to skip over: the rank is the line number
    if (Number(rank) !== i + 1) { names = []; break; }
    names.push(NAME.test(name ?? '') ? name : '-');
  }
} catch (e) {
  console.error(`tranco: ${e instanceof Error ? e.message : 'unreadable'}, refused`);
  process.exit(1);
}
const good = names.filter((n) => n !== '-').length;
if (names.length < MIN || good < MIN) { console.error(`tranco: ${names.length} rows, ${good} names, refused`); process.exit(1); }
writeFileSync(`${target}.tmp`, names.join('\n') + '\n', { mode: 0o644 });
renameSync(`${target}.tmp`, target);
console.log(`tranco: ${names.length} names`);
