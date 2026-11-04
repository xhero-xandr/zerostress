import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, test } from 'node:test';
import { startPages } from './pages.mjs';
import { startCollector } from './helpers.mjs';

let pages;
before(async () => { pages = await startPages(); });
after(async () => { await pages.close(); });

const refIn = (snapText, re) => {
  const line = snapText.split('\n').find((l) => re.test(l));
  assert.ok(line, `no snapshot line matches ${re}`);
  return /\[ref=([a-z0-9]+)\]/.exec(line)[1];
};

async function session(path, extra = {}) {
  const c = startCollector({ url: pages.origin + path, session: { max_s: 60 }, ...extra });
  await c.waitFor((e) => e.kind === 'session_ready');
  return c;
}
async function close(c, id = 'z') {
  const r = await c.command({ cmd: 'close', id });
  assert.equal(r.ok, true);
  assert.equal(await c.finish(), 0, c.stderr());
}

test('session_ready comes after the scan and before any command; close ends cleanly', async () => {
  const c = await session('/');
  const kinds = c.events.map((e) => e.kind);
  assert.ok(kinds.indexOf('session_ready') > kinds.indexOf('artifact'));
  assert.equal(kinds.filter((k) => k === 'session_ready').length, 1);
  assert.ok(!kinds.includes('summary'), 'the summary waits for the end of the session');
  await close(c);
  assert.equal(c.events.at(-1).kind, 'summary');
  assert.equal(c.events.at(-1).session_end, 'close');
});

test('snapshot: a new snapshot number; an old number is stale', async () => {
  const c = await session('/');
  const r = await c.command({ cmd: 'snapshot', id: 's1' });
  assert.deepEqual([r.ok, r.snap], [true, 2]);
  assert.equal(c.kinds('snapshot').at(-1).snap, 2);
  const stale = await c.command({ cmd: 'open_link', id: 's2', snap: 1, ref: c.first('links').links[0].ref });
  assert.deepEqual([stale.ok, stale.error], [false, 'stale_snapshot']);
  await close(c);
});

test('open_link follows a link; back returns; refs are renewed by the new snapshot', async () => {
  const c = await session('/');
  const ref = c.first('links').links[0].ref;
  const r = await c.command({ cmd: 'open_link', id: 'o1', snap: 1, ref });
  assert.deepEqual([r.ok, r.snap], [true, 2], JSON.stringify(r));
  assert.equal(c.kinds('page').at(-1).title, 'Next');
  assert.ok(c.kinds('nav').some((n) => n.via === 'commit' && n.to === `${pages.origin}/next`));
  // the old snapshot's ref must not work any more
  const stale = await c.command({ cmd: 'open_link', id: 'o2', snap: 1, ref });
  assert.equal(stale.error, 'stale_snapshot');
  const b = await c.command({ cmd: 'back', id: 'b1' });
  assert.deepEqual([b.ok, b.snap], [true, 3]);
  assert.equal(c.kinds('page').at(-1).title, 'Start');
  await close(c);
});

test('open_link refuses what is not a link of the last snapshot', async () => {
  const c = await session('/nolink');
  const snap = c.first('snapshot');
  const button = refIn(snap.text, /button "Press"/);
  const r = await c.command({ cmd: 'open_link', id: 'n1', snap: snap.snap, ref: button });
  assert.deepEqual([r.ok, r.error], [false, 'not_a_link']);
  const gone = await c.command({ cmd: 'open_link', id: 'n2', snap: snap.snap, ref: 'e999' });
  assert.deepEqual([gone.ok, gone.error], [false, 'ref_not_found']);
  await close(c);
});

test('open_link to a javascript: link is refused', async () => {
  const c = await session('/schemes');
  const link = c.first('links').links.find((l) => l.href.startsWith('javascript:'));
  const r = await c.command({ cmd: 'open_link', id: 'j1', snap: 1, ref: link.ref });
  assert.deepEqual([r.ok, r.error], [false, 'bad_target']);
  await close(c);
});

test('back with no history is an error, not a crash', async () => {
  const c = await session('/');
  const r = await c.command({ cmd: 'back', id: 'b0' });
  assert.deepEqual([r.ok, r.error], [false, 'no_history']);
  await close(c);
});

test('scroll, wait and screenshot', async () => {
  const c = await session('/big');
  assert.equal((await c.command({ cmd: 'scroll', id: 'c1', dy: 1000 })).ok, true);
  assert.equal((await c.command({ cmd: 'wait', id: 'c2', ms: 100 })).ok, true);
  const before = c.kinds('artifact').length;
  assert.equal((await c.command({ cmd: 'screenshot', id: 'c3', full: true })).ok, true);
  const shots = c.kinds('artifact');
  assert.equal(shots.length, before + 1);
  assert.equal(shots.at(-1).saved, true);
  assert.ok(c.files().length >= 2);
  await close(c);
});

