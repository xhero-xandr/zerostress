import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { COMMANDS, canonicalJson, sameDigest, sha256Hex, validateCommand } from '../src/commands.ts';

const ok = (raw: unknown) => {
  const r = validateCommand(raw);
  assert.ok(r.ok, JSON.stringify(r));
  return r.command;
};
const bad = (raw: unknown, part: string) => {
  const r = validateCommand(raw);
  assert.ok(!r.ok, `accepted: ${JSON.stringify(raw).slice(0, 80)}`);
  assert.match(r.error, new RegExp(part), JSON.stringify(raw).slice(0, 80));
};

test('every command type is accepted with its parameters, risk follows the type', () => {
  const cases: [Record<string, unknown>, 'safe' | 'risky'][] = [
    [{ cmd: 'snapshot', id: 'a' }, 'safe'],
    [{ cmd: 'scroll', id: 'a', dy: -5000 }, 'safe'],
    [{ cmd: 'scroll', id: 'a', dy: 5000 }, 'safe'],
    [{ cmd: 'wait', id: 'a', ms: 0 }, 'safe'],
    [{ cmd: 'wait', id: 'a', ms: 5000 }, 'safe'],
    [{ cmd: 'screenshot', id: 'a' }, 'safe'],
    [{ cmd: 'screenshot', id: 'a', full: true }, 'safe'],
    [{ cmd: 'open_link', id: 'a', snap: 3, ref: 'e7' }, 'safe'],
    [{ cmd: 'open_link', id: 'a', snap: 3, ref: 'f1e3' }, 'safe'],
    [{ cmd: 'back', id: 'a' }, 'safe'],
    [{ cmd: 'close', id: 'a' }, 'safe'],
    [{ cmd: 'download', id: 'a', snap: 1, ref: 'e2' }, 'risky'],
    [{ cmd: 'submit_form', id: 'a', snap: 1, form: 'e4', values: { e5: 'x', e6: 'y' } }, 'risky'],
    [{ cmd: 'submit_form', id: 'a', snap: 1, form: 'e4', values: {} }, 'risky'],
  ];
  for (const [raw, risk] of cases) assert.equal(ok(raw).risk, risk, JSON.stringify(raw));
  // the table and the cases above cover the same set
  assert.deepEqual(new Set(cases.map(([c]) => c.cmd)), new Set(Object.keys(COMMANDS)));
});

test('only download and submit_form are risky', () => {
  const risky = Object.entries(COMMANDS).filter(([, s]) => s.risk === 'risky').map(([n]) => n).sort();
  assert.deepEqual(risky, ['download', 'submit_form']);
});

test('unknown types and non-objects are rejected, including inherited names', () => {
  for (const cmd of ['eval', 'evaluate', 'goto', 'click', 'constructor', '__proto__', 'toString', 'hasOwnProperty', '', 'SNAPSHOT']) {
    bad({ cmd, id: 'a' }, 'unknown command type');
  }
  for (const raw of [null, 5, 'snapshot', [], [{ cmd: 'snapshot', id: 'a' }], true]) bad(raw, 'JSON object');
  bad({ id: 'a' }, 'unknown command type');
  bad({ cmd: 5, id: 'a' }, 'unknown command type');
});

test('id must match the pattern', () => {
  for (const id of ['', 'a b', 'a/b', 'a.b', 'é', 'x'.repeat(65), 5, null, undefined, 'a\n']) {
    bad({ cmd: 'snapshot', id }, 'id must match');
  }
  ok({ cmd: 'snapshot', id: 'A-z_0-9' });
  ok({ cmd: 'snapshot', id: 'x'.repeat(64) });
});

test('unknown, missing and misplaced fields are rejected', () => {
  bad({ cmd: 'snapshot', id: 'a', extra: 1 }, 'unknown field: extra');
  bad({ cmd: 'scroll', id: 'a', dy: 1, ms: 2 }, 'unknown field: ms');
  bad({ cmd: 'scroll', id: 'a' }, 'missing field: dy');
  bad({ cmd: 'open_link', id: 'a', ref: 'e1' }, 'missing field: snap');
  bad({ cmd: 'open_link', id: 'a', snap: 1 }, 'missing field: ref');
  bad({ cmd: 'submit_form', id: 'a', snap: 1, form: 'e1' }, 'missing field: values');
  bad({ cmd: 'download', id: 'a', snap: 1, ref: 'e1', url: 'https://evil.test/' }, 'unknown field: url');
  // a raw JSON "__proto__" key is an own property after JSON.parse and must not slip through
  bad(JSON.parse('{"cmd":"snapshot","id":"a","__proto__":{"x":1}}'), 'unknown field: __proto__');
});

test('numeric parameters are integers inside their ranges', () => {
  bad({ cmd: 'scroll', id: 'a', dy: 5001 }, 'dy must be an integer');
  bad({ cmd: 'scroll', id: 'a', dy: -5001 }, 'dy must be an integer');
  bad({ cmd: 'scroll', id: 'a', dy: 1.5 }, 'dy must be an integer');
  bad({ cmd: 'scroll', id: 'a', dy: '10' }, 'dy must be an integer');
  bad({ cmd: 'scroll', id: 'a', dy: Number.NaN }, 'dy must be an integer');
  bad({ cmd: 'scroll', id: 'a', dy: Number.POSITIVE_INFINITY }, 'dy must be an integer');
  bad({ cmd: 'wait', id: 'a', ms: -1 }, 'ms must be an integer');
  bad({ cmd: 'wait', id: 'a', ms: 5001 }, 'ms must be an integer');
  bad({ cmd: 'open_link', id: 'a', snap: -1, ref: 'e1' }, 'snap must be an integer');
  bad({ cmd: 'open_link', id: 'a', snap: 1e12, ref: 'e1' }, 'snap must be an integer');
  bad({ cmd: 'screenshot', id: 'a', full: 'yes' }, 'full must be true or false');
});

