import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SessionsDisabledError } from '../src/supervisor.ts';
import type { SubmitResult } from '../src/session.ts';
import { OK_STATUS, SESSION_READY, URL_OF, cmdResult, eventsOf, finished, harness, sleep, statesOf, status, waitFor } from './helpers.ts';
import type { Harness, Script } from './helpers.ts';

const LIMITS = { idleMs: 5000, maxMs: 3000 };

/** Evidence the collector would print before the session starts, then the ready marker; the stream stays open. */
const sessionScript = (over: Partial<Script> = {}): Script => ({ lines: ['{"type":"evidence","v":1,"kind":"nav"}', SESSION_READY], hang: true, ...over });

async function startSession(h: Harness, path = '/s', limits = LIMITS) {
  const { run_id } = h.sup.submit(URL_OF(path), limits);
  await waitFor(() => h.sup.get(run_id)?.state === 'session', 3000);
  return { id: run_id, vm: h.backend.vmByRun.get(run_id)! };
}

const ok = (r: unknown): Extract<SubmitResult, { ok: true }> => {
  const x = r as SubmitResult;
  assert.ok(x.ok, JSON.stringify(x));
  return x as Extract<SubmitResult, { ok: true }>;
};

function commandEvents(h: Harness, id: string) {
  return eventsOf(h, id)
    .filter((e) => e.type === 'command')
    .map((e) => JSON.parse(e.data) as Record<string, unknown>);
}
const statusesOf = (h: Harness, id: string, commandId: string) => commandEvents(h, id).filter((e) => e.command_id === commandId).map((e) => e.status);

async function idle(h: Harness) {
  await waitFor(() => h.sup.health().running === 0, 3000);
  h.backend.assertClean();
}

test('a session passes through the session state, takes commands, and ends done after close', async () => {
  const h = harness({ '*': sessionScript() }, { bootTimeoutMs: 300 });
  await h.sup.start();
  const { id, vm } = await startSession(h);

  const job = JSON.parse(vm.job) as Record<string, unknown>;
  assert.deepEqual(job.session, { max_s: 3 }, 'the guest gets the total time only; idle belongs to the supervisor');
  assert.equal(job.idle_s, undefined);

  ok(h.sup.submitCommand(id, { cmd: 'snapshot', id: 'c1' }));
  ok(h.sup.submitCommand(id, { cmd: 'scroll', id: 'c2', dy: 200 }));
  await waitFor(() => statusesOf(h, id, 'c2').includes('done'));
  ok(h.sup.submitCommand(id, { cmd: 'close', id: 'c3' }));

  const v = await finished(h, id);
  assert.equal(v.state, 'done');
  assert.equal(v.agent_status, 'ok');
  assert.deepEqual(vm.sent, ['{"cmd":"snapshot","id":"c1"}', '{"cmd":"scroll","dy":200,"id":"c2"}', '{"cmd":"close","id":"c3"}']);
  assert.deepEqual(statusesOf(h, id, 'c1'), ['accepted', 'sent', 'done']);
  assert.deepEqual(statusesOf(h, id, 'c3'), ['accepted', 'sent', 'done']);
  const states = statesOf(h, id);
  assert.deepEqual(
    states.filter((s, i) => states.indexOf(s) === i),
    ['queued', 'preparing', 'booting', 'running', 'session', 'destroying', 'done'],
  );
  assert.deepEqual(v.session, { idle_s: 5, max_s: 3 });
  assert.deepEqual(v.commands, { total: 3, awaiting_approval: 0 });
  await idle(h);
  await h.sup.shutdown();
});

test('evidence is published as it arrives, not one line late', async () => {
  const h = harness({ '*': sessionScript() }, { bootTimeoutMs: 300 });
  await h.sup.start();
  const { id } = await startSession(h);
  const ev = eventsOf(h, id).filter((e) => e.type === 'evidence');
  assert.equal(ev.length, 2, 'the last line before the pause is already visible');
  assert.match(ev[1]!.data, /session_ready/);
  h.sup.cancel(id);
  await finished(h, id);
  await h.sup.shutdown();
});

