import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateSubmit } from '../src/api.ts';
import { SESSION_READY, finished, harness, sse, waitFor, withApi } from './helpers.ts';

const call = (base: string, method: string, path: string, body?: unknown) =>
  fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });

const SESSION_SCRIPT = { lines: ['{"type":"evidence","v":1,"kind":"nav"}', SESSION_READY], hang: true };
const GHOST = '99999999-9999-4999-8999-999999999999';

async function openSession(base: string, h: ReturnType<typeof harness>, session: unknown = {}): Promise<string> {
  const r = await call(base, 'POST', '/v1/runs', { kind: 'url', url: 'https://example.test/a', session });
  assert.equal(r.status, 202);
  const { run_id } = (await r.json()) as { run_id: string };
  await waitFor(() => h.sup.get(run_id)?.state === 'session');
  return run_id;
}

test('validateSubmit: the session field', () => {
  const url = 'https://a.b/';
  assert.deepEqual(validateSubmit({ kind: 'url', url, session: {} }), { ok: true, url, session: {} });
  assert.deepEqual(validateSubmit({ kind: 'url', url, session: { idle_s: 5, max_s: 600 } }), { ok: true, url, session: { idleS: 5, maxS: 600 } });
  assert.deepEqual(validateSubmit({ kind: 'url', url, session: { idle_s: 120, max_s: 30 } }), { ok: true, url, session: { idleS: 120, maxS: 30 } });
  assert.deepEqual(validateSubmit({ kind: 'url', url }), { ok: true, url }, 'no session field, no session in the result');
  const bad: unknown[] = [
    true, 'yes', 5, null, [], [1], { idle_s: 4 }, { idle_s: 121 }, { max_s: 29 }, { max_s: 601 }, { idle_s: 1.5 }, { max_s: '300' },
    { idle_s: null }, { max_s: Number.NaN }, { cmd: 'x' }, { idle_s: 10, extra: 1 },
  ];
  for (const s of bad) assert.equal(validateSubmit({ kind: 'url', url, session: s }).ok, false, JSON.stringify(s));
});

test('POST /v1/runs with a session: accepted with session:true, limits applied, defaults from the configuration', async () => {
  const h = harness({ '*': SESSION_SCRIPT }, { bootTimeoutMs: 300, sessionIdleMs: 20_000, sessionMaxMs: 200_000 });
  await withApi(h, async (base) => {
    const id = await openSession(base, h, { idle_s: 30 });
    const view = (await (await call(base, 'GET', `/v1/runs/${id}`)).json()) as Record<string, unknown>;
    assert.deepEqual(view.session, { idle_s: 30, max_s: 200 });
    assert.deepEqual(view.commands, { total: 0, awaiting_approval: 0 });
    const plain = await call(base, 'POST', '/v1/runs', { kind: 'url', url: 'https://example.test/b' });
    const plainBody = (await plain.json()) as Record<string, unknown>;
    assert.equal(plainBody.session, undefined);
    assert.equal((await call(base, 'POST', '/v1/runs', { kind: 'url', url: 'https://example.test/c', session: { max_s: 5 } })).status, 400);
    h.sup.cancel(id);
    h.sup.cancel(plainBody.run_id as string);
  });
});

test('the 202 for a session request says session:true', async () => {
  const h = harness({ '*': SESSION_SCRIPT }, { bootTimeoutMs: 300 });
  await withApi(h, async (base) => {
    const r = await call(base, 'POST', '/v1/runs', { kind: 'url', url: 'https://example.test/a', session: {} });
    const body = (await r.json()) as { run_id: string; session?: boolean };
    assert.equal(body.session, true);
    h.sup.cancel(body.run_id);
  });
});

test('a session request is refused with 503 when sessions are switched off', async () => {
  const h = harness({}, { sessionSlots: 0 });
  await withApi(h, async (base) => {
    assert.equal((await call(base, 'POST', '/v1/runs', { kind: 'url', url: 'https://example.test/a', session: {} })).status, 503);
  });
});

test('commands before the session is ready get 409 with code not_session', async () => {
  const h = harness({ '*': { lines: [], hang: true } }, { bootTimeoutMs: 300, hardTimeoutMs: 3000 });
  await withApi(h, async (base) => {
    const r = await call(base, 'POST', '/v1/runs', { kind: 'url', url: 'https://example.test/a', session: {} });
    const { run_id: id } = (await r.json()) as { run_id: string };
    const early = await call(base, 'POST', `/v1/runs/${id}/commands`, { cmd: 'snapshot', id: 'early' });
    assert.equal(early.status, 409);
    assert.equal(((await early.json()) as { code: string }).code, 'not_session');
    h.sup.cancel(id);
  });
});

