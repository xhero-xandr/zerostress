import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createReputation } from '../reputation.ts';
import { analyze } from '../signals.ts';

const KEYS = { safeBrowsing: 'GKEY_abc', virustotal: 'VKEY_abc', spamhausDqs: 'dqskey123' };
const js = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
function fakes(o: { google?: unknown; vt?: unknown; dbl?: string[] | Error } = {}) {
  const calls: Array<{ url: string; key: string | null; body: string }> = [];
  const names: string[] = [];
  const fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, key: new Headers(init.headers).get('x-apikey'), body: String(init.body ?? '') });
    if (url.includes('safebrowsing')) return js(o.google ?? {});
    if (url.includes('virustotal')) return o.vt instanceof Response ? o.vt : js(o.vt ?? { data: { attributes: { last_analysis_stats: { malicious: 0, suspicious: 0, harmless: 60, undetected: 30 } } } });
    return js({}, 404);
  }) as typeof globalThis.fetch;
  const resolve4 = async (name: string) => { names.push(name); if (o.dbl instanceof Error) throw o.dbl; if (!o.dbl) throw Object.assign(new Error('nx'), { code: 'ENOTFOUND' }); return o.dbl; };
  return { fetch, resolve4, calls, names };
}

test('a clean address: Google knows nothing, Spamhaus does not list it, no engine flags it; each key in its own place', async () => {
  const f = fakes();
  const r = await createReputation(KEYS, { fetch: f.fetch, resolve4: f.resolve4 }).check(['https://www.bank.example/', 'https://www.bank.example/'], 'www.bank.example');
  assert.deepEqual(r, { google: [], spamhaus: 'clean', virustotal: { malicious: 0, suspicious: 0, total: 90 }, urlscan: null });
  const g = f.calls.find((c) => c.url.includes('safebrowsing'))!;
  assert.match(g.url, /\?key=GKEY_abc$/);
  assert.equal(JSON.parse(g.body).threatInfo.threatEntries.length, 1, 'the same address asked once');
  assert.equal(f.calls.find((c) => c.url.includes('virustotal'))!.key, 'VKEY_abc');
  assert.match(f.calls.find((c) => c.url.includes('virustotal'))!.url, /\/domains\/bank\.example$/, 'the site\'s domain, not the host');
  assert.deepEqual(f.names, ['bank.example.dqskey123.dbl.dq.spamhaus.net']);
});

test('listings become signals that can only raise the verdict', async () => {
  const f = fakes({ google: { matches: [{ threatType: 'SOCIAL_ENGINEERING' }, { threatType: '<script>' }] }, dbl: ['127.0.1.4'], vt: { data: { attributes: { last_analysis_stats: { malicious: 5, suspicious: 1, harmless: 50 } } } } });
  const rep = await createReputation(KEYS, { fetch: f.fetch, resolve4: f.resolve4 }).check(['https://evil.example/login'], 'evil.example');
  assert.deepEqual(rep, { google: ['SOCIAL_ENGINEERING'], spamhaus: 'phish', virustotal: { malicious: 5, suspicious: 1, total: 56 }, urlscan: null });
  const ev = (kind: string, o: Record<string, unknown> = {}) => ({ type: 'evidence', v: 1, kind, t: 0, ...o });
  const plain = [ev('nav', { via: 'requested', from: '', to: 'https://evil.example/' }), ev('page', { url: 'https://evil.example/', title: 'Hello', text: 'x'.repeat(400), hidden_text: { present: false, reasons: [], text: '' }, meta: [] }), ev('summary', { final_url: 'https://evil.example/', nav_error: null })];
  assert.equal(analyze(plain).verdict, 'benign');
  const a = analyze(plain, { reputation: rep });
  assert.equal(a.verdict, 'malicious');
  assert.deepEqual(a.signals.filter((s) => s.id.includes('_by_')).map((s) => [s.id, s.level]), [['listed_by_google', 'high'], ['listed_by_spamhaus', 'high'], ['flagged_by_virustotal', 'high']]);
  // a clean record lowers nothing
  assert.equal(analyze(plain, { reputation: { google: [], spamhaus: 'clean', virustotal: { malicious: 0, suspicious: 0, total: 90 } } }).verdict, 'benign');
  // one engine alone is a low hint, spam alone a medium one
  const weak = analyze(plain, { reputation: { google: [], spamhaus: 'spam', virustotal: { malicious: 1, suspicious: 0, total: 90 } } });
  assert.deepEqual(weak.signals.filter((s) => s.id.includes('_by_')).map((s) => s.level), ['medium', 'low']);
});

