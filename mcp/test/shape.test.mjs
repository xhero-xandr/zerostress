import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ADVICE, plain, shape } from '../tools.mjs';

test('plain: control characters and line separators become spaces, long text is cut, a non-text is empty', () => {
  assert.equal(plain('a\u0000b\u2028c\u0007d'), 'a b c d');
  assert.equal(plain('x'.repeat(600)).length, 501);
  assert.equal(plain(5), '');
  assert.equal(plain(undefined), '');
});

test('every verdict has advice, and none of it says "safe" without a warning', () => {
  assert.deepEqual(Object.keys(ADVICE).sort(), ['benign', 'malicious', 'suspicious', 'unknown']);
  assert.match(ADVICE.benign, /not a guarantee/);
  assert.match(ADVICE.unknown, /not as safe/);
});

test('shape: an empty or odd report gives "unknown" and no fields of the page outside untrusted_text', () => {
  for (const r of [null, {}, 5, 'x', { verdict: { toString: 'x' } }]) {
    const s = shape(r, 'a'.repeat(32), 'https://z.test');
    assert.equal(s.verdict, 'unknown');
    assert.equal(s.confidence, 0);
    assert.deepEqual(s.signals, []);
  }
});
