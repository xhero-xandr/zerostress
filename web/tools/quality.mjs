#!/usr/bin/env node
// Quality of the analysis on REAL pages, through the whole production pipeline on this host (microVM, rules, model,
// Cloudflare's second opinion): ordinary sites that often show a bot wall, and live phishing from the OpenPhish feed.
// What counts is a correct, useful result, not that a page loaded.
//
//   node web/tools/quality.mjs [--walls=web/tools/quality-walls.txt] [--phish=30] [--jobs=2] [--out=build/e2e/quality]
//
// It talks to the local web service (127.0.0.1:8080) like the site does. It is our own measurement on our own host, so
// it says which address it checks from (X-Real-IP, which the service reads only from this machine), one per worker
// and a new one every 20 checks, to stay inside the per-address limits; the service's daily cap still applies.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const arg = (name, def) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? def;
const root = resolve(import.meta.dirname, '../..');
const wallsFile = arg('walls', join(root, 'web/tools/quality-walls.txt'));
const phishN = Number(arg('phish', '30'));
const jobs = Number(arg('jobs', '2'));
const out = resolve(arg('out', join(root, 'build/e2e/quality')));
const API = 'http://127.0.0.1:8080';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const walls = readFileSync(wallsFile, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
let phish = [];
if (phishN > 0) {
  // the feed is a plain list of addresses; only the list is fetched here, the pages are opened in the sandbox
  const feed = await fetch('https://openphish.com/feed.txt').then((r) => r.text()).catch(() => '');
  const seen = new Set();
  for (const u of feed.split('\n').map((l) => l.trim()).filter((l) => /^https?:\/\//.test(l))) {
    const host = new URL(u).host;
    if (seen.has(host)) continue; // one per site: the same kit on one host says the same thing
    seen.add(host);
    phish.push(u);
    if (phish.length >= phishN) break;
  }
}
const list = [...walls.map((url) => ({ set: 'walls', url })), ...phish.map((url) => ({ set: 'phish', url }))];
console.log(`${walls.length} walled sites, ${phish.length} live phishing links, ${jobs} at a time`);

let n = 0;
const ipFor = (worker, i) => `10.255.${worker}.${1 + Math.floor(i / 20)}`;
async function check(item, ip) {
  const t0 = Date.now();
  const h = { 'content-type': 'application/json', 'x-real-ip': ip };
  const start = await fetch(`${API}/api/tasks`, { method: 'POST', headers: h, body: JSON.stringify({ url: item.url }) });
  if (start.status !== 202) return { ...item, outcome: `refused_${start.status}`, ms: Date.now() - t0 };
  const { id } = await start.json();
  let stage = '';
  for (let i = 0; i < 120 && !['done', 'failed'].includes(stage); i++) { await sleep(2000); stage = (await (await fetch(`${API}/api/tasks/${id}`)).json()).stage; }
  let rep = await (await fetch(`${API}/r/${id}/report.json`)).json().catch(() => null);
  // a wall: Cloudflare is asked on its own; wait for its answer
  for (let i = 0; i < 45 && rep?.second_opinion_state === 'asking'; i++) { await sleep(2000); rep = await (await fetch(`${API}/r/${id}/report.json`)).json(); }
  if (!rep) return { ...item, id, outcome: 'no_report', ms: Date.now() - t0 };
  const ids = rep.signals.map((s) => s.id);
  const wall = ids.some((s) => ['bot_challenge', 'http_error', 'empty_page', 'provider_warning'].includes(s));
  const so = rep.second_opinion;
  return {
    ...item, id, ms: Date.now() - t0, verdict: rep.verdict, mode: rep.mode, final_host: rep.facts.final_host,
    wall, wall_kind: ids.filter((s) => ['bot_challenge', 'http_error', 'empty_page', 'provider_warning'].includes(s)).join(','),
    cf: so ? `${so.source}:${so.status ?? '-'}:${so.malicious === true ? 'malicious' : so.malicious === false ? 'clean' : 'none'}` : rep.second_opinion_state ?? '',
    signals: ids.filter((s) => !['many_third_parties', 'blocked_requests', 'young_certificate'].includes(s)).join(','),
    age_days: rep.facts.domain?.age_days ?? null,
    rep: rep.reputation ? `g=${rep.reputation.google === null ? '-' : rep.reputation.google.length ? 'LISTED' : 'ok'} s=${rep.reputation.spamhaus ?? '-'} vt=${rep.reputation.virustotal ? rep.reputation.virustotal.malicious + rep.reputation.virustotal.suspicious : '-'} u=${rep.reputation.urlscan === null ? '-' : rep.reputation.urlscan ? 'BAD' : 'ok'}` : '',
  };
}

const results = [];
await Promise.all(Array.from({ length: jobs }, async (_, w) => {
  for (let i = 0; ; i++) {
    const item = list[n++];
    if (!item) return;
    const r = await check(item, ipFor(w, i)).catch((e) => ({ ...item, outcome: `error_${e.name}` }));
    results.push(r);
    console.log(`${String(results.length).padStart(3)} ${r.set.padEnd(5)} ${(r.verdict ?? r.outcome).padEnd(10)} ${String(r.wall ? 'WALL' : '').padEnd(4)} cf=${(r.cf ?? '').padEnd(22)} ${(r.rep ?? '').padEnd(34)} ${Math.round((r.ms ?? 0) / 1000)}s ${r.url.slice(0, 70)}`);
  }
}));

mkdirSync(out, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
writeFileSync(join(out, `quality-${stamp}.json`), JSON.stringify(results, null, 1));

const sum = (set) => {
  const rs = results.filter((r) => r.set === set);
  const by = (f) => rs.filter(f).length;
  return { total: rs.length, benign: by((r) => r.verdict === 'benign'), suspicious: by((r) => r.verdict === 'suspicious'), malicious: by((r) => r.verdict === 'malicious'), unknown: by((r) => r.verdict === 'unknown'), wall: by((r) => r.wall), wall_cf_answered: by((r) => r.wall && /^(found|submitted)/.test(r.cf ?? '')), other: by((r) => !r.verdict) };
};
console.log('\nwalled sites (should be: no false alarm, and a useful answer even behind a wall):', JSON.stringify(sum('walls')));
console.log('live phishing (should be: suspicious or malicious):', JSON.stringify(sum('phish')));
console.log(`details: ${join(out, `quality-${stamp}.json`)}`);
