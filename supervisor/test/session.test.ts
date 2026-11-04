import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sha256Hex } from '../src/commands.ts';
import { SessionCommands } from '../src/session.ts';
import type { SessionOptions, SubmitResult } from '../src/session.ts';
import type { RunError } from '../src/types.ts';
import { sleep } from './helpers.ts';

type Ev = Record<string, unknown>;

function make(over: Partial<SessionOptions> = {}) {
  const sent: string[] = [];
  const events: Ev[] = [];
  const aborts: RunError[] = [];
  const s = new SessionCommands({
    idleMs: 10_000,
    commandMax: 50,
    commandTimeoutMs: 10_000,
    approvalTtlMs: 10_000,
    now: Date.now,
    send: (l) => sent.push(l),
    emit: (d) => events.push(d),
    abort: (e) => aborts.push(e),
    ...over,
  });
  const statuses = (id: string) => events.filter((e) => e.command_id === id).map((e) => e.status);
  const accepted = (r: SubmitResult) => {
    assert.ok(r.ok, JSON.stringify(r));
    return r;
  };
  return { s, sent, events, aborts, statuses, accepted };
}

const snap = (id: string) => ({ cmd: 'snapshot', id });
const download = (id: string) => ({ cmd: 'download', id, snap: 1, ref: 'e2' });

test('commands are refused until the collector says the session is ready, and after it ended', () => {
  const t = make();
  const r = t.s.submit(snap('a'));
  assert.ok(!r.ok && r.code === 'not_session');
  assert.equal(t.s.markReady(), true);
  assert.equal(t.s.markReady(), false, 'ready only counts once');
  t.accepted(t.s.submit(snap('a')));
  t.s.end();
  const after = t.s.submit(snap('b'));
  assert.ok(!after.ok && after.code === 'not_session');
  assert.equal(t.sent.length, 1);
});

test('safe commands go to the guest one at a time, in order, as their canonical form', () => {
  const t = make();
  t.s.markReady();
  const a = t.accepted(t.s.submit({ id: 'a', dy: 100, cmd: 'scroll' }));
  t.accepted(t.s.submit(snap('b')));
  t.accepted(t.s.submit({ cmd: 'wait', id: 'c', ms: 5 }));
  assert.deepEqual(t.sent, ['{"cmd":"scroll","dy":100,"id":"a"}'], 'only the first is in flight');
  assert.equal(a.command_sha256, sha256Hex(t.sent[0]!));
  assert.equal(t.s.onResult('a', true), true);
  assert.deepEqual(t.sent.length, 2);
  assert.equal(t.sent[1], '{"cmd":"snapshot","id":"b"}');
  t.s.onResult('b', true);
  t.s.onResult('c', true);
  assert.equal(t.sent.length, 3);
  assert.deepEqual(t.statuses('a'), ['accepted', 'sent', 'done']);
  assert.deepEqual(t.statuses('c'), ['accepted', 'sent', 'done']);
});

test('the first event of a command carries the command itself, later ones do not', () => {
  const t = make();
  t.s.markReady();
  t.accepted(t.s.submit({ cmd: 'scroll', id: 'a', dy: 7 }));
  assert.deepEqual(t.events[0]!.command, { cmd: 'scroll', dy: 7, id: 'a' });
  assert.ok(t.events.slice(1).every((e) => !('command' in e)));
  assert.equal(t.events[0]!.risk, 'safe');
});

test('results only count for the command in flight', () => {
  const t = make();
  t.s.markReady();
  t.accepted(t.s.submit(snap('a')));
  t.accepted(t.s.submit(snap('b')));
  assert.equal(t.s.onResult('b', true), false, 'b is queued, not in flight');
  assert.equal(t.s.onResult('zzz', true), false);
  assert.equal(t.s.onResult('a', false, 'ref_not_found'), true);
  assert.equal(t.s.onResult('a', true), false, 'a second answer for the same command');
  assert.deepEqual(t.statuses('a'), ['accepted', 'sent', 'error']);
  assert.equal(t.events.find((e) => e.status === 'error')!.error, 'ref_not_found');
  assert.equal(t.sent.length, 2, 'b was sent after a finished');
});

