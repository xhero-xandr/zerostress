import assert from 'node:assert/strict';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ResultFiles } from '../src/store.ts';
import { tempDir } from './helpers.ts';

const ID = '11111111-1111-4111-8111-111111111111';
const ev = (seq: number, data = 'x') => ({ seq, type: 'state' as const, data });

test('events are appended and read back after a sequence number', () => {
  const f = new ResultFiles(tempDir());
  f.append(ID, ev(1, 'a'));
  f.append(ID, ev(2, 'b'));
  assert.deepEqual(f.read(ID).map((e) => e.data), ['a', 'b']);
  assert.deepEqual(f.read(ID, 1).map((e) => e.data), ['b']);
  assert.equal(f.lastSeq(ID), 2);
  assert.deepEqual(f.read('22222222-2222-4222-8222-222222222222'), []);
});

test('a torn last line (a crash in the middle of a write) does not break reading', () => {
  const dir = tempDir();
  const f = new ResultFiles(dir);
  f.append(ID, ev(1, 'a'));
  appendFileSync(join(dir, `${ID}.ndjson`), '{"seq":2,"ty');
  assert.deepEqual(f.read(ID).map((e) => e.data), ['a']);
  assert.equal(f.lastSeq(ID), 1);
});

test('the first event after a torn line is not lost', () => {
  const dir = tempDir();
  const f = new ResultFiles(dir);
  f.append(ID, ev(1, 'a'));
  appendFileSync(join(dir, `${ID}.ndjson`), '{"seq":2,"ty');
  f.append(ID, ev(2, 'b'));
  f.append(ID, ev(3, 'c'));
  assert.deepEqual(f.read(ID).map((e) => e.data), ['a', 'b', 'c']);
});

test('a file that already ends in a newline gets no blank line, and an empty file is fine', () => {
  const dir = tempDir();
  const f = new ResultFiles(dir);
  writeFileSync(join(dir, `${ID}.ndjson`), '');
  f.append(ID, ev(1, 'a'));
  f.append(ID, ev(2, 'b'));
  const text = require_text(join(dir, `${ID}.ndjson`));
  assert.equal(text.split('\n').filter((l) => l === '').length, 1, 'only the final newline');
  assert.deepEqual(f.read(ID).map((e) => e.data), ['a', 'b']);
});

test('run ids are validated before they become part of a path', () => {
  const f = new ResultFiles(tempDir());
  for (const bad of ['../x', 'a/b', '', '1111', `${ID}/../..`]) {
    assert.throws(() => f.append(bad, ev(1)), /invalid run id/, bad);
    assert.throws(() => f.read(bad), /invalid run id/, bad);
    assert.throws(() => f.delete(bad), /invalid run id/, bad);
  }
});

import { readFileSync } from 'node:fs';
function require_text(p: string): string {
  return readFileSync(p, 'utf8');
}