test('commands are refused before the session is ready, for one-shot runs, and for unknown runs', async () => {
  const h = harness({ '/slow': { lines: [], hang: true }, '/oneshot': { lines: [], hang: true } }, { bootTimeoutMs: 300, hardTimeoutMs: 3000 });
  await h.sup.start();
  const unknown = h.sup.submitCommand('99999999-9999-4999-8999-999999999999', { cmd: 'snapshot', id: 'a' });
  assert.ok(!unknown.ok && unknown.code === 'not_found');

  const one = h.sup.submit(URL_OF('/oneshot')).run_id;
  await waitFor(() => h.sup.get(one)?.state === 'running');
  const r1 = h.sup.submitCommand(one, { cmd: 'snapshot', id: 'a' });
  assert.ok(!r1.ok && r1.code === 'not_session');
  assert.equal(h.sup.get(one)?.session, undefined);

  const early = h.sup.submit(URL_OF('/slow'), LIMITS).run_id; // never says session_ready
  await waitFor(() => h.sup.get(early)?.state === 'running');
  const r2 = h.sup.submitCommand(early, { cmd: 'snapshot', id: 'a' });
  assert.ok(!r2.ok && r2.code === 'not_session');
  h.sup.cancel(one);
  h.sup.cancel(early);
  await finished(h, one);
  await finished(h, early);
  await idle(h);
  await h.sup.shutdown();
});

test('a risky command is held until a human approval with its hash arrives, and only then reaches the guest', async () => {
  const h = harness({ '*': sessionScript() }, { bootTimeoutMs: 300 });
  await h.sup.start();
  const { id, vm } = await startSession(h);

  const d = ok(h.sup.submitCommand(id, { cmd: 'download', id: 'dl', snap: 1, ref: 'e5' }));
  assert.equal(d.status, 'awaiting_approval');
  await sleep(30);
  assert.deepEqual(vm.sent, [], 'nothing reaches the guest before approval');
  assert.deepEqual(h.sup.get(id)?.commands, { total: 1, awaiting_approval: 1 });

  const wrong = h.sup.approveCommand(id, 'dl', 'f'.repeat(64));
  assert.ok(!wrong.ok && wrong.code === 'hash_mismatch');
  assert.deepEqual(vm.sent, []);

  assert.deepEqual(h.sup.approveCommand(id, 'dl', d.command_sha256), { ok: true });
  await waitFor(() => statusesOf(h, id, 'dl').includes('done'));
  assert.deepEqual(vm.sent, ['{"cmd":"download","id":"dl","ref":"e5","snap":1}']);
  assert.deepEqual(statusesOf(h, id, 'dl'), ['accepted', 'awaiting_approval', 'approved', 'sent', 'done']);
  const again = h.sup.approveCommand(id, 'dl', d.command_sha256);
  assert.ok(!again.ok && again.code === 'not_waiting');
  assert.equal(vm.sent.length, 1);

  ok(h.sup.submitCommand(id, { cmd: 'close', id: 'bye' }));
  await finished(h, id);
  await idle(h);
  await h.sup.shutdown();
});

test('rejecting a waiting command voids nothing else and the session carries on', async () => {
  const h = harness({ '*': sessionScript() }, { bootTimeoutMs: 300 });
  await h.sup.start();
  const { id, vm } = await startSession(h);
  ok(h.sup.submitCommand(id, { cmd: 'download', id: 'dl', snap: 1, ref: 'e5' }));
  assert.deepEqual(h.sup.rejectCommand(id, 'dl'), { ok: true });
  ok(h.sup.submitCommand(id, { cmd: 'snapshot', id: 'next' }));
  await waitFor(() => statusesOf(h, id, 'next').includes('done'));
  assert.deepEqual(vm.sent, ['{"cmd":"snapshot","id":"next"}']);
  const missing = h.sup.rejectCommand(id, 'nope');
  assert.ok(!missing.ok && missing.code === 'not_found');
  const noRun = h.sup.rejectCommand('99999999-9999-4999-8999-999999999999', 'dl');
  assert.ok(!noRun.ok && noRun.code === 'not_found');
  h.sup.cancel(id);
  await finished(h, id);
  await h.sup.shutdown();
});

