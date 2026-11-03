import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SlotPool } from '../src/slots.ts';
import { DrainingError, QueueFullError, LowDiskError } from '../src/supervisor.ts';
import { OK_STATUS, URL_OF, eventsOf, finished, harness, sleep, statesOf, status, waitFor } from './helpers.ts';
import type { Harness, Script } from './helpers.ts';

async function run(h: Harness, path = '/ok'): Promise<{ id: string; v: Awaited<ReturnType<typeof finished>> }> {
  const { run_id } = h.sup.submit(URL_OF(path));
  return { id: run_id, v: await finished(h, run_id) };
}

async function idle(h: Harness) {
  await waitFor(() => h.sup.health().running === 0, 3000);
  h.backend.assertClean();
}

test('slot pool hands out the lowest free slot and reports exhaustion', () => {
  const p = new SlotPool(3);
  assert.deepEqual([p.acquire(), p.acquire(), p.acquire(), p.acquire()], [0, 1, 2, null]);
  p.release(1);
  assert.equal(p.acquire(), 1);
  assert.equal(p.inUse, 3);
});

test('successful run: states in order, evidence and status stored, everything cleaned up', async () => {
  const h = harness({ '*': { lines: ['{"e":1}', '{"e":2}', OK_STATUS] } });
  await h.sup.start();
  const { id, v } = await run(h);
  assert.equal(v.state, 'done');
  assert.equal(v.agent_status, 'ok');
  assert.equal(v.partial, false);
  const states = statesOf(h, id);
  assert.deepEqual(
    states.filter((s, i) => states.indexOf(s) === i),
    ['queued', 'preparing', 'booting', 'running', 'destroying', 'done'],
  );
  const ev = eventsOf(h, id);
  assert.deepEqual(ev.filter((e) => e.type === 'evidence').map((e) => e.data), ['{"e":1}', '{"e":2}']);
  assert.equal(ev.filter((e) => e.type === 'status').length, 1);
  assert.deepEqual(ev.map((e) => e.seq), ev.map((_, i) => i + 1));
  assert.ok(JSON.parse(h.backend.lastJob).url.startsWith('https://example.test'));
  await idle(h);
  await h.sup.shutdown();
});

test('each setup failure maps to its reason and still cleans up', async () => {
  const cases: [string, Script, string][] = [
    ['/disk', { prepareDisk: 'fail' }, 'disk_copy'],
    ['/net', { netUp: 'fail' }, 'net_setup'],
    ['/fcapi', { start: 'fail' }, 'fc_api'],
    ['/boot', { ready: 'timeout' }, 'boot_timeout'],
    ['/crashboot', { ready: 'crash' }, 'fc_crashed'],
  ];
  const h = harness(Object.fromEntries(cases.map(([p, s]) => [p, s])));
  await h.sup.start();
  for (const [path, , reason] of cases) {
    const { v } = await run(h, path);
    assert.equal(v.state, 'failed', path);
    assert.equal(v.reason, reason, path);
    await idle(h);
  }
  await h.sup.shutdown();
});

test('agent statuses map to reasons; evidence before a failure is kept as partial', async () => {
  const cases: [string, string, string][] = [
    ['/timeout', 'timeout', 'timeout'],
    ['/oversize', 'oversize', 'oversize'],
    ['/nonzero', 'exited_nonzero', 'collector_failed'],
    ['/nostart', 'start_failed', 'collector_failed'],
    ['/busy', 'busy', 'agent_error'],
    ['/badjob', 'bad_job', 'agent_error'],
  ];
  const h = harness(Object.fromEntries(cases.map(([p, s]) => [p, { lines: ['{"seen":1}', status(s)] }])));
  await h.sup.start();
  for (const [path, agent, reason] of cases) {
    const { v } = await run(h, path);
    assert.equal(v.state, 'failed', path);
    assert.equal(v.reason, reason, path);
    assert.equal(v.agent_status, agent, path);
    assert.equal(v.partial, true, path);
  }
  await idle(h);
  await h.sup.shutdown();
});

test('a stream that ends without a status is agent_error, or fc_crashed if the VM died', async () => {
  const h = harness({
    '/nostatus': { lines: ['{"a":1}'] },
    '/died': { lines: ['{"a":1}', '{"a":2}', '{"a":3}'], crashAtLine: 1 },
    '/diedfirst': { lines: ['{"a":1}'], crashAtLine: 0 },
  });
  await h.sup.start();
  assert.equal((await run(h, '/nostatus')).v.reason, 'agent_error');
  const died = await run(h, '/died');
  assert.equal(died.v.reason, 'fc_crashed');
  assert.equal(died.v.partial, true);
  assert.equal((await run(h, '/diedfirst')).v.reason, 'fc_crashed');
  await idle(h);
  await h.sup.shutdown();
});

