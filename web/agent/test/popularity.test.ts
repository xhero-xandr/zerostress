import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { deflateRawSync } from 'node:zlib';
import { loadPopularity, parsePopularity, popularityOf, POPULARITY_FILE, rankStep } from '../popularity.ts';
import { analyze } from '../signals.ts';
import { firstZipEntry } from '../zip-first.ts';

const list = popularityOf(parsePopularity(['google.com', 'github.com', 'bbc.co.uk', 'amazonaws.com', 'github.io', '', 'not a name', 'Example.COM', '93.184.216.34'].join('\n')));

test('the first line is rank 1; a line that is no name keeps its place; names are lower-cased', () => {
  assert.equal(list('google.com'), 1);
  assert.equal(list('github.com'), 2);
  assert.equal(list('example.com'), 8);
});

test('a page of the site itself counts, with or without www and in any case', () => {
  assert.equal(list('www.google.com'), 1);
  assert.equal(list('GOOGLE.com.'), 1);
  assert.equal(list('bbc.co.uk'), 3);
  assert.equal(list('www.bbc.co.uk'), 3);
});

test('a name on a site does not: anyone can make one on a place where files or pages are kept', () => {
  assert.equal(list('evil.s3.amazonaws.com'), null);
  assert.equal(list('docs.google.com'), null);
  assert.equal(list('login.google.com'), null);
});

test('a name on a free hosting service does not, even when the service itself is on the list', () => {
  assert.equal(list('alice.github.io'), null);
  assert.equal(list('www.github.io'), null);
});

test('an address, a site that is not on the list and a lookalike are not popular', () => {
  assert.equal(list('93.184.216.34'), null);
  assert.equal(list('[2001:db8::1]'), null);
  assert.equal(list('unknown.example'), null);
  assert.equal(list('g00gle.com'), null);
  assert.equal(list('google.com.evil.example'), null);
});

test('a name is kept once, at its first place', () => {
  const l = popularityOf(parsePopularity('a.com\nb.com\na.com'));
  assert.equal(l('a.com'), 1);
});

test('at most 100,000 lines are read', () => {
  const l = popularityOf(parsePopularity(Array.from({ length: 100_050 }, (_, i) => `site${i}.com`).join('\n')));
  assert.equal(l('site99999.com'), 100_000);
  assert.equal(l('site100000.com'), null);
});

test('the step of a rank: 1,000, 10,000 or 100,000', () => {
  assert.deepEqual([1, 1000, 1001, 10_000, 10_001, 100_000].map(rankStep), [1000, 1000, 10_000, 10_000, 100_000, 100_000]);
});

test('the list of the host: read from its directory; a missing or short one gives nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zs-pop-'));
  try {
    assert.equal(loadPopularity(dir), null);
    writeFileSync(join(dir, POPULARITY_FILE), 'google.com\n');
    assert.equal(loadPopularity(dir), null, 'a file with a handful of lines is not a list');
    writeFileSync(join(dir, POPULARITY_FILE), Array.from({ length: 2000 }, (_, i) => (i === 0 ? 'google.com' : `s${i}.com`)).join('\n'));
    assert.equal(loadPopularity(dir)?.('google.com'), 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- in the rules ----------------------------------------------------------------------------------------------------

const ev = (kind: string, fields: Record<string, unknown> = {}) => ({ type: 'evidence', v: 1, kind, t: 0, ...fields });
const visit = (url: string) => [ev('nav', { via: 'requested', from: '', to: url }), ev('nav', { via: 'commit', from: '', to: url }), ev('page', { url, title: 'T', text: 'Some text', text_truncated: false, hidden_text: { present: false, reasons: [], text: '' }, meta: [] }), ev('summary', { final_url: url, nav_error: null })];
const popular = (events: unknown[], opts: object) => analyze(events, opts).signals.find((s) => s.id === 'popular_site');

test('a visit that ends on a popular site says so, as a remark that costs no points', () => {
  const s = popular(visit('https://github.com/about'), { popularity: list });
  assert.equal(s?.level, 'info');
  assert.match(s?.text ?? '', /among the 1,000 most visited/);
  assert.match(s?.text ?? '', /not that this page is safe/);
  assert.equal(analyze(visit('https://github.com/about'), { popularity: list }).score, 0);
});

test('without a list, or for a site that is not on it, the rules say nothing about it', () => {
  assert.equal(popular(visit('https://github.com/about'), {}), undefined);
  assert.equal(popular(visit('https://github.com/about'), { popularity: null }), undefined);
  assert.equal(popular(visit('https://unknown.example/'), { popularity: list }), undefined);
});

test('popularity never lowers a verdict: a popular site that carries a warning stays as bad as the warning', () => {
  const events = [...visit('https://github.com/login'), ev('forms', { forms: [{ form: 0, action: 'http://collect.evil.example/p', method: 'post', action_origin: 'http://collect.evil.example', has_password: true, fields: [] }], total: 1, loose_password_fields: 0 })];
  const without = analyze(events, {});
  const withIt = analyze(events, { popularity: list });
  assert.equal(withIt.verdict, without.verdict);
  assert.equal(withIt.score, without.score);
  assert.notEqual(without.verdict, 'benign');
});

// ---- the archive the list comes in -----------------------------------------------------------------------------------

function zip(name: string, content: Buffer, method: 0 | 8): Buffer {
  const data = method === 8 ? deflateRawSync(content) : content;
  const n = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(method, 8); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(content.length, 22); local.writeUInt16LE(n.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(method, 10); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(content.length, 24); central.writeUInt16LE(n.length, 28); central.writeUInt32LE(0, 42);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(46 + n.length, 12); end.writeUInt32LE(30 + n.length + data.length, 16);
  return Buffer.concat([local, n, data, central, n, end]);
}

test('the first file of a zip: stored or compressed', () => {
  const text = Buffer.from('1,google.com\n2,github.com\n'.repeat(50));
  assert.deepEqual(firstZipEntry(zip('top-1m.csv', text, 8), 1 << 20), text);
  assert.deepEqual(firstZipEntry(zip('top-1m.csv', text, 0), 1 << 20), text);
});

test('an archive that is not one, is cut short, is too large or lies about its size is refused', () => {
  const text = Buffer.from('1,google.com\n'.repeat(100));
  const z = zip('top-1m.csv', text, 8);
  assert.throws(() => firstZipEntry(Buffer.from('not a zip at all, just text'), 1 << 20), /not a zip/);
  assert.throws(() => firstZipEntry(z.subarray(0, z.length - 30), 1 << 20), /not a zip/);
  assert.throws(() => firstZipEntry(z, 100), /too large/);
  const cdAt = z.length - 22 - 46 - 'top-1m.csv'.length;
  const longer = Buffer.from(z);
  longer.writeUInt32LE(z.length, cdAt + 20);
  assert.throws(() => firstZipEntry(longer, 1 << 20), /cut short/);
  const lying = Buffer.from(z);
  lying.writeUInt32LE(text.length + 1, cdAt + 24);
  assert.throws(() => firstZipEntry(lying, 1 << 20), /wrong size/);
});