test('an unanswered approval expires and the run is not kept alive by it', async () => {
  const h = harness({ '*': sessionScript() }, { bootTimeoutMs: 300, approvalTtlMs: 60 });
  await h.sup.start();
  const { id } = await startSession(h, '/s', { idleMs: 60, maxMs: 3000 });
  const d = ok(h.sup.submitCommand(id, { cmd: 'download', id: 'dl', snap: 1, ref: 'e5' }));
  await waitFor(() => statusesOf(h, id, 'dl').includes('expired'));
  const late = h.sup.approveCommand(id, 'dl', d.command_sha256);
  assert.ok(!late.ok && late.code === 'expired');
  const v = await finished(h, id); // the idle clock restarted after the expiry and closed the session
  assert.equal(v.state, 'done');
  await idle(h);
  await h.sup.shutdown();
});

test('idle: the supervisor closes a session nobody is using', async () => {
  const h = harness({ '*': sessionScript() }, { bootTimeoutMs: 300 });
  await h.sup.start();
  const { id, vm } = await startSession(h, '/s', { idleMs: 60, maxMs: 3000 });
  const v = await finished(h, id);
  assert.equal(v.state, 'done');
  assert.deepEqual(vm.sent, ['{"cmd":"close","id":"idle-close"}']);
  assert.equal(commandEvents(h, id).find((e) => e.command_id === 'idle-close')?.by, 'supervisor');
  await idle(h);
  await h.sup.shutdown();
});

test('a command the collector never answers ends the run with timeout, evidence kept as partial', async () => {
  const h = harness({ '*': sessionScript({ silent: true }) }, { bootTimeoutMs: 300, commandTimeoutMs: 60 });
  await h.sup.start();
  const { id } = await startSession(h);
  ok(h.sup.submitCommand(id, { cmd: 'snapshot', id: 'stuck' }));
  ok(h.sup.submitCommand(id, { cmd: 'wait', id: 'queued', ms: 10 }));
  const v = await finished(h, id);
  assert.equal(v.state, 'failed');
  assert.equal(v.reason, 'timeout');
  assert.equal(v.partial, true);
  assert.deepEqual(statusesOf(h, id, 'stuck'), ['accepted', 'sent', 'timeout']);
  assert.deepEqual(statusesOf(h, id, 'queued'), ['accepted', 'voided']);
  await idle(h);
  await h.sup.shutdown();
});

test('the supervisor ceiling ends a session whose collector ignores close and the time limit', async () => {
  const stubborn = sessionScript({ onCommand: () => {} });
  const h = harness({ '*': stubborn }, { bootTimeoutMs: 100, sessionGraceMs: 60, hardTimeoutMs: 5000 });
  await h.sup.start();
  const begun = Date.now();
  const { id } = await startSession(h, '/s', { idleMs: 5000, maxMs: 120 }); // ceiling: 100 + 120 + 60 ms
  ok(h.sup.submitCommand(id, { cmd: 'close', id: 'bye' }));
  const v = await finished(h, id);
  assert.equal(v.state, 'failed');
  assert.equal(v.reason, 'timeout');
  assert.ok(Date.now() - begun < 1500, 'ended by the session ceiling, not by the 5 s one-shot limit');
  assert.deepEqual(statusesOf(h, id, 'bye'), ['accepted', 'sent', 'done'], 'a sent close counts as done once the run is over');
  await idle(h);
  await h.sup.shutdown();
});

test('a session is not cut off by the one-shot hard timeout', async () => {
  const h = harness({ '*': sessionScript() }, { bootTimeoutMs: 300, hardTimeoutMs: 100 });
  await h.sup.start();
  const { id } = await startSession(h, '/s', { idleMs: 5000, maxMs: 2000 });
  await sleep(250);
  assert.equal(h.sup.get(id)?.state, 'session');
  h.sup.cancel(id);
  await finished(h, id);
  await h.sup.shutdown();
});