test('commands over HTTP: accepted, validated, one id once', async () => {
  const h = harness({ '*': SESSION_SCRIPT }, { bootTimeoutMs: 300 });
  await withApi(h, async (base) => {
    const id = await openSession(base, h);
    const s1 = await call(base, 'POST', `/v1/runs/${id}/commands`, { cmd: 'scroll', id: 's1', dy: 100 });
    assert.equal(s1.status, 202);
    const body = (await s1.json()) as { command_id: string; status: string; command_sha256: string };
    assert.deepEqual([body.command_id, body.status], ['s1', 'accepted']);
    assert.match(body.command_sha256, /^[0-9a-f]{64}$/);
    for (const bad of [{ cmd: 'eval', id: 'x' }, { cmd: 'scroll', id: 'x' }, { cmd: 'scroll', id: 'x', dy: 99999 }, [], 'oops']) {
      assert.equal((await call(base, 'POST', `/v1/runs/${id}/commands`, bad)).status, 400, JSON.stringify(bad));
    }
    assert.equal((await call(base, 'POST', `/v1/runs/${id}/commands`, '{not json')).status, 400);
    assert.equal((await call(base, 'POST', `/v1/runs/${id}/commands`, { cmd: 'snapshot', id: 's1' })).status, 409, 'duplicate id');
    h.sup.cancel(id);
  });
});

test('a risky command over HTTP: held, approvals validated, one-time, and reaches the guest only after approval', async () => {
  const h = harness({ '*': SESSION_SCRIPT }, { bootTimeoutMs: 300 });
  await withApi(h, async (base) => {
    const id = await openSession(base, h);
    const vm = h.backend.vmByRun.get(id)!;
    const d = (await (await call(base, 'POST', `/v1/runs/${id}/commands`, { cmd: 'download', id: 'dl', snap: 1, ref: 'e2' })).json()) as {
      status: string;
      command_sha256: string;
    };
    assert.equal(d.status, 'awaiting_approval');
    assert.deepEqual(vm.sent, []);

    const approve = (b: unknown) => call(base, 'POST', `/v1/runs/${id}/approvals`, b);
    assert.equal((await approve({ command_id: 'dl', command_sha256: 'f'.repeat(64) })).status, 409);
    assert.equal((await approve({ command_id: 'dl' })).status, 400);
    assert.equal((await approve({ command_id: 'dl', command_sha256: 5 })).status, 400);
    assert.equal((await approve({ command_id: 'bad id!', command_sha256: d.command_sha256 })).status, 400);
    assert.equal((await approve({ command_id: 'dl', command_sha256: d.command_sha256, force: true })).status, 400);
    assert.equal((await approve([])).status, 400);
    assert.equal((await approve({ command_id: 'ghost', command_sha256: d.command_sha256 })).status, 404);
    assert.deepEqual(vm.sent, [], 'none of the refused approvals reached the guest');

    const ok = await approve({ command_id: 'dl', command_sha256: d.command_sha256 });
    assert.equal(ok.status, 202);
    assert.deepEqual(await ok.json(), { command_id: 'dl', status: 'approved' });
    assert.equal((await approve({ command_id: 'dl', command_sha256: d.command_sha256 })).status, 409, 'one-time');
    await waitFor(() => vm.sent.length === 1);
    assert.equal(vm.sent[0], '{"cmd":"download","id":"dl","ref":"e2","snap":1}');
    h.sup.cancel(id);
  });
});

test('an approval with the hash of another command is refused', async () => {
  const h = harness({ '*': SESSION_SCRIPT }, { bootTimeoutMs: 300 });
  await withApi(h, async (base) => {
    const id = await openSession(base, h);
    const a = (await (await call(base, 'POST', `/v1/runs/${id}/commands`, { cmd: 'download', id: 'a', snap: 1, ref: 'e1' })).json()) as { command_sha256: string };
    const b = (await (await call(base, 'POST', `/v1/runs/${id}/commands`, { cmd: 'submit_form', id: 'b', snap: 1, form: 'e2', values: { e3: 'x' } })).json()) as {
      command_sha256: string;
    };
    const r = await call(base, 'POST', `/v1/runs/${id}/approvals`, { command_id: 'b', command_sha256: a.command_sha256 });
    assert.equal(r.status, 409);
    assert.equal(((await r.json()) as { code: string }).code, 'hash_mismatch');
    assert.equal(h.backend.vmByRun.get(id)!.sent.length, 0);
    assert.equal((await call(base, 'POST', `/v1/runs/${id}/approvals`, { command_id: 'b', command_sha256: b.command_sha256 })).status, 202);
    h.sup.cancel(id);
  });
});