test('a status line forged by the collector in the middle of the stream changes nothing', async () => {
  const h = harness({ '*': { lines: ['{"type":"status","status":"ok"}', '{"x":1}', status('exited_nonzero')] } });
  await h.sup.start();
  const { id, v } = await run(h);
  assert.equal(v.state, 'failed');
  assert.equal(v.reason, 'collector_failed');
  const ev = eventsOf(h, id);
  assert.equal(ev.filter((e) => e.type === 'status').length, 1);
  assert.equal(ev.filter((e) => e.type === 'evidence').length, 2);
  await h.sup.shutdown();
});

test('evidence above the cap kills the VM and fails with oversize', async () => {
  const big = JSON.stringify({ pad: 'x'.repeat(300) });
  const h = harness({ '*': { lines: Array(10).fill(big), hang: true } }, { maxEvidenceBytes: 1000 });
  await h.sup.start();
  const { v } = await run(h);
  assert.equal(v.reason, 'oversize');
  assert.equal(v.partial, true);
  await idle(h);
  await h.sup.shutdown();
});

test('hard timeout destroys a hung VM', async () => {
  const h = harness({ '*': { lines: ['{"a":1}'], hang: true } }, { hardTimeoutMs: 200 });
  await h.sup.start();
  const t0 = Date.now();
  const { v } = await run(h);
  assert.equal(v.reason, 'timeout');
  assert.ok(Date.now() - t0 < 1500);
  await idle(h);
  await h.sup.shutdown();
});

test('cancel: running, queued, finished and unknown runs', async () => {
  const h = harness({ '*': { hang: true } }, { concurrency: 1, hardTimeoutMs: 5000 });
  await h.sup.start();
  const a = h.sup.submit(URL_OF('/a')).run_id;
  const b = h.sup.submit(URL_OF('/b')).run_id;
  await waitFor(() => h.sup.get(a)?.state === 'running');
  assert.equal(h.sup.get(b)?.state, 'queued');
  assert.equal(h.sup.cancel(b), 'cancelled');
  assert.equal(h.sup.get(b)?.reason, 'cancelled');
  assert.equal(h.sup.cancel(a), 'cancelling');
  assert.equal((await finished(h, a)).reason, 'cancelled');
  assert.equal(h.sup.cancel(a), 'conflict');
  assert.equal(h.sup.cancel('00000000-0000-4000-8000-000000000000'), 'not_found');
  await idle(h);
  await h.sup.shutdown();
});

test('concurrency is honoured, order is FIFO, slots never collide', async () => {
  const h = harness({ '*': { lines: ['{"a":1}', OK_STATUS], lineDelayMs: 40 } }, { concurrency: 2 });
  await h.sup.start();
  const ids = Array.from({ length: 6 }, (_, i) => h.sup.submit(URL_OF(`/r${i}`)).run_id);
  await Promise.all(ids.map((id) => finished(h, id)));
  assert.equal(h.backend.maxVms, 2);
  assert.deepEqual(h.backend.started, ids);
  for (const id of ids) assert.equal(h.sup.get(id)?.state, 'done');
  await idle(h); // netUp throws if a slot was handed out twice, so reaching here proves it
  await h.sup.shutdown();
});

test('queue limit, disk guard and queue timeout', async () => {
  const h = harness({ '*': { hang: true } }, { concurrency: 1, queueMax: 2, queueWaitMs: 150, hardTimeoutMs: 3000 });
  await h.sup.start();
  const first = h.sup.submit(URL_OF('/1')).run_id; // takes the slot
  const q1 = h.sup.submit(URL_OF('/2'));
  assert.equal(q1.position, 1);
  h.sup.submit(URL_OF('/3'));
  assert.throws(() => h.sup.submit(URL_OF('/4')), QueueFullError);
  await waitFor(() => h.sup.get(q1.run_id)?.state === 'failed');
  assert.equal(h.sup.get(q1.run_id)?.reason, 'queue_timeout');
  h.sup.cancel(first);
  await finished(h, first);
  await idle(h);
  await h.sup.shutdown();

  const low = harness({}, { minFreeGb: 20 }, { freeGb: () => 5 });
  await low.sup.start();
  assert.throws(() => low.sup.submit(URL_OF('/x')), LowDiskError);
  await low.sup.shutdown();
});