test('cancelling a session voids what is open and frees everything', async () => {
  const h = harness({ '*': sessionScript({ silent: true }) }, { bootTimeoutMs: 300 });
  await h.sup.start();
  const { id } = await startSession(h);
  ok(h.sup.submitCommand(id, { cmd: 'snapshot', id: 'a' }));
  ok(h.sup.submitCommand(id, { cmd: 'download', id: 'd', snap: 1, ref: 'e1' }));
  assert.equal(h.sup.cancel(id), 'cancelling');
  const v = await finished(h, id);
  assert.equal(v.reason, 'cancelled');
  assert.deepEqual(statusesOf(h, id, 'a'), ['accepted', 'sent', 'voided']);
  assert.deepEqual(statusesOf(h, id, 'd'), ['accepted', 'awaiting_approval', 'voided']);
  const after = h.sup.submitCommand(id, { cmd: 'snapshot', id: 'late' });
  assert.ok(!after.ok && after.code === 'not_session');
  const ap = h.sup.approveCommand(id, 'd', 'a'.repeat(64));
  assert.ok(!ap.ok && ap.code === 'not_session');
  await idle(h);
  await h.sup.shutdown();
});

test('a failure to write a command to the guest ends the run as agent_error', async () => {
  const h = harness({ '*': sessionScript({ sendFails: true }) }, { bootTimeoutMs: 300 });
  await h.sup.start();
  const { id } = await startSession(h);
  ok(h.sup.submitCommand(id, { cmd: 'snapshot', id: 'a' }));
  const v = await finished(h, id);
  assert.equal(v.reason, 'agent_error');
  await idle(h);
  await h.sup.shutdown();
});

test('the agent rejecting a command (bad_command) fails the run as agent_error', async () => {
  const h = harness(
    { '*': sessionScript({ onCommand: (_c, vm) => vm.finish(status('bad_command')) }) },
    { bootTimeoutMs: 300 },
  );
  await h.sup.start();
  const { id } = await startSession(h);
  ok(h.sup.submitCommand(id, { cmd: 'snapshot', id: 'a' }));
  const v = await finished(h, id);
  assert.equal(v.state, 'failed');
  assert.equal(v.reason, 'agent_error');
  assert.equal(v.agent_status, 'bad_command');
  await idle(h);
  await h.sup.shutdown();
});

test('an error code from the guest is passed on only if it is a short lowercase token', async () => {
  const replies = ['ref_not_found', '<script>alert(1)</script>', 'x'.repeat(100)];
  let n = 0;
  const h = harness(
    { '*': sessionScript({ onCommand: (c, vm) => vm.push(cmdResult(String(c.id), false, replies[n++])) }) },
    { bootTimeoutMs: 300 },
  );
  await h.sup.start();
  const { id } = await startSession(h);
  for (const cid of ['a', 'b', 'c']) {
    ok(h.sup.submitCommand(id, { cmd: 'snapshot', id: cid }));
    await waitFor(() => statusesOf(h, id, cid).includes('error'));
  }
  const errs = commandEvents(h, id).filter((e) => e.status === 'error').map((e) => e.error);
  assert.deepEqual(errs, ['ref_not_found', 'unknown', 'unknown']);
  h.sup.cancel(id);
  await finished(h, id);
  await h.sup.shutdown();
});