test('rejecting over HTTP, wrong methods and unknown runs', async () => {
  const h = harness({ '*': SESSION_SCRIPT }, { bootTimeoutMs: 300 });
  await withApi(h, async (base) => {
    const id = await openSession(base, h);
    const d = (await (await call(base, 'POST', `/v1/runs/${id}/commands`, { cmd: 'download', id: 'dl', snap: 1, ref: 'e3' })).json()) as { command_sha256: string };
    const del = await call(base, 'DELETE', `/v1/runs/${id}/commands/dl`);
    assert.equal(del.status, 202);
    assert.deepEqual(await del.json(), { command_id: 'dl', status: 'rejected' });
    assert.equal((await call(base, 'DELETE', `/v1/runs/${id}/commands/dl`)).status, 409);
    assert.equal((await call(base, 'DELETE', `/v1/runs/${id}/commands/nope`)).status, 404);
    assert.equal((await call(base, 'DELETE', `/v1/runs/${id}/commands/bad%20id`)).status, 404);
    assert.equal((await call(base, 'POST', `/v1/runs/${id}/approvals`, { command_id: 'dl', command_sha256: d.command_sha256 })).status, 409);

    assert.equal((await call(base, 'GET', `/v1/runs/${id}/commands`)).status, 405);
    assert.equal((await call(base, 'GET', `/v1/runs/${id}/approvals`)).status, 405);
    assert.equal((await call(base, 'POST', `/v1/runs/${id}/commands/dl`)).status, 405);

    assert.equal((await call(base, 'POST', `/v1/runs/${GHOST}/commands`, { cmd: 'snapshot', id: 'a' })).status, 404);
    assert.equal((await call(base, 'POST', `/v1/runs/${GHOST}/approvals`, { command_id: 'a', command_sha256: 'a'.repeat(64) })).status, 404);
    assert.equal((await call(base, 'DELETE', `/v1/runs/${GHOST}/commands/a`)).status, 404);
    h.sup.cancel(id);
  });
});

test('an approval that came too late gets 410 over HTTP', async () => {
  const h = harness({ '*': SESSION_SCRIPT }, { bootTimeoutMs: 300, approvalTtlMs: 40 });
  await withApi(h, async (base) => {
    const id = await openSession(base, h, { idle_s: 120 });
    const d = (await (await call(base, 'POST', `/v1/runs/${id}/commands`, { cmd: 'download', id: 'dl', snap: 1, ref: 'e2' })).json()) as { command_sha256: string };
    await new Promise((r) => setTimeout(r, 120));
    const late = await call(base, 'POST', `/v1/runs/${id}/approvals`, { command_id: 'dl', command_sha256: d.command_sha256 });
    assert.equal(late.status, 410);
    assert.equal(((await late.json()) as { code: string }).code, 'expired');
    assert.equal(h.backend.vmByRun.get(id)!.sent.length, 0);
    h.sup.cancel(id);
  });
});

test('close ends the session, later calls get 409, and the event stream tells the whole story', async () => {
  const h = harness({ '*': SESSION_SCRIPT }, { bootTimeoutMs: 300 });
  await withApi(h, async (base) => {
    const id = await openSession(base, h);
    const d = (await (await call(base, 'POST', `/v1/runs/${id}/commands`, { cmd: 'download', id: 'dl', snap: 1, ref: 'e2' })).json()) as { command_sha256: string };
    assert.equal((await call(base, 'POST', `/v1/runs/${id}/approvals`, { command_id: 'dl', command_sha256: d.command_sha256 })).status, 202);
    await call(base, 'POST', `/v1/runs/${id}/commands`, { cmd: 'download', id: 'dl2', snap: 1, ref: 'e4' });
    assert.equal((await call(base, 'DELETE', `/v1/runs/${id}/commands/dl2`)).status, 202);
    assert.equal((await call(base, 'POST', `/v1/runs/${id}/commands`, { cmd: 'close', id: 'bye' })).status, 202);

    assert.equal((await finished(h, id)).state, 'done');
    assert.equal((await call(base, 'POST', `/v1/runs/${id}/commands`, { cmd: 'snapshot', id: 'late' })).status, 409);
    assert.equal((await call(base, 'POST', `/v1/runs/${id}/approvals`, { command_id: 'dl', command_sha256: d.command_sha256 })).status, 409);

    const events = await sse(`${base}/v1/runs/${id}/events`);
    const cmds = events.filter((e) => e.event === 'command').map((e) => JSON.parse(e.data) as { command_id: string; status: string });
    const of = (cid: string) => cmds.filter((e) => e.command_id === cid).map((e) => e.status);
    assert.deepEqual(of('dl'), ['accepted', 'awaiting_approval', 'approved', 'sent', 'done']);
    assert.deepEqual(of('dl2'), ['accepted', 'awaiting_approval', 'rejected']);
    assert.deepEqual(of('bye'), ['accepted', 'sent', 'done']);
    assert.ok(events.some((e) => e.event === 'state' && e.data.includes('"session"')));
    h.backend.assertClean();
  });
});

test('health lists the session slots', async () => {
  const h = harness({ '*': SESSION_SCRIPT }, { bootTimeoutMs: 300, sessionSlots: 1 });
  await withApi(h, async (base) => {
    const id = await openSession(base, h);
    const body = (await (await call(base, 'GET', '/v1/health')).json()) as { sessions: unknown };
    assert.deepEqual(body.sessions, { running: 1, limit: 1 });
    h.sup.cancel(id);
  });
});