test('a risky command does not reach the guest until approved with the hash of its exact content', () => {
  const t = make();
  t.s.markReady();
  const r = t.accepted(t.s.submit(download('d')));
  assert.equal(r.status, 'awaiting_approval');
  assert.equal(t.sent.length, 0);

  const wrong = t.s.approve('d', sha256Hex('something else'));
  assert.ok(!wrong.ok && wrong.code === 'hash_mismatch');
  assert.equal(t.sent.length, 0, 'a wrong hash approves nothing');
  const upper = t.s.approve('d', r.command_sha256.toUpperCase());
  assert.ok(!upper.ok && upper.code === 'hash_mismatch');
  const missing = t.s.approve('d', undefined);
  assert.ok(!missing.ok && missing.code === 'hash_mismatch');

  assert.deepEqual(t.s.approve('d', r.command_sha256), { ok: true });
  assert.deepEqual(t.sent, ['{"cmd":"download","id":"d","ref":"e2","snap":1}']);
  assert.deepEqual(t.statuses('d'), ['accepted', 'awaiting_approval', 'approved', 'sent']);
});

test('an approval is one-time', () => {
  const t = make();
  t.s.markReady();
  const r = t.accepted(t.s.submit(download('d')));
  assert.ok(t.s.approve('d', r.command_sha256).ok);
  const again = t.s.approve('d', r.command_sha256);
  assert.ok(!again.ok && again.code === 'not_waiting');
  t.s.onResult('d', true);
  const late = t.s.approve('d', r.command_sha256);
  assert.ok(!late.ok && late.code === 'not_waiting');
  assert.equal(t.sent.length, 1, 'the guest got the command once');
});

test('an approval is bound to its own command: the hash of another one does not work', () => {
  const t = make();
  t.s.markReady();
  const a = t.accepted(t.s.submit(download('a')));
  const b = t.accepted(t.s.submit({ cmd: 'download', id: 'b', snap: 1, ref: 'e9' }));
  assert.notEqual(a.command_sha256, b.command_sha256);
  const cross = t.s.approve('a', b.command_sha256);
  assert.ok(!cross.ok && cross.code === 'hash_mismatch');
  assert.equal(t.sent.length, 0);
  assert.ok(t.s.approve('b', b.command_sha256).ok);
  assert.equal(t.sent.length, 1);
  assert.match(t.sent[0]!, /"id":"b"/);
});

test('approving an unknown command is not_found; approving a safe command is not_waiting', () => {
  const t = make();
  t.s.markReady();
  const nf = t.s.approve('nope', sha256Hex('x'));
  assert.ok(!nf.ok && nf.code === 'not_found');
  const a = t.accepted(t.s.submit(snap('a')));
  const sf = t.s.approve('a', a.command_sha256);
  assert.ok(!sf.ok && sf.code === 'not_waiting');
});

test('an approved command goes to the end of the queue, not back to where it was received', () => {
  const t = make();
  t.s.markReady();
  t.accepted(t.s.submit(snap('first')));
  const risky = t.accepted(t.s.submit(download('risky')));
  t.accepted(t.s.submit(snap('second')));
  t.accepted(t.s.submit(snap('third')));
  t.s.approve('risky', risky.command_sha256);
  const order: string[] = [];
  for (const id of ['first', 'second', 'third', 'risky']) {
    order.push(JSON.parse(t.sent[t.sent.length - 1]!).id);
    t.s.onResult(id, true);
  }
  assert.deepEqual(order, ['first', 'second', 'third', 'risky']);
  assert.equal(t.sent.length, 4);
});

test('an approval that is not used in time expires, and then cannot be used', async () => {
  const t = make({ approvalTtlMs: 40 });
  t.s.markReady();
  const r = t.accepted(t.s.submit(download('d')));
  await sleep(90);
  assert.deepEqual(t.statuses('d'), ['accepted', 'awaiting_approval', 'expired']);
  const late = t.s.approve('d', r.command_sha256);
  assert.ok(!late.ok && late.code === 'expired');
  assert.equal(t.sent.length, 0);
  t.s.end();
});

test('expiry is also enforced at approval time if the timer has not fired yet', () => {
  let clock = 1000;
  const t = make({ approvalTtlMs: 100, now: () => clock });
  t.s.markReady();
  const r = t.accepted(t.s.submit(download('d')));
  clock = 1100;
  const late = t.s.approve('d', r.command_sha256);
  assert.ok(!late.ok && late.code === 'expired');
  assert.equal(t.sent.length, 0);
  assert.equal(t.statuses('d').at(-1), 'expired');
  t.s.end();
});