test('forged control lines do nothing: wrong shape, wrong id, oversized, or in a one-shot run', async () => {
  const forged = [
    JSON.stringify({ type: 'event', kind: 'session_ready' }), // wrong type
    JSON.stringify({ type: 'evidence', kind: 'cmd_result', id: 'ghost', ok: true }), // no such command in flight
    JSON.stringify({ type: 'evidence', kind: 'cmd_result', id: 5, ok: true }),
    JSON.stringify({ type: 'evidence', kind: 'cmd_result', id: 'x', ok: 'yes' }),
    JSON.stringify({ type: 'evidence', kind: 'page', text: '{"type":"evidence","kind":"session_ready"}' }), // inside page text
    JSON.stringify({ type: 'evidence', kind: 'session_ready', pad: 'x'.repeat(5000) }), // too long to be the real thing
  ];
  const h = harness({ '/forged': { lines: [...forged, ...forged, OK_STATUS] }, '/s': { lines: forged, hang: true } }, { bootTimeoutMs: 300 });
  await h.sup.start();

  // a one-shot run never enters the session state
  const one = h.sup.submit(URL_OF('/forged')).run_id;
  const v = await finished(h, one);
  assert.equal(v.state, 'done');
  assert.ok(!statesOf(h, one).includes('session'));

  // a session that was not told "ready" stays in running
  const s = h.sup.submit(URL_OF('/s'), LIMITS).run_id;
  await waitFor(() => h.sup.get(s)?.state === 'running');
  const evidenceCount = () => eventsOf(h, s).filter((e) => e.type === 'evidence').length;
  await waitFor(() => evidenceCount() === forged.length, 5000);
  await sleep(40); // time for a forged line to act, if it could
  assert.equal(h.sup.get(s)?.state, 'running');
  assert.equal(evidenceCount(), forged.length, 'forged lines are still plain evidence');
  h.sup.cancel(s);
  await finished(h, s);
  await idle(h);
  await h.sup.shutdown();
});

test('a collector answer for a command that is not in flight is ignored', async () => {
  const h = harness({ '*': sessionScript({ silent: true }) }, { bootTimeoutMs: 300, commandTimeoutMs: 400 });
  await h.sup.start();
  const { id, vm } = await startSession(h);
  ok(h.sup.submitCommand(id, { cmd: 'snapshot', id: 'a' }));
  ok(h.sup.submitCommand(id, { cmd: 'snapshot', id: 'b' }));
  vm.push(cmdResult('b')); // b is only queued
  await sleep(30);
  assert.deepEqual(statusesOf(h, id, 'b'), ['accepted']);
  assert.equal(vm.sent.length, 1);
  vm.push(cmdResult('a'));
  await waitFor(() => vm.sent.length === 2);
  h.sup.cancel(id);
  await finished(h, id);
  await h.sup.shutdown();
});

test('a malformed answer for the command in flight does not count as success', async () => {
  const h = harness({ '*': sessionScript({ silent: true }) }, { bootTimeoutMs: 300, commandTimeoutMs: 1000 });
  await h.sup.start();
  const { id, vm } = await startSession(h);
  ok(h.sup.submitCommand(id, { cmd: 'snapshot', id: 'a' }));
  vm.push(JSON.stringify({ type: 'evidence', v: 1, kind: 'cmd_result', id: 'a', ok: 'yes' }));
  vm.push(JSON.stringify({ type: 'evidence', v: 1, kind: 'cmd_result', id: 'a' }));
  vm.push(JSON.stringify({ type: 'evidence', v: 1, kind: 'cmd_result', id: 'a', ok: 1 }));
  await sleep(40);
  assert.deepEqual(statusesOf(h, id, 'a'), ['accepted', 'sent']);
  vm.push(cmdResult('a'));
  await waitFor(() => statusesOf(h, id, 'a').includes('done'));
  h.sup.cancel(id);
  await finished(h, id);
  await h.sup.shutdown();
});