test('element references have a fixed shape', () => {
  for (const r of ['', 'e', '7', 'e-1', 'E7', ' e7', 'e7 ', 'e7;x', 'a1', 'f1', 'e1e2', 'f99999e1', 'e1234567890', 5, null, ['e1']]) {
    bad({ cmd: 'open_link', id: 'a', snap: 1, ref: r }, 'ref must be an element reference');
  }
  bad({ cmd: 'submit_form', id: 'a', snap: 1, form: 'form-1', values: {} }, 'form must be an element reference');
});

test('form values: limited count, length, characters and key shape', () => {
  const many = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`e${i}`, 'x']));
  bad({ cmd: 'submit_form', id: 'a', snap: 1, form: 'e1', values: many }, 'at most 20 fields');
  const twenty = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`e${i}`, 'x']));
  ok({ cmd: 'submit_form', id: 'a', snap: 1, form: 'e1', values: twenty });
  bad({ cmd: 'submit_form', id: 'a', snap: 1, form: 'e1', values: { e2: 'x'.repeat(101) } }, 'at most 100 characters');
  ok({ cmd: 'submit_form', id: 'a', snap: 1, form: 'e1', values: { e2: 'x'.repeat(100) } });
  for (const v of ['a\nb', 'a\u0000b', 'a\u001fb', 'a\u007fb', 'a\u0085b', 'a\tb']) {
    bad({ cmd: 'submit_form', id: 'a', snap: 1, form: 'e1', values: { e2: v } }, 'control characters');
  }
  bad({ cmd: 'submit_form', id: 'a', snap: 1, form: 'e1', values: { e2: 5 } }, 'must be strings');
  bad({ cmd: 'submit_form', id: 'a', snap: 1, form: 'e1', values: { 'name': 'x' } }, 'keys must be element references');
  bad({ cmd: 'submit_form', id: 'a', snap: 1, form: 'e1', values: ['x'] }, 'must be an object');
  bad({ cmd: 'submit_form', id: 'a', snap: 1, form: 'e1', values: null }, 'must be an object');
  // non-ASCII text is fine
  ok({ cmd: 'submit_form', id: 'a', snap: 1, form: 'e1', values: { e2: 'Привет 日本語 😀' } });
});

test('canonical form: sorted keys at every level, no whitespace, same for any input order', () => {
  const a = ok({ values: { e6: 'b', e5: 'a' }, cmd: 'submit_form', id: 'x', form: 'e4', snap: 2 });
  const b = ok({ snap: 2, form: 'e4', id: 'x', cmd: 'submit_form', values: { e5: 'a', e6: 'b' } });
  assert.equal(a.canonical, '{"cmd":"submit_form","form":"e4","id":"x","snap":2,"values":{"e5":"a","e6":"b"}}');
  assert.equal(a.canonical, b.canonical);
  assert.equal(a.sha256, b.sha256);
  assert.equal(a.sha256, createHash('sha256').update(a.canonical).digest('hex'));
  assert.equal(canonicalJson([1, 'a', { b: [], a: null }]), '[1,"a",{"a":null,"b":[]}]');
  assert.equal(canonicalJson('é"\\'), '"é\\"\\\\"');
});

test('any change to any field changes the hash', () => {
  const base = { cmd: 'submit_form', id: 'x', snap: 2, form: 'e4', values: { e5: 'a' } };
  const hashes = new Set([ok(base).sha256]);
  for (const changed of [
    { ...base, id: 'y' },
    { ...base, snap: 3 },
    { ...base, form: 'e5' },
    { ...base, values: { e5: 'b' } },
    { ...base, values: { e5: 'a', e6: '' } },
    { ...base, values: { e6: 'a' } },
  ]) hashes.add(ok(changed).sha256);
  assert.equal(hashes.size, 7);
});

test('known digest', () => {
  assert.equal(sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(ok({ cmd: 'back', id: 'a' }).canonical, '{"cmd":"back","id":"a"}');
  assert.equal(ok({ cmd: 'back', id: 'a' }).sha256, sha256Hex('{"cmd":"back","id":"a"}'));
});

test('a command longer than 4 KiB is rejected', () => {
  // 20 values of 100 chars of multi-byte text: about 20 * (100 * 3) bytes
  const values = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`e${i}`, '日'.repeat(100)]));
  bad({ cmd: 'submit_form', id: 'a', snap: 1, form: 'e1', values }, 'longer than 4096 bytes');
});

test('digest comparison is strict', () => {
  const d = sha256Hex('x');
  assert.ok(sameDigest(d, d));
  assert.ok(!sameDigest(d.toUpperCase(), d));
  assert.ok(!sameDigest(d.slice(1), d));
  assert.ok(!sameDigest(`${d}0`, d));
  assert.ok(!sameDigest(sha256Hex('y'), d));
  assert.ok(!sameDigest(5, d));
  assert.ok(!sameDigest(undefined, d));
  assert.ok(!sameDigest('z'.repeat(64), d));
});
