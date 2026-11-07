import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createUrlScanClient, searchFor } from '../urlscan.ts';

const CFG = { enabled: true, accountId: '0123456789abcdef0123456789abcdef', token: 'TOKEN_abcdefghijklmnopqrstuvwxyz' };
const UUID = '11111111-2222-4333-8444-555555555555';
const NOW = Date.parse('2026-11-07T12:00:00Z');
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const URL1 = 'https://www.decathlon.si/';

type Route = (url: URL, init: RequestInit) => Response | Promise<Response>;
function fake(routes: Record<string, Route>) {
  const calls: Array<{ method: string; url: string; auth: string | null }> = [];
  const f = (async (input: string | URL, init: RequestInit = {}) => {
    const u = new URL(String(input));
    calls.push({ method: init.method ?? 'GET', url: u.href, auth: new Headers(init.headers).get('authorization') });
    const key = Object.keys(routes).find((k) => u.pathname.endsWith(k) || u.pathname.includes(k));
    if (!key) return new Response('not found', { status: 404 });
    return routes[key]!(u, init);
  }) as typeof fetch;
  return { f, calls };
}
const js = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
const hit = (url: string, time: string, uuid = UUID) => ({ task: { uuid, url, time, success: true } });
const result = { task: { time: '2026-11-04T12:08:00Z' }, page: { url: URL1, status: '200', title: 'Decathlon | Športna oprema' }, verdicts: { overall: { malicious: false } } };
const client = (routes: Record<string, Route>, extra = {}) => {
  const fk = fake(routes);
  return { ...fk, c: createUrlScanClient(CFG, { fetch: fk.f, sleep: async () => {}, now: () => NOW, pollMs: 1, waitMs: 50, ...extra }) };
};

test('a recent public scan of this very address is used, and nothing new is published', async () => {
  const { c, calls } = client({ '/search': () => js({ results: [hit(URL1, '2026-11-04T12:08:00Z')] }), [`/result/${UUID}`]: () => js(result), [`/screenshots/${UUID}.png`]: () => new Response(PNG) });
  const r = await c.opinion(URL1, false);
  assert.ok(r.ok);
  assert.deepEqual(r.opinion, { uuid: UUID, source: 'found', scanned_at: '2026-11-04T12:08:00.000Z', final_url: URL1, status: 200, title: 'Decathlon | Športna oprema', malicious: false });
  assert.deepEqual([...r.screenshot!], [...PNG]);
  assert.ok(!calls.some((x) => x.method === 'POST'), 'no scan was sent');
  const q = new URL(calls[0]!.url).searchParams.get('q');
  assert.equal(q, `task.url:"${URL1}"`, 'searched for exactly this address');
});

test('without consent nothing is sent: the person is asked first', async () => {
  const { c, calls } = client({ '/search': () => js({ results: [] }) });
  assert.deepEqual(await c.opinion(URL1, false), { ok: false, reason: 'needs_consent' });
  assert.ok(!calls.some((x) => x.method === 'POST'));
});

test('with consent a new scan is sent and waited for', async () => {
  let polls = 0;
  const { c, calls } = client({
    '/search': () => js({ results: [] }),
    '/scan': () => js({ uuid: UUID, visibility: 'public' }),
    [`/result/${UUID}`]: () => (++polls < 3 ? js({ message: 'in progress' }, 404) : js({ ...result, verdicts: { overall: { malicious: true } } })),
    [`/screenshots/${UUID}.png`]: () => new Response(PNG),
  }, { waitMs: 1000 });
  const r = await c.opinion(URL1, true);
  assert.ok(r.ok);
  assert.equal(r.opinion.source, 'submitted');
  assert.equal(r.opinion.malicious, true);
  const post = calls.find((x) => x.method === 'POST')!;
  assert.match(post.url, /\/urlscanner\/v2\/scan$/);
  assert.ok(polls >= 3);
});

test('a scan of another address, an old one, or a failed one is not taken as the answer', async () => {
  for (const results of [
    [hit(`${URL1}login`, '2026-11-06T00:00:00Z')],
    [hit('https://www.decathlon.si', '2026-11-06T00:00:00Z')],
    [hit(URL1, '2026-09-01T00:00:00Z')],
    [{ task: { uuid: UUID, url: URL1, time: '2026-11-06T00:00:00Z', success: false } }],
    [hit(URL1, '2026-11-06T00:00:00Z', 'not-a-uuid')],
  ]) {
    const { c } = client({ '/search': () => js({ results }) });
    assert.deepEqual(await c.opinion(URL1, false), { ok: false, reason: 'needs_consent' }, JSON.stringify(results));
  }
});

test('an address that could change the search is never searched nor sent', async () => {
  assert.equal(searchFor('https://x.example/" OR page.domain:"y'), null);
  assert.equal(searchFor('https://x.example/a\\b'), null);
  const { c, calls } = client({ '/search': () => js({ results: [] }), '/scan': () => js({ uuid: UUID }) });
  assert.deepEqual(await c.opinion('https://x.example/" OR 1', true), { ok: false, reason: 'refused' });
  assert.equal(calls.length, 0);
});

