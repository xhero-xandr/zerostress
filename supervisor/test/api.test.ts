import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateSubmit } from '../src/api.ts';
import { OK_STATUS, finished, harness, sse, status, waitFor, withApi } from './helpers.ts';

const post = (base: string, body: unknown, raw = false) =>
  fetch(`${base}/v1/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw ? (body as string) : JSON.stringify(body) });

test('validateSubmit accepts http(s) URLs and rejects everything else', () => {
  assert.equal(validateSubmit({ kind: 'url', url: 'https://example.com/a?b=c' }).ok, true);
  assert.equal(validateSubmit({ kind: 'url', url: 'http://example.com' }).ok, true);
  const bad: unknown[] = [
    null, [], 'x', {}, { kind: 'file', url: 'https://a.b' }, { kind: 'url' }, { kind: 'url', url: '' }, { kind: 'url', url: 5 },
    { kind: 'url', url: 'file:///etc/passwd' }, { kind: 'url', url: 'javascript:alert(1)' }, { kind: 'url', url: 'ftp://a.b' },
    { kind: 'url', url: 'data:text/html,hi' }, { kind: 'url', url: 'https://a.b/ x' }, { kind: 'url', url: 'https://a.b/\n' },
    { kind: 'url', url: 'not a url' }, { kind: 'url', url: 'https://' }, { kind: 'url', url: 'https://' + 'a'.repeat(2100) },
    { kind: 'url', url: 'https://a.b', extra: 1 }, { kind: 'url', url: 'https://a.b', limits: { cpu: 99 } },
  ];
  for (const b of bad) assert.equal(validateSubmit(b).ok, false, JSON.stringify(b)?.slice(0, 80));
});

test('POST /v1/runs: accepted, validated, limited', async () => {
  const h = harness({ '*': { hang: true } }, { concurrency: 1, queueMax: 1, hardTimeoutMs: 3000 });
  await withApi(h, async (base) => {
    const r1 = await post(base, { kind: 'url', url: 'https://example.test/a' });
    assert.equal(r1.status, 202);
    const a = (await r1.json()) as { run_id: string };
    assert.match(a.run_id, /^[0-9a-f-]{36}$/);

    const r2 = await post(base, { kind: 'url', url: 'https://example.test/b' });
    assert.equal(r2.status, 202);
    assert.equal(((await r2.json()) as { position: number }).position, 1);

    const full = await post(base, { kind: 'url', url: 'https://example.test/c' });
    assert.equal(full.status, 429);
    assert.equal(full.headers.get('retry-after'), '10');

    assert.equal((await post(base, { kind: 'file', url: 'x' })).status, 400);
    assert.equal((await post(base, '{not json', true)).status, 400);
    const big = await post(base, JSON.stringify({ kind: 'url', url: 'https://a.b/' + 'x'.repeat(70000) }), true);
    assert.equal(big.status, 413, 'a client must get the 413, not a reset connection');
    assert.equal((await fetch(`${base}/v1/runs`)).status, 405);

    h.sup.cancel(a.run_id);
    await finished(h, a.run_id);
  });
});

test('GET and DELETE a run, unknown ids and routes', async () => {
  const h = harness({ '*': { hang: true } }, { concurrency: 1, hardTimeoutMs: 3000 });
  await withApi(h, async (base) => {
    const { run_id } = (await (await post(base, { kind: 'url', url: 'https://example.test/x' })).json()) as { run_id: string };
    await waitFor(() => h.sup.get(run_id)?.state === 'running');

    const got = (await (await fetch(`${base}/v1/runs/${run_id}`)).json()) as { state: string; position: null; url?: string };
    assert.equal(got.state, 'running');
    assert.equal('url' in got, false, 'the view must not echo the URL');

    const del = await fetch(`${base}/v1/runs/${run_id}`, { method: 'DELETE' });
    assert.equal(del.status, 202);
    await finished(h, run_id);
    assert.equal((await fetch(`${base}/v1/runs/${run_id}`, { method: 'DELETE' })).status, 409);

    assert.equal((await fetch(`${base}/v1/runs/00000000-0000-4000-8000-000000000000`)).status, 404);
    assert.equal((await fetch(`${base}/v1/runs/not-an-id`)).status, 404);
    assert.equal((await fetch(`${base}/v1/runs/${run_id}/events`, { method: 'POST' })).status, 405);
    assert.equal((await fetch(`${base}/other`)).status, 404);
  });
});

test('SSE: live stream ends on the terminal state; replay and Last-Event-ID resume work', async () => {
  const h = harness({ '*': { lines: ['{"a":1}', '{"a":2}', OK_STATUS], lineDelayMs: 40 } });
  await withApi(h, async (base) => {
    const { run_id } = (await (await post(base, { kind: 'url', url: 'https://example.test/s' })).json()) as { run_id: string };

    const live = await sse(`${base}/v1/runs/${run_id}/events`); // connects mid-run, must receive everything until the end
    assert.deepEqual(live.map((e) => e.id), live.map((_, i) => i + 1));
    const last = JSON.parse(live[live.length - 1]!.data) as { state: string };
    assert.equal(last.state, 'done');
    assert.deepEqual(live.filter((e) => e.event === 'evidence').map((e) => e.data), ['{"a":1}', '{"a":2}']);
    assert.equal(live.filter((e) => e.event === 'status').length, 1);

    assert.deepEqual(await sse(`${base}/v1/runs/${run_id}/events`), live);
    const resumed = await sse(`${base}/v1/runs/${run_id}/events`, { 'last-event-id': '4' });
    assert.deepEqual(resumed.map((e) => e.id), live.filter((e) => e.id > 4).map((e) => e.id));
    assert.deepEqual(await sse(`${base}/v1/runs/${run_id}/events`, { 'last-event-id': '9999' }), []);
    assert.equal((await fetch(`${base}/v1/runs/00000000-0000-4000-8000-000000000000/events`)).status, 404);
  });
});

test('SSE: evidence with CR or LF cannot break the framing', async () => {
  const h = harness({ '*': { lines: ['raw\rcarriage', status('exited_nonzero')] } });
  await withApi(h, async (base) => {
    const { run_id } = (await (await post(base, { kind: 'url', url: 'https://example.test/s' })).json()) as { run_id: string };
    await finished(h, run_id);
    const ev = await sse(`${base}/v1/runs/${run_id}/events`);
    assert.equal(ev.find((e) => e.event === 'evidence')!.data, 'raw\\rcarriage');
  });
});

test('health reports slots, queue and the image checksum', async () => {
  const h = harness({}, { concurrency: 2 }, { imageSha256: () => 'abc123', freeGb: () => 94.7 });
  await withApi(h, async (base) => {
    const body = (await (await fetch(`${base}/v1/health`)).json()) as Record<string, unknown>;
    assert.deepEqual(body, {
      ok: true,
      version: '0.2.0',
      concurrency: 2,
      running: 0,
      queued: 0,
      sessions: { running: 0, limit: 1 },
      free_gb: 94,
      image_sha256: 'abc123',
    });
    assert.equal((await fetch(`${base}/v1/health`, { method: 'POST' })).status, 405);
  });
});

test('503 while the service is shutting down', async () => {
  const h = harness({});
  await withApi(h, async (base) => {
    await h.sup.shutdown();
    const r = await post(base, { kind: 'url', url: 'https://example.test/x' });
    assert.equal(r.status, 503);
  });
});