test('anything failing is "not known", never "clean"; Spamhaus\'s error answers are not a listing', async () => {
  const down = fakes({ dbl: Object.assign(new Error('timeout'), { code: 'ETIMEOUT' }), vt: new Response('quota', { status: 429 }) });
  const fail = (async () => { throw new Error('down'); }) as typeof fetch;
  const r = await createReputation(KEYS, { fetch: fail, resolve4: down.resolve4 }).check(['https://x.example/'], 'x.example');
  assert.deepEqual(r, { google: null, spamhaus: null, virustotal: null, urlscan: null });
  const odd = fakes({ dbl: ['127.255.255.254'] });
  assert.equal((await createReputation(KEYS, { fetch: odd.fetch, resolve4: odd.resolve4 }).check([], 'x.example')).spamhaus, null);
  const none = createReputation({});
  assert.equal(none.enabled, false);
  assert.deepEqual(await none.check(['https://x.example/'], 'x.example'), { google: null, spamhaus: null, virustotal: null, urlscan: null });
});

test('VirusTotal is asked at most four times a minute; a skipped ask is not remembered', async () => {
  const f = fakes();
  let t = 0;
  const rep = createReputation(KEYS, { fetch: f.fetch, resolve4: f.resolve4, now: () => t });
  for (let i = 0; i < 6; i++) await rep.check([], `d${i}.example`);
  assert.equal(f.calls.filter((c) => c.url.includes('virustotal')).length, 4);
  t = 61_000;
  assert.notEqual((await rep.check([], 'd5.example')).virustotal, null, 'asked again once the minute has passed');
});

test('urlscan.io: the verdict on the latest scan of the domain, found by a search; the key in its header; nothing new is scanned', async () => {
  const ID = '01a1b735-6fd4-76fd-9996-a38a9cc5d56e';
  const calls: Array<{ url: string; method: string; key: string | null }> = [];
  const fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, method: init.method ?? 'GET', key: new Headers(init.headers).get('api-key') });
    if (url.includes('/search/')) return js({ results: [{ _id: ID }] });
    if (url.includes(`/result/${ID}/`)) return js({ task: { time: '2026-11-07T18:11:45.080Z' }, verdicts: { overall: { malicious: true, score: 100 } } });
    return js({}, 404);
  }) as typeof globalThis.fetch;
  const r = await createReputation({ urlscan: 'UKEY' }, { fetch, resolve4: async () => [] }).check([], 'c07m.top');
  assert.deepEqual(r.urlscan, { malicious: true, scanned_at: '2026-11-07T18:11:45.080Z' });
  assert.ok(calls.every((c) => c.method === 'GET' && c.key === 'UKEY'), 'only reads');
  assert.match(decodeURIComponent(calls[0]!.url), /q=page\.domain:"c07m\.top"/);
  const plain = [{ type: 'evidence', v: 1, kind: 'page', t: 0, url: 'https://c07m.top/', title: 'x', text: 'x'.repeat(400), hidden_text: { present: false, reasons: [], text: '' }, meta: [] }, { type: 'evidence', v: 1, kind: 'summary', t: 0, final_url: 'https://c07m.top/', nav_error: null }];
  assert.equal(analyze(plain, { reputation: r }).signals.find((s) => s.id === 'flagged_by_urlscan')?.level, 'medium');
});
