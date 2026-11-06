#!/usr/bin/env node
// False-hit check of the hooks on REAL public pages (spec 009, 8): the real collector reads each page of
// tools/corpus-urls.txt, the hooks inspect what it reported, and the pages that fire are listed with the rule and the
// place. Needs the collector's browser (`npx playwright install --only-shell chromium` in guest/collector/) and the network.
// The pages are all ordinary, public and harmless; nothing they say is kept: only the verdict per page is printed.
//
//   node tools/corpus.mjs [--urls=file] [--jobs=3] [--json=out.json]

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const arg = (name, def) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? def;
const urlsFile = arg('urls', join(here, 'corpus-urls.txt'));
const jobs = Number(arg('jobs', '3'));
const jsonOut = arg('json', '');

const { scanOnce } = await import(pathToFileURL(join(here, '../../guest/collector/test/helpers.mjs')).href);
const { createHooks } = await import(pathToFileURL(join(here, '../hooks/index.ts')).href);

const urls = readFileSync(urlsFile, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
const results = [];

async function one(url) {
  const started = Date.now();
  let r;
  try {
    r = await scanOnce(url, { nav_timeout_s: 30 });
  } catch (e) {
    return { url, error: String(e.message).slice(0, 80) };
  }
  const events = r.events.filter((e) => e.type === 'evidence');
  const navError = r.first('summary')?.nav_error ?? null;
  const hooks = createHooks();
  const findings = [];
  for (const ev of events) findings.push(...hooks.inspect(ev).findings);
  const text = r.first('page')?.text?.length ?? 0;
  return {
    url, ms: Date.now() - started, events: events.length, text_chars: text, nav_error: navError,
    fired: hooks.state().triggered,
    findings: findings.map((f) => ({ rule: f.rule, place: f.place, quote: f.quote.slice(0, 110) })),
  };
}

let next = 0;
await Promise.all(Array.from({ length: jobs }, async () => {
  while (next < urls.length) {
    const url = urls[next++];
    const res = await one(url);
    results.push(res);
    const tag = res.error ? 'ERROR ' : res.nav_error ? `NAVERR` : res.fired ? 'FIRES ' : 'quiet ';
    process.stdout.write(`${tag} ${url}${res.error ? ' ' + res.error : res.nav_error ? ' ' + res.nav_error : ''}\n`);
  }
}));

const ok = results.filter((r) => !r.error && !r.nav_error && r.text_chars > 0);
const fired = ok.filter((r) => r.fired);
console.log(`\npages: ${results.length}, read with text: ${ok.length}, failed or empty: ${results.length - ok.length}, fired: ${fired.length}`);
for (const r of fired) {
  console.log(`\n${r.url}`);
  for (const f of r.findings.slice(0, 6)) console.log(`  ${f.rule} @ ${f.place}: ${JSON.stringify(f.quote)}`);
}
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(results, null, 2));
process.exit(0);
