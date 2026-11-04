import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { PassThrough } from 'node:stream';
import { validateCommand } from '../lib/commands.mjs';
import { createEmitter } from '../lib/emitter.mjs';
import { JobError, parseJob } from '../lib/job.mjs';
import { LIMITS, cut, cutBytes } from '../lib/limits.mjs';
import { parseLinks, withOrigins } from '../lib/snapshot.mjs';

const RUN_ID = '3f1c2a64-8d0b-4c35-9a77-0b6f3a1e2d90';
const job = (o) => JSON.stringify({ schema: 1, run_id: RUN_ID, kind: 'url', url: 'https://example.com/', ...o });

test('cut never splits a surrogate pair and cutBytes never splits a character', () => {
  const s = 'a😀b';
  assert.equal(cut(s, 2), 'a');
  assert.equal(cut(s, 3), 'a😀');
  assert.equal(cutBytes('é'.repeat(10), 5), 'éé');
  assert.equal(cutBytes('😀😀', 5), '😀');
  assert.equal(cut(undefined, 5), '');
  assert.equal(cut(12345, 3), '123');
});

test('parseJob accepts a good job and applies defaults', () => {
  const j = parseJob(job({}));
  assert.equal(j.url, 'https://example.com/');
  assert.equal(j.session, null);
  assert.equal(j.navTimeoutS, LIMITS.navTimeoutDefaultS);
  assert.deepEqual(parseJob(job({ session: {} })).session, { maxS: LIMITS.sessionMaxDefaultS });
  assert.deepEqual(parseJob(job({ session: { max_s: 12 }, nav_timeout_s: 5 })).session, { maxS: 12 });
});

test('parseJob rejects everything malformed', () => {
  const bad = [
    'not json', 'null', '[]', job({ schema: 2 }), job({ schema: undefined }), job({ run_id: 'x' }), job({ run_id: undefined }),
    job({ kind: 'file' }), job({ url: 'file:///etc/passwd' }), job({ url: 'javascript:alert(1)' }), job({ url: 'data:text/html,x' }),
    job({ url: '' }), job({ url: 5 }), job({ url: 'https://example.com/' + 'a'.repeat(3000) }), job({ url: 'not a url' }),
    job({ session: 5 }), job({ session: { max_s: 0 } }), job({ session: { max_s: 601 } }), job({ session: { max_s: 1.5 } }),
    job({ nav_timeout_s: 0 }), job({ nav_timeout_s: 61 }), job({ nav_timeout_s: '5' }),
  ];
  for (const line of bad) assert.throws(() => parseJob(line), JobError, line.slice(0, 60));
});

test('the supervisor fixture: every command it accepts is accepted here, every one it rejects is rejected', () => {
  const fixture = JSON.parse(readFileSync(new URL('../../supervisor/testdata/canonical.json', import.meta.url), 'utf8'));
  assert.ok(fixture.valid.length > 40 && fixture.invalid.length > 90);
  for (const c of fixture.valid) {
    const r = validateCommand(c.canonical);
    assert.equal(r.ok, true, `should accept ${c.canonical}`);
  }
  for (const c of fixture.invalid) {
    const line = c.raw ?? JSON.stringify(c.input);
    const r = validateCommand(line);
    assert.equal(r.ok, false, `should reject ${line.slice(0, 100)}`);
  }
});

test('validateCommand edge cases', () => {
  assert.equal(validateCommand('{"cmd":"snapshot","id":"a"}').ok, true);
  assert.equal(validateCommand('{"cmd":"snapshot","id":"a"}').risk, 'safe');
  assert.equal(validateCommand('{"cmd":"download","id":"a","snap":1,"ref":"e7"}').risk, 'risky');
  assert.deepEqual(validateCommand('{"cmd":"nope","id":"a"}'), { ok: false, error: 'unknown_command', id: 'a' });
  assert.equal(validateCommand('{"cmd":"__proto__","id":"a"}').error, 'unknown_command');
  assert.equal(validateCommand('{"cmd":"constructor","id":"a"}').error, 'unknown_command');
  assert.equal(validateCommand('{"cmd":"snapshot","id":"a","extra":1}').error, 'bad_command');
  assert.equal(validateCommand('{"cmd":"scroll","id":"a","dy":5001}').ok, false);
  assert.equal(validateCommand('{"cmd":"scroll","id":"a","dy":1.5}').ok, false);
  assert.equal(validateCommand('{"cmd":"snapshot","id":"a b"}').ok, false);
  assert.equal(validateCommand('x'.repeat(5000)).ok, false);
  assert.equal(validateCommand('{"cmd":"submit_form","id":"a","snap":1,"form":"e3","values":{"e4":"x\u0000"}}').ok, false);
  assert.equal(validateCommand('{"cmd":"submit_form","id":"a","snap":1,"form":"e3","values":{"name":"x"}}').ok, false);
  assert.equal(validateCommand('{"cmd":"open_link","id":"a","snap":1,"ref":"f1e3"}').ok, true);
});

test('parseLinks reads refs, names and urls; withOrigins marks foreign ones', () => {
  const text = [
    '- generic [ref=e1]:',
    '  - link "Reset \\"password\\"" [ref=e2] [cursor=pointer]:',
    '    - /url: https://evil.example/x',
    '  - link [ref=e3]:',
    '    - /url: /local',
    '  - link "no url" [ref=e4]',
    '  - link "javascript" [ref=f1e5]:',
    '    - /url: javascript:void(0)',
  ].join('\n');
  const links = parseLinks(text);
  assert.deepEqual(links.map((l) => l.ref), ['e2', 'e3', 'e4', 'f1e5']);
  assert.equal(links[0].text, 'Reset "password"');
  assert.equal(links[0].href, 'https://evil.example/x');
  assert.equal(links[2].href, '');
  const o = withOrigins(links, 'https://site.test/page');
  assert.deepEqual(o.map((l) => l.origin_differs), [true, false, false, true]);
});

test('parseLinks stops at the link limit', () => {
  const text = Array.from({ length: 300 }, (_, i) => `- link "l${i}" [ref=e${i + 1}]:\n  - /url: /x`).join('\n');
  assert.equal(parseLinks(text).length, LIMITS.links);
});

test('emitter: order, backpressure-safe writes, budget, essential kinds', async () => {
  const out = new PassThrough();
  const chunks = [];
  out.on('data', (d) => chunks.push(d.toString()));
  let t = 1000;
  const em = createEmitter(out, { now: () => (t += 10), budget: 600 });
  em.emit('nav', { n: 1 });
  em.emit('request', { pad: 'x'.repeat(300) });
  em.emit('request', { pad: 'x'.repeat(300) }); // over budget: dropped and counted
  em.emit('cmd_result', { id: 'a', ok: true }); // essential: always passes
  em.emit('summary', {});
  await em.flush();
  const lines = chunks.join('').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.kind), ['nav', 'request', 'cmd_result', 'summary']);
  assert.deepEqual(em.dropped(), { request: 1 });
  assert.ok(lines.every((l) => l.type === 'evidence' && l.v === 1 && Number.isInteger(l.t)));
  assert.ok(lines[0].t < lines[3].t);
});