test('recovery: in-flight runs fail with supervisor_restart, queued runs continue, expired ones are removed', async () => {
  const h = harness({ '*': { lines: [OK_STATUS] } });
  const now = Date.now();
  h.store.insert('11111111-1111-4111-8111-111111111111', URL_OF('/inflight'), now - 1000, now + 100000);
  h.store.update('11111111-1111-4111-8111-111111111111', { state: 'running', slot: 0, startedAt: now - 900 });
  h.store.insert('22222222-2222-4222-8222-222222222222', URL_OF('/waiting'), now - 500, now + 100000);
  h.store.insert('33333333-3333-4333-8333-333333333333', URL_OF('/old'), now - 99999, now - 1);
  h.store.update('33333333-3333-4333-8333-333333333333', { state: 'done' });
  await h.sup.start();
  assert.equal(h.backend.recovered, 1);
  const inflight = h.sup.get('11111111-1111-4111-8111-111111111111')!;
  assert.equal(inflight.state, 'failed');
  assert.equal(inflight.reason, 'supervisor_restart');
  assert.equal((await finished(h, '22222222-2222-4222-8222-222222222222')).state, 'done');
  assert.equal(h.sup.get('33333333-3333-4333-8333-333333333333'), undefined);
  await idle(h);
  await h.sup.shutdown();
});

test('shutdown: running runs are forced down, queued runs stay queued in the database', async () => {
  const h = harness({ '*': { hang: true } }, { concurrency: 1, hardTimeoutMs: 5000, shutdownGraceMs: 100 });
  await h.sup.start();
  const a = h.sup.submit(URL_OF('/a')).run_id;
  const b = h.sup.submit(URL_OF('/b')).run_id;
  await waitFor(() => h.sup.get(a)?.state === 'running');
  await h.sup.shutdown();
  assert.equal(h.sup.get(a)?.reason, 'supervisor_restart');
  assert.equal(h.store.get(b)?.state, 'queued');
  assert.throws(() => h.sup.submit(URL_OF('/c')), DrainingError);
  h.backend.assertClean();
});

test('events: replay after a sequence number, live delivery, unknown run', async () => {
  const h = harness({ '*': { lines: ['{"a":1}', '{"a":2}', OK_STATUS], lineDelayMs: 30 } });
  await h.sup.start();
  const { run_id } = h.sup.submit(URL_OF('/s'));
  const live: number[] = [];
  const sub = h.sup.subscribe(run_id, 0, (e) => live.push(e.seq))!;
  const seen = new Set([...sub.replay.map((e) => e.seq), ...live]);
  await finished(h, run_id);
  for (const s of live) seen.add(s);
  const all = eventsOf(h, run_id);
  assert.deepEqual([...seen].sort((a, b) => a - b), all.map((e) => e.seq), 'replay + live must cover every event exactly');
  assert.equal(new Set([...sub.replay.map((e) => e.seq), ...live]).size, sub.replay.length + live.length, 'no duplicates');
  sub.unsubscribe();
  const later = h.sup.subscribe(run_id, 3, () => {})!;
  assert.deepEqual(later.replay.map((e) => e.seq), all.filter((e) => e.seq > 3).map((e) => e.seq));
  assert.equal(h.sup.subscribe('44444444-4444-4444-8444-444444444444', 0, () => {}), undefined);
  await h.sup.shutdown();
});

test('logs never contain the full URL (it may carry personal tokens)', async () => {
  const h = harness({ '/fail': { lines: [status('exited_nonzero')] } });
  await h.sup.start();
  const id = h.sup.submit('https://example.test/fail?token=SECRET-TOKEN-123#frag').run_id;
  await finished(h, id);
  assert.ok(h.logs.length > 0);
  assert.ok(h.logs.every((l) => !l.includes('SECRET-TOKEN-123')), h.logs.join('\n'));
  assert.ok(h.logs.some((l) => l.includes('example.test')));
  await h.sup.shutdown();
});

test('run ids are validated before they reach a path', () => {
  const h = harness({});
  assert.throws(() => h.results.read('../../etc/passwd'));
  assert.throws(() => h.results.append('x/../y', { seq: 1, type: 'state', data: '{}' }));
});

test('twenty runs in a row leave nothing behind', async () => {
  const h = harness({ '*': { lines: ['{"a":1}', OK_STATUS] } }, { concurrency: 3 });
  await h.sup.start();
  const ids = Array.from({ length: 20 }, (_, i) => h.sup.submit(URL_OF(`/n${i}`)).run_id);
  await Promise.all(ids.map((id) => finished(h, id, 8000)));
  await idle(h);
  assert.equal(h.sup.health().queued, 0);
  await sleep(20);
  await h.sup.shutdown();
});