test('download saves the file only on this command; size and SHA-256 match', async () => {
  const c = await session('/dl');
  assert.equal(c.kinds('download').length, 0);
  const link = c.first('links').links.find((l) => l.text === 'Download report');
  const r = await c.command({ cmd: 'download', id: 'd1', snap: 1, ref: link.ref });
  assert.equal(r.ok, true, JSON.stringify(r));
  const d = c.kinds('download').at(-1);
  assert.deepEqual([d.filename, d.mime, d.saved, d.status], ['report.bin', 'application/octet-stream', true, 200]);
  const art = c.kinds('artifact').at(-1);
  const content = Buffer.from('BINARY-CONTENT-0123456789');
  assert.equal(art.bytes, content.length);
  assert.match(art.file, /^[0-9a-f]{16}\.bin$/);
  assert.ok(c.files().includes(art.file));
  assert.equal(art.sha256, createHash('sha256').update(content).digest('hex'));
  assert.equal(art.saved, true);
  await close(c);
});

test('submit_form fills the fields and sends the form; fields outside the form are refused', async () => {
  const c = await session('/form', { env: {} });
  const snap = c.first('snapshot');
  const name = refIn(snap.text, /textbox "Name"/);
  const msg = refIn(snap.text, /textbox "Message"/);
  const kind = refIn(snap.text, /combobox "Kind"/);

  const outside = await c.command({ cmd: 'submit_form', id: 'f0', snap: snap.snap, form: name, values: { e1: 'x' } });
  assert.deepEqual([outside.ok, outside.error], [false, 'field_not_in_form']);

  const r = await c.command({ cmd: 'submit_form', id: 'f1', snap: snap.snap, form: name, values: { [name]: 'Ann Tester', [msg]: 'hello <b>there</b>', [kind]: 'b' } });
  assert.equal(r.ok, true, JSON.stringify(r));
  const page = c.kinds('page').at(-1);
  assert.equal(page.title, 'Received');
  assert.match(page.text, /name=Ann\+Tester/);
  assert.match(page.text, /kind=b/);
  assert.equal(r.snap, 2);
  await close(c);
});

test('malformed lines never break the session', async () => {
  const c = await session('/');
  const unknown = await c.command({ cmd: 'eval', id: 'u1' });
  assert.deepEqual([unknown.ok, unknown.error], [false, 'unknown_command']);
  const extra = await c.command({ cmd: 'snapshot', id: 'u2', code: 'alert(1)' });
  assert.deepEqual([extra.ok, extra.error], [false, 'bad_command']);
  c.sendRaw('this is not json');
  await c.waitFor((e) => e.kind === 'error' && e.code === 'bad_command');
  const still = await c.command({ cmd: 'snapshot', id: 'u3' });
  assert.equal(still.ok, true);
  assert.equal(c.kinds('cmd_result').filter((e) => e.ok === false).length, 2);
  await close(c);
});

test('the session ends by itself at max_s', async () => {
  const c = startCollector({ url: pages.origin + '/', session: { max_s: 2 } });
  assert.equal(await c.finish(), 0, c.stderr());
  assert.equal(c.events.at(-1).kind, 'summary');
  assert.equal(c.events.at(-1).session_end, 'max_time');
});

test('a command that is still running when max_s passes is answered and the session ends', async () => {
  const c = startCollector({ url: pages.origin + '/', session: { max_s: 2 } });
  await c.waitFor((e) => e.kind === 'session_ready');
  const r = await c.command({ cmd: 'wait', id: 'w1', ms: 5000 });
  assert.deepEqual([r.ok, r.error], [false, 'session_expired']);
  assert.equal(await c.finish(), 0, c.stderr());
  assert.equal(c.events.at(-1).session_end, 'max_time');
});

test('end of input ends the session', async () => {
  const c = await session('/');
  c.child.stdin.end();
  assert.equal(await c.finish(), 0, c.stderr());
  assert.equal(c.events.at(-1).session_end, 'eof');
});

test('commands carry through a page that fights back (dialogs and pop-ups on the page)', async () => {
  const c = await session('/popups');
  const r = await c.command({ cmd: 'snapshot', id: 'p1' });
  assert.equal(r.ok, true);
  await close(c);
});

test('the scan of the frame that never loads does not stall the report', async () => {
  const c = startCollector({ url: pages.origin + '/schemes' });
  assert.equal(await c.finish(), 0, c.stderr());
  assert.ok(c.first('summary').duration_ms < 12000, `took ${c.first('summary').duration_ms} ms`);
});
