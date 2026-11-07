import { test } from 'node:test';
import assert from 'node:assert/strict';
import { T } from '../text.ts';

// The interface is in English and the client shows the server's error messages as they are, so a sentence in another
// alphabet here would surface in the middle of an English page.
test('every sentence the server sends is in English', () => {
  const found: string[] = [];
  const walk = (v: unknown, path: string): void => {
    if (typeof v === 'string') {
      if (/[Ѐ-ӿ]/.test(v)) found.push(path);
    } else if (typeof v === 'function') {
      walk((v as (n: number) => unknown)(3), path);
    } else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
    }
  };
  walk(T, 'T');
  assert.ok(Object.keys(T.errors).length > 15, 'the walk no longer reaches the error messages');
  assert.deepEqual(found, []);
});
