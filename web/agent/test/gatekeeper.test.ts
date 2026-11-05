import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { COMMANDS, validateCommand } from '../commands.ts';
import { createGatekeeper, type Decision } from '../gatekeeper.ts';

const fixture = (name: string): unknown[] =>
  readFileSync(new URL(`./fixtures/${name}.ndjson`, import.meta.url), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

// ---- the command form: the supervisor's own fixture ------------------------------------------------------------------

test('the supervisor\'s fixture: every command it accepts is accepted here, every one it rejects is rejected', () => {
  const f = JSON.parse(readFileSync(new URL('../../../supervisor/testdata/canonical.json', import.meta.url), 'utf8')) as {
    valid: Array<{ canonical: string }>;
    invalid: Array<{ input: unknown; raw?: string }>;
  };
  assert.ok(f.valid.length > 40 && f.invalid.length > 90, 'the fixture is the real one');
  for (const c of f.valid) assert.equal(validateCommand(c.canonical).ok, true, `should accept ${c.canonical}`);
  for (const c of f.invalid) {
    const line = c.raw ?? JSON.stringify(c.input);
    assert.equal(validateCommand(line).ok, false, `should reject ${String(line).slice(0, 100)}`);
  }
});

test('validateCommand: edge cases', () => {
  const v = (s: string) => validateCommand(s);
  assert.deepEqual([v('{"cmd":"snapshot","id":"a"}').ok, (v('{"cmd":"snapshot","id":"a"}') as { risk: string }).risk], [true, 'safe']);
  assert.equal((v('{"cmd":"download","id":"a","snap":1,"ref":"e7"}') as { risk: string }).risk, 'risky');
  assert.deepEqual(v('{"cmd":"nope","id":"a"}'), { ok: false, error: 'unknown_command', id: 'a' });
  for (const name of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) assert.equal((v(`{"cmd":"${name}","id":"a"}`) as { error: string }).error, 'unknown_command', name);
  assert.equal((v('{"cmd":"snapshot","id":"a","extra":1}') as { error: string }).error, 'bad_command');
  assert.equal(v('{"cmd":"scroll","id":"a","dy":5001}').ok, false);
  assert.equal(v('{"cmd":"scroll","id":"a","dy":1.5}').ok, false);
  assert.equal(v('{"cmd":"scroll","id":"a","dy":"5"}').ok, false);
  assert.equal(v('{"cmd":"snapshot","id":"a b"}').ok, false);
  assert.equal(v('x'.repeat(5000)).ok, false);
  assert.equal(v('{"cmd":"submit_form","id":"a","snap":1,"form":"e3","values":{"e4":"x\\u0000"}}').ok, false);
  assert.equal(v('{"cmd":"submit_form","id":"a","snap":1,"form":"e3","values":{"name":"x"}}').ok, false);
  assert.equal(v('{"cmd":"open_link","id":"a","snap":1,"ref":"f1e3"}').ok, true);
  assert.equal(v('{"cmd":"open_link","id":"a","snap":1,"ref":"e3 "}').ok, false);
  assert.equal(v('{"cmd":"open_link","id":"a","snap":-1,"ref":"e3"}').ok, false);
  assert.equal(validateCommand(5).ok, false);
  assert.equal(validateCommand(null).ok, false);
  assert.deepEqual(Object.keys(COMMANDS).sort(), ['back', 'close', 'download', 'open_link', 'screenshot', 'scroll', 'snapshot', 'submit_form', 'wait']);
});

// ---- the gatekeeper ---------------------------------------------------------------------------------------------------

const snapshot = (snap: number) => ({ type: 'evidence', v: 1, kind: 'snapshot', t: 0, snap, text: '- generic', lines: 1, truncated: false });
const links = (snap: number, ...refs: string[]) => ({ type: 'evidence', v: 1, kind: 'links', t: 0, snap, links: refs.map((ref) => ({ ref, text: 'x', href: 'https://x.example/', origin_differs: true })) });
const ok = (d: Decision) => {
  assert.equal(d.ok, true, JSON.stringify(d));
  return d as Extract<Decision, { ok: true }>;
};
const reason = (d: Decision) => (d.ok ? 'ok' : d.reason);

function seen(...events: unknown[]) {
  const g = createGatekeeper();
  for (const e of events) g.observe(e);
  return g;
}

test('safe actions: the command is built by the gatekeeper, with its own id and the current snapshot', () => {
  const g = seen(snapshot(1), links(1, 'e3', 'f1e5'));
  const a = ok(g.decide({ action: 'snapshot' }));
  assert.deepEqual(a.command, { cmd: 'snapshot', id: 'a1' });
  assert.equal(a.risk, 'safe');
  assert.equal(a.needsApproval, false);
  const b = ok(g.decide({ action: 'open_link', ref: 'e3' }));
  assert.deepEqual(b.command, { cmd: 'open_link', id: 'a2', snap: 1, ref: 'e3' });
  assert.equal(b.line, '{"cmd":"open_link","id":"a2","snap":1,"ref":"e3"}');
  assert.deepEqual(ok(g.decide({ action: 'scroll', dy: -400 })).command, { cmd: 'scroll', id: 'a3', dy: -400 });
  assert.deepEqual(ok(g.decide({ action: 'wait', ms: 1500 })).command, { cmd: 'wait', id: 'a4', ms: 1500 });
  assert.deepEqual(ok(g.decide({ action: 'screenshot' })).command, { cmd: 'screenshot', id: 'a5' });
  assert.equal(reason(g.decide({ action: 'back' })), 'step_limit', 'five steps by default');
});

test('a download is allowed to be proposed, and is always marked as needing a person', () => {
  const g = seen(snapshot(2), links(2, 'e7'));
  const d = ok(g.decide({ action: 'download', ref: 'e7' }));
  assert.equal(d.risk, 'risky');
  assert.equal(d.needsApproval, true);
  assert.deepEqual(d.command, { cmd: 'download', id: 'a1', snap: 2, ref: 'e7' });
});

test('what a model may not do at all', () => {
  const g = seen(snapshot(1), links(1, 'e1'));
  assert.equal(reason(g.decide({ action: 'submit_form', form: 'e1', values: { e2: 'x' } })), 'not_allowed_for_model');
  assert.equal(reason(g.decide({ action: 'close' })), 'not_allowed_for_model');
  for (const action of ['eval', 'goto', 'click', 'type', 'navigate', '__proto__', 'constructor', '', 'SNAPSHOT', 'snapshot ']) {
    assert.equal(reason(g.decide({ action })), 'unknown_action', action);
  }
  assert.equal(g.state().steps, 0, 'refusals cost no steps');
});

test('the model cannot choose an id, a snapshot number or a command name', () => {
  const g = seen(snapshot(4), links(4, 'e1'));
  assert.equal(reason(g.decide({ action: 'open_link', ref: 'e1', snap: 1 })), 'bad_params');
  assert.equal(reason(g.decide({ action: 'open_link', ref: 'e1', id: 'x' })), 'bad_params');
  assert.equal(reason(g.decide({ action: 'open_link', ref: 'e1', cmd: 'download' })), 'bad_params');
  assert.equal(reason(g.decide({ action: 'snapshot', extra: 1 })), 'bad_params');
  assert.equal(reason(g.decide(JSON.parse('{"action":"snapshot","__proto__":{"x":1}}'))), 'bad_params');
  assert.equal(({} as Record<string, unknown>).x, undefined, 'no prototype was polluted');
});

test('a link must be one the last snapshot showed', () => {
  const g = seen();
  assert.equal(reason(g.decide({ action: 'open_link', ref: 'e1' })), 'no_snapshot');
  g.observe(snapshot(1));
  assert.equal(reason(g.decide({ action: 'open_link', ref: 'e1' })), 'ref_not_in_links', 'the links of the snapshot have not arrived');
  g.observe(links(1, 'e1', 'e2'));
  assert.equal(reason(g.decide({ action: 'open_link', ref: 'e9' })), 'ref_not_in_links');
  ok(g.decide({ action: 'open_link', ref: 'e2' }));
  // the page changed: a new snapshot makes the old references dead
  g.observe(snapshot(2));
  assert.equal(reason(g.decide({ action: 'open_link', ref: 'e1' })), 'ref_not_in_links');
  g.observe(links(2, 'e1'));
  assert.deepEqual(ok(g.decide({ action: 'open_link', ref: 'e1' })).command.snap, 2);
});

test('links of another snapshot, an older snapshot, or malformed references change nothing', () => {
  const g = seen(snapshot(3), links(3, 'e1'));
  g.observe(links(2, 'e8'));
  assert.deepEqual(g.state().refs, ['e1'], 'links of another snapshot are not taken');
  g.observe(snapshot(1));
  assert.equal(g.state().snap, 3, 'an older snapshot does not replace the current one');
  g.observe({ ...links(3), links: ['e1', 'not a ref', 5, null, 'e2;drop', 'E3', 'e', 'e1e1'].map((ref) => ({ ref, text: 'x' })) });
  assert.deepEqual(g.state().refs, ['e1']);
  assert.equal(g.state().snap, 3);
  assert.equal(reason(g.decide({ action: 'open_link', ref: 'e8' })), 'ref_not_in_links');
});

test('the same step twice is refused', () => {
  const g = seen(snapshot(1), links(1, 'e1'));
  ok(g.decide({ action: 'open_link', ref: 'e1' }));
  assert.equal(reason(g.decide({ action: 'open_link', ref: 'e1' })), 'repeat');
  assert.equal(ok(g.decide({ action: 'download', ref: 'e1' })).needsApproval, true, 'a download of the same link is a different step');
});

test('parameters are checked, not repaired', () => {
  const g = seen(snapshot(1), links(1, 'e1'));
  for (const p of [
    { action: 'scroll' }, { action: 'scroll', dy: 3001 }, { action: 'scroll', dy: -3001 }, { action: 'scroll', dy: 1.5 }, { action: 'scroll', dy: '10' },
    { action: 'scroll', dy: null }, { action: 'scroll', dy: NaN }, { action: 'scroll', dy: Infinity },
    { action: 'wait' }, { action: 'wait', ms: -1 }, { action: 'wait', ms: 3001 }, { action: 'wait', ms: 1.5 },
    { action: 'open_link' }, { action: 'open_link', ref: 5 }, { action: 'open_link', ref: 'e1 ' }, { action: 'open_link', ref: '../e1' },
    { action: 'open_link', ref: ['e1'] }, { action: 'screenshot', full: true },
  ]) {
    assert.equal(reason(g.decide(p)), 'bad_params', JSON.stringify(p));
  }
  ok(g.decide({ action: 'scroll', dy: 3000 }));
  ok(g.decide({ action: 'wait', ms: 0 }));
});

test('proposals that are not proposals', () => {
  const g = seen(snapshot(1));
  for (const p of [null, undefined, 5, 'snapshot', [], ['snapshot'], true, {}, { action: 5 }, { action: null }, { action: ['snapshot'] }]) {
    assert.equal(reason(g.decide(p)), 'bad_proposal', JSON.stringify(p));
  }
});

test('the number of steps is limited', () => {
  const g = createGatekeeper({ maxSteps: 2 });
  ok(g.decide({ action: 'snapshot' }));
  ok(g.decide({ action: 'snapshot' }));
  assert.equal(reason(g.decide({ action: 'snapshot' })), 'step_limit');
  assert.equal(g.state().steps, 2);
});

test('a refusal does not use the id or a step', () => {
  const g = seen(snapshot(1), links(1, 'e1'));
  g.decide({ action: 'open_link', ref: 'e9' });
  g.decide({ action: 'scroll', dy: 99999 });
  assert.equal(ok(g.decide({ action: 'snapshot' })).command.id, 'a1');
  assert.equal(g.state().steps, 1);
});

test('garbage in the evidence is ignored', () => {
  const g = createGatekeeper();
  for (const e of [null, 5, 'x', [], {}, { kind: 'snapshot' }, { kind: 'snapshot', snap: 'x' }, { kind: 'snapshot', snap: -1 }, { kind: 'snapshot', snap: 1.5 }, { kind: 'links', snap: 1, links: 'x' }]) g.observe(e);
  assert.deepEqual(g.state(), { snap: null, refs: [], steps: 0 });
});

// ---- with what the real collector reported ---------------------------------------------------------------------------

test('on a real page: a link the collector listed can be followed, one it did not cannot', () => {
  const g = createGatekeeper();
  for (const e of fixture('plain')) g.observe(e);
  const refs = g.state().refs;
  assert.ok(refs.length >= 1, 'the page has a link');
  const d = ok(g.decide({ action: 'open_link', ref: refs[0] }));
  assert.equal(d.command.snap, g.state().snap);
  assert.equal(reason(g.decide({ action: 'open_link', ref: 'e99999' })), 'ref_not_in_links');
});

test('on a real page whose links were cut by the hooks the references are still usable data, nothing else', () => {
  const g = createGatekeeper();
  for (const e of fixture('login')) g.observe(e);
  assert.equal(g.state().snap, 1);
});

// ---- the property that matters: whatever the gatekeeper lets out, the supervisor accepts ------------------------------

test('whatever the gatekeeper produces passes the supervisor\'s check and is a safe command or a marked risky one', () => {
  const g = seen(snapshot(7), links(7, 'e1', 'e2', 'f1e3'));
  const values: unknown[] = [undefined, null, 0, 1, -1, 5, 3000, -3000, 3001, 1.5, 'e1', 'e2', 'f1e3', 'e9', '', 'x', {}, [], true, NaN];
  const actions = ['snapshot', 'scroll', 'wait', 'screenshot', 'open_link', 'back', 'download', 'close', 'submit_form', 'eval', '__proto__'];
  let produced = 0;
  for (let i = 0; i < 3000; i++) {
    const p: Record<string, unknown> = { action: actions[i % actions.length] };
    if (i % 3 === 0) p.dy = values[(i * 7) % values.length];
    if (i % 5 === 0) p.ms = values[(i * 11) % values.length];
    if (i % 2 === 0) p.ref = values[(i * 13) % values.length];
    const gate = createGatekeeper({ maxSteps: 1 });
    for (const e of [snapshot(7), links(7, 'e1', 'e2', 'f1e3')]) gate.observe(e);
    const d = gate.decide(p);
    if (!d.ok) continue;
    produced++;
    const v = validateCommand(d.line);
    assert.equal(v.ok, true, d.line);
    assert.ok(['snapshot', 'scroll', 'wait', 'screenshot', 'open_link', 'back', 'download'].includes(String(d.command.cmd)), d.line);
    assert.equal(d.needsApproval, d.command.cmd === 'download');
    if ('ref' in d.command) assert.ok(['e1', 'e2', 'f1e3'].includes(String(d.command.ref)));
  }
  assert.ok(produced > 100, `${produced} commands produced`);
  void g;
});