test('rejecting: waiting and queued commands can be rejected, sent ones cannot', () => {
  const t = make();
  t.s.markReady();
  const d = t.accepted(t.s.submit(download('d')));
  t.accepted(t.s.submit(snap('a')));
  t.accepted(t.s.submit(snap('b')));
  assert.ok(t.s.reject('d').ok, 'waiting for approval');
  assert.ok(t.s.reject('b').ok, 'queued, not yet sent');
  const sentOne = t.s.reject('a');
  assert.ok(!sentOne.ok && sentOne.code === 'too_late', 'a is in flight');
  const nf = t.s.reject('nope');
  assert.ok(!nf.ok && nf.code === 'not_found');
  const ap = t.s.approve('d', d.command_sha256);
  assert.ok(!ap.ok, 'a rejected command cannot be approved');
  t.s.onResult('a', true);
  assert.equal(t.sent.length, 1, 'the rejected queued command was never sent');
  const twice = t.s.reject('d');
  assert.ok(!twice.ok && twice.code === 'too_late');
  assert.deepEqual(t.statuses('b'), ['accepted', 'rejected']);
});

test('limits: duplicate ids, the command cap, malformed commands', () => {
  const t = make({ commandMax: 3 });
  t.s.markReady();
  t.accepted(t.s.submit(snap('a')));
  const dup = t.s.submit(snap('a'));
  assert.ok(!dup.ok && dup.code === 'duplicate_id');
  const bad = t.s.submit({ cmd: 'eval', id: 'x' });
  assert.ok(!bad.ok && bad.code === 'bad_command');
  t.accepted(t.s.submit(snap('b')));
  t.accepted(t.s.submit(snap('c')));
  const over = t.s.submit(snap('d'));
  assert.ok(!over.ok && over.code === 'limit');
  assert.equal(t.s.counts().total, 3);
});

test('no answer within the command timeout ends the run with reason timeout', async () => {
  const t = make({ commandTimeoutMs: 40 });
  t.s.markReady();
  t.accepted(t.s.submit(snap('a')));
  await sleep(90);
  assert.equal(t.aborts.length, 1);
  assert.equal(t.aborts[0]!.reason, 'timeout');
  assert.deepEqual(t.statuses('a'), ['accepted', 'sent', 'timeout']);
  t.s.end();
  assert.equal(t.statuses('a').at(-1), 'timeout', 'a timed-out command is not voided afterwards');
});

test('an answer in time cancels the command timeout', async () => {
  const t = make({ commandTimeoutMs: 40 });
  t.s.markReady();
  t.accepted(t.s.submit(snap('a')));
  t.s.onResult('a', true);
  await sleep(90);
  assert.equal(t.aborts.length, 0);
  t.s.end();
});

test('a failure to write to the guest ends the run as agent_error', () => {
  const t = make({
    send: () => {
      throw new Error('socket closed');
    },
  });
  t.s.markReady();
  t.accepted(t.s.submit(snap('a')));
  assert.equal(t.aborts.length, 1);
  assert.equal(t.aborts[0]!.reason, 'agent_error');
});

test('after a close is sent nothing else is accepted; a sent close counts as done when the session ends', () => {
  const t = make();
  t.s.markReady();
  t.accepted(t.s.submit({ cmd: 'close', id: 'bye' }));
  const more = t.s.submit(snap('x'));
  assert.ok(!more.ok && more.code === 'not_session');
  assert.equal(t.s.phase, 'closing');
  t.s.end();
  assert.deepEqual(t.statuses('bye'), ['accepted', 'sent', 'done']);
});

test('commands queued behind a close are voided when the session ends', () => {
  const t = make();
  t.s.markReady();
  t.accepted(t.s.submit(snap('a')));
  t.accepted(t.s.submit({ cmd: 'close', id: 'bye' }));
  t.accepted(t.s.submit(snap('after')));
  t.s.onResult('a', true);
  assert.match(t.sent.at(-1)!, /"cmd":"close"/);
  t.s.end();
  assert.equal(t.statuses('after').at(-1), 'voided');
  assert.equal(t.sent.length, 2, 'the command behind the close never reached the guest');
});

