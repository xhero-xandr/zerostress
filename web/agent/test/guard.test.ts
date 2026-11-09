import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cut, isObj, list, str } from '../guard.ts';

test('isObj: only a plain object, never null, an array or a primitive', () => {
  assert.equal(isObj({}), true);
  assert.equal(isObj({ a: 1 }), true);
  for (const v of [null, undefined, [], [1], 'x', 1, true]) assert.equal(isObj(v), false, String(v));
});

test('str and list give the empty value for anything of another type', () => {
  assert.equal(str('a'), 'a');
  for (const v of [null, undefined, 1, {}, ['a']]) assert.equal(str(v), '');
  assert.deepEqual(list([1, 2]), [1, 2]);
  for (const v of [null, undefined, 'ab', {}, 1]) assert.deepEqual(list(v), []);
});

test('cut: at most n characters, whole strings stay whole', () => {
  assert.equal(cut('abcdef', 3), 'abc');
  assert.equal(cut('abc', 3), 'abc');
  assert.equal(cut('', 3), '');
});