test('session slots: a second session waits, plain runs pass it, and it starts when the first ends', async () => {
  const h = harness(
    { '/s1': sessionScript(), '/s2': sessionScript(), '/plain': { lines: [OK_STATUS] } },
    { concurrency: 3, sessionSlots: 1, bootTimeoutMs: 300 },
  );
  await h.sup.start();
  const first = await startSession(h, '/s1');
  const second = h.sup.submit(URL_OF('/s2'), LIMITS).run_id;
  const plain = h.sup.submit(URL_OF('/plain')).run_id;
  assert.equal((await finished(h, plain)).state, 'done', 'a plain run is not held up by a waiting session');
  assert.equal(h.sup.get(second)?.state, 'queued');
  assert.equal(h.sup.get(second)?.position, 1);
  assert.deepEqual(h.sup.health().sessions, { running: 1, limit: 1 });

  ok(h.sup.submitCommand(first.id, { cmd: 'close', id: 'bye' }));
  await finished(h, first.id);
  await waitFor(() => h.sup.get(second)?.state === 'session');
  assert.deepEqual(h.sup.health().sessions, { running: 1, limit: 1 });
  h.sup.cancel(second);
  await finished(h, second);
  assert.deepEqual(h.sup.health().sessions, { running: 0, limit: 1 });
  await idle(h);
  await h.sup.shutdown();
});

test('sessions can be switched off: a session request is refused instead of waiting forever', async () => {
  const h = harness({}, { sessionSlots: 0 });
  await h.sup.start();
  assert.throws(() => h.sup.submit(URL_OF('/s'), LIMITS), SessionsDisabledError);
  assert.doesNotThrow(() => h.sup.submit(URL_OF('/plain')));
  await h.sup.shutdown();
});

test('recovery: a session that was alive at restart fails, and its open commands are voided in the log', async () => {
  const h = harness({ '*': { lines: [OK_STATUS] } });
  const id = '44444444-4444-4444-8444-444444444444';
  const now = Date.now();
  h.store.insert(id, URL_OF('/dead'), now - 1000, now + 100000, LIMITS);
  h.store.update(id, { state: 'session', slot: 0, startedAt: now - 900 });
  const cmdEvent = (seq: number, command_id: string, st: string) =>
    h.results.append(id, { seq, type: 'command', data: JSON.stringify({ command_id, cmd: 'download', status: st, risk: 'risky', command_sha256: 'ab'.repeat(32) }) });
  cmdEvent(1, 'waiting', 'awaiting_approval');
  cmdEvent(2, 'sent-one', 'sent');
  cmdEvent(3, 'finished', 'sent');
  cmdEvent(4, 'finished', 'done');
  await h.sup.start();
  const v = h.sup.get(id)!;
  assert.equal(v.state, 'failed');
  assert.equal(v.reason, 'supervisor_restart');
  const last = new Map(commandEvents(h, id).map((e) => [e.command_id, e.status]));
  assert.deepEqual([...last], [['waiting', 'voided'], ['sent-one', 'voided'], ['finished', 'done']]);
  await h.sup.shutdown();
});

test('a queued session survives a restart with its limits', async () => {
  const h = harness({ '*': sessionScript() }, { bootTimeoutMs: 300 });
  const id = '55555555-5555-4555-8555-555555555555';
  const now = Date.now();
  h.store.insert(id, URL_OF('/queued'), now - 100, now + 100000, { idleMs: 7000, maxMs: 9000 });
  assert.deepEqual(h.store.get(id)?.session, { idleMs: 7000, maxMs: 9000 });
  await h.sup.start();
  await waitFor(() => h.sup.get(id)?.state === 'session');
  assert.deepEqual(JSON.parse(h.backend.vmByRun.get(id)!.job).session, { max_s: 9 });
  h.sup.cancel(id);
  await finished(h, id);
  await h.sup.shutdown();
});

test('shutdown while a session is open voids its commands and leaves nothing behind', async () => {
  const h = harness({ '*': sessionScript({ silent: true }) }, { bootTimeoutMs: 300, shutdownGraceMs: 80 });
  await h.sup.start();
  const { id } = await startSession(h);
  ok(h.sup.submitCommand(id, { cmd: 'download', id: 'd', snap: 1, ref: 'e1' }));
  await h.sup.shutdown();
  assert.equal(h.sup.get(id)?.reason, 'supervisor_restart');
  assert.deepEqual(statusesOf(h, id, 'd'), ['accepted', 'awaiting_approval', 'voided']);
  h.backend.assertClean();
});