test('a command queued behind a close is never sent, even when the close is answered first', () => {
  const t = make();
  t.s.markReady();
  t.accepted(t.s.submit(snap('a')));
  t.accepted(t.s.submit({ cmd: 'close', id: 'bye' }));
  t.accepted(t.s.submit(snap('x'))); // accepted: the close has not been sent yet
  t.s.onResult('a', true);
  assert.match(t.sent.at(-1)!, /"cmd":"close"/);
  assert.equal(t.s.onResult('bye', true), true);
  assert.equal(t.sent.length, 2, 'nothing is sent after the close, even once it has been answered');
  t.s.end();
  assert.equal(t.statuses('x').at(-1), 'voided');
});

test('ending the session voids everything still open and silences all timers', async () => {
  const t = make({ approvalTtlMs: 40, commandTimeoutMs: 40, idleMs: 40 });
  t.s.markReady();
  t.accepted(t.s.submit(snap('a')));
  t.accepted(t.s.submit(snap('b')));
  const d = t.accepted(t.s.submit(download('d')));
  t.s.end();
  assert.deepEqual(t.statuses('a').at(-1), 'voided');
  assert.deepEqual(t.statuses('b').at(-1), 'voided');
  assert.deepEqual(t.statuses('d').at(-1), 'voided');
  const n = t.events.length;
  await sleep(120);
  assert.equal(t.events.length, n, 'no timer fired after the end');
  assert.equal(t.aborts.length, 0);
  const ap = t.s.approve('d', d.command_sha256);
  assert.ok(!ap.ok && ap.code === 'not_session');
  assert.equal(t.s.onResult('a', true), false);
  t.s.end(); // idempotent
  assert.equal(t.events.length, n);
});

test('idle: with nothing to do the supervisor closes the session itself', async () => {
  const t = make({ idleMs: 40 });
  t.s.markReady();
  await sleep(100);
  assert.equal(t.sent.length, 1);
  assert.equal(t.sent[0], '{"cmd":"close","id":"idle-close"}');
  const e = t.events.find((x) => x.command_id === 'idle-close')!;
  assert.equal(e.by, 'supervisor');
  assert.equal(t.s.phase, 'closing');
  t.s.end();
  assert.equal(t.statuses('idle-close').at(-1), 'done');
});

test('idle: the clock restarts after each command and stays stopped while a command is in flight', async () => {
  const t = make({ idleMs: 60 });
  t.s.markReady();
  t.accepted(t.s.submit(snap('a')));
  await sleep(120);
  assert.equal(t.sent.length, 1, 'no idle close while a is in flight');
  t.s.onResult('a', true);
  await sleep(30);
  assert.equal(t.sent.length, 1, 'the clock restarted from the result');
  await sleep(80);
  assert.equal(t.sent.length, 2);
  t.s.end();
});

test('idle: time spent waiting for a human approval is not idle time; afterwards the clock restarts', async () => {
  const t = make({ idleMs: 40, approvalTtlMs: 150 });
  t.s.markReady();
  t.accepted(t.s.submit(download('d')));
  await sleep(100);
  assert.equal(t.sent.length, 0, 'still waiting for the human, no idle close');
  await sleep(120); // approval expires at 150 ms, then 40 ms of idle
  assert.equal(t.statuses('d').at(-1), 'expired');
  assert.equal(t.sent.length, 1);
  assert.match(t.sent[0]!, /idle-close/);
  t.s.end();
});

test('idle: rejecting the only waiting command restarts the clock', async () => {
  const t = make({ idleMs: 40 });
  t.s.markReady();
  t.accepted(t.s.submit(download('d')));
  t.s.reject('d');
  await sleep(90);
  assert.equal(t.sent.length, 1);
  t.s.end();
});

test('the internal close picks a free id if a client already used the usual one', async () => {
  const t = make({ idleMs: 40 });
  t.s.markReady();
  t.accepted(t.s.submit(snap('idle-close')));
  t.s.onResult('idle-close', true);
  await sleep(90);
  assert.equal(t.sent.at(-1), '{"cmd":"close","id":"idle-close_"}');
  t.s.end();
});

test('counts report totals and waiting approvals', () => {
  const t = make();
  t.s.markReady();
  t.accepted(t.s.submit(snap('a')));
  t.accepted(t.s.submit(download('d1')));
  t.accepted(t.s.submit(download('d2')));
  assert.deepEqual(t.s.counts(), { total: 3, awaiting_approval: 2 });
  t.s.reject('d1');
  assert.deepEqual(t.s.counts(), { total: 3, awaiting_approval: 1 });
  t.s.end();
});