test('what comes back is checked: no image that is not a PNG, no address that is not http(s), no odd status', async () => {
  const { c } = client({
    '/search': () => js({ results: [hit(URL1, '2026-11-06T00:00:00Z')] }),
    [`/result/${UUID}`]: () => js({ task: {}, page: { url: 'javascript:alert(1)', status: 'x', title: 'T'.repeat(500) }, verdicts: { overall: { malicious: 'yes' } } }),
    [`/screenshots/${UUID}.png`]: () => new Response('<svg onload=alert(1)>'),
  });
  const r = await c.opinion(URL1, false);
  assert.ok(r.ok);
  assert.equal(r.opinion.final_url, '');
  assert.equal(r.opinion.status, null);
  assert.equal(r.opinion.title.length, 200);
  assert.equal(r.opinion.malicious, null);
  assert.equal(r.screenshot, null);
});

test('the token only ever travels in the header, never in an address', async () => {
  const { c, calls } = client({ '/search': () => js({ results: [hit(URL1, '2026-11-06T00:00:00Z')] }), [`/result/${UUID}`]: () => js(result), [`/screenshots/${UUID}.png`]: () => new Response(PNG) });
  await c.opinion(URL1, false);
  assert.ok(calls.length >= 3);
  for (const x of calls) {
    assert.ok(!x.url.includes(CFG.token));
    assert.equal(x.auth, `Bearer ${CFG.token}`);
    assert.ok(x.url.startsWith(`https://api.cloudflare.com/client/v4/accounts/${CFG.accountId}/urlscanner/v2/`));
  }
});

test('Cloudflare away or a scan that never finishes ends in a plain refusal, never a throw', async () => {
  const away = createUrlScanClient(CFG, { fetch: (async () => { throw new Error('down'); }) as typeof fetch, sleep: async () => {}, now: () => NOW });
  assert.deepEqual(await away.opinion(URL1, true), { ok: false, reason: 'unavailable' });
  let t = NOW;
  const { c } = client({ '/search': () => js({ results: [] }), '/scan': () => js({ uuid: UUID }), [`/result/${UUID}`]: () => js({}, 404) }, { now: () => (t += 10_000), waitMs: 30_000 });
  assert.deepEqual(await c.opinion(URL1, true), { ok: false, reason: 'pending', submitted: UUID }, 'with the scan to poll next time');
  const off = createUrlScanClient({ ...CFG, enabled: false });
  assert.deepEqual(await off.opinion(URL1, true), { ok: false, reason: 'unavailable' });
});

test('a scan still running is polled on the next ask: nothing is searched or sent again', async () => {
  let done = false;
  const { c, calls } = client({
    '/search': () => js({ results: [] }),
    '/scan': () => js({ uuid: UUID, visibility: 'public' }),
    [`/result/${UUID}`]: () => (done ? js(result) : js({ message: 'in progress' }, 404)),
    [`/screenshots/${UUID}.png`]: () => new Response(PNG),
  }, { waitMs: 3, now: (() => { let t = NOW; return () => (t += 1); })() });
  assert.deepEqual(await c.opinion(URL1, true), { ok: false, reason: 'pending', submitted: UUID });
  const sent = calls.filter((x) => x.method === 'POST').length;
  const searched = calls.filter((x) => x.url.includes('/search')).length;
  done = true;
  const again = await c.opinion(URL1, true, UUID);
  assert.ok(again.ok);
  assert.equal(again.opinion.source, 'submitted');
  assert.equal(calls.filter((x) => x.method === 'POST').length, sent, 'no second scan');
  assert.equal(calls.filter((x) => x.url.includes('/search')).length, searched, 'no second search');
  const before = calls.length;
  assert.deepEqual(await c.opinion(URL1, true, '../../x'), { ok: false, reason: 'unavailable' });
  assert.equal(calls.length, before, 'a malformed id is never sent anywhere');
});

test('new public scans are capped per day for the whole service; finding a scan is not', async () => {
  let t = NOW;
  const { c, calls } = client({
    '/search': (u) => js({ results: u.searchParams.get('q')!.includes('found.example') ? [hit('https://found.example/', '2026-11-06T12:00:00Z')] : [] }),
    '/scan': () => js({ uuid: UUID, visibility: 'public' }),
    [`/result/${UUID}`]: () => js(result),
  }, { maxScansPerDay: 1, now: () => t });
  assert.ok((await c.opinion('https://a.example/', true)).ok);
  assert.deepEqual(await c.opinion('https://b.example/', true), { ok: false, reason: 'quota' });
  assert.equal(calls.filter((x) => x.method === 'POST').length, 1);
  assert.ok((await c.opinion('https://found.example/', true)).ok, 'a found scan costs nothing');
  t = NOW + 86_400_000;
  assert.ok((await c.opinion('https://b.example/', true)).ok, 'a new day');
  assert.equal(calls.filter((x) => x.method === 'POST').length, 2);
});
