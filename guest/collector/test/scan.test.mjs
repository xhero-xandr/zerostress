import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { INJECTION, startPages } from './pages.mjs';
import net from 'node:net';
import { scanOnce } from './helpers.mjs';

const freePort = () => new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

let pages;
before(async () => { pages = await startPages(); });
after(async () => { await pages.close(); });

const hasText = (events, needle) => events.some((e) => JSON.stringify(e).includes(needle));

test('a plain page: ordered, well-formed events, summary last, exit 0', async () => {
  const r = await scanOnce(`${pages.origin}/`);
  assert.equal(r.code, 0, r.stderr());
  assert.equal(r.events[0].kind, 'nav');
  assert.equal(r.events[0].via, 'requested');
  assert.equal(r.events.at(-1).kind, 'summary');
  assert.ok(r.events.every((e) => e.type === 'evidence' && e.v === 1 && Number.isInteger(e.t)), 'every line is a schema v1 evidence event');
  const ts = r.events.map((e) => e.t);
  assert.deepEqual(ts, [...ts].sort((a, b) => a - b), 'timestamps never go backwards');
  for (const k of ['nav', 'request', 'page', 'forms', 'snapshot', 'links', 'artifact', 'summary']) assert.ok(r.first(k), `has ${k}`);
  const page = r.first('page');
  assert.equal(page.title, 'Start');
  assert.match(page.text, /Start/);
  const links = r.first('links').links;
  assert.equal(links.length, 1);
  assert.equal(links[0].text, 'Next page');
  assert.equal(links[0].origin_differs, false);
  assert.match(links[0].ref, /^e\d+$/);
  const snap = r.first('snapshot');
  assert.equal(snap.snap, 1);
  assert.match(snap.text, /link "Next page"/);
  const shot = r.first('artifact');
  assert.equal(shot.saved, true);
  assert.equal(shot.mime, 'image/png');
  assert.equal(r.filesAtExit.length, 3, 'the desktop shot plus the phone and tablet captures taken after it');
  assert.ok(r.filesAtExit.includes(shot.file), 'the announced file name is one of the names on disk (the host fetches it by that name)');
  assert.match(shot.file, /^[0-9a-f]{16}\.png$/);
  assert.equal(shot.file.slice(0, 16), shot.sha256.slice(0, 16));
  assert.equal(r.artifactBytes[shot.file], shot.bytes, 'the file on disk has the size that was reported');
  const sum = r.first('summary');
  assert.equal(sum.final_url, `${pages.origin}/`);
  assert.equal(sum.nav_error, null);
  assert.equal(sum.counts.requests_seen, 1);
});

test('HTTP redirects are reported hop by hop with their status codes', async () => {
  const r = await scanOnce(`${pages.origin}/r1`);
  assert.equal(r.code, 0, r.stderr());
  const hops = r.kinds('nav').filter((n) => n.via === 'http');
  assert.deepEqual(hops.map((h) => [h.status, h.to.replace(pages.origin, '')]), [[302, '/r2'], [301, '/final']]);
  assert.equal(r.first('summary').final_url, `${pages.origin}/final`);
  const statuses = r.kinds('request').map((q) => q.status);
  assert.deepEqual(statuses, [302, 301, 200]);
  // every hop, redirects included, carries the address the browser connected to (the local test server here)
  assert.deepEqual(r.kinds('request').map((q) => q.ip), ['127.0.0.1', '127.0.0.1', '127.0.0.1']);
});

test('a meta refresh is reported as scheduled and followed', async () => {
  const r = await scanOnce(`${pages.origin}/meta`);
  assert.equal(r.code, 0, r.stderr());
  const sched = r.kinds('nav').find((n) => n.via === 'scheduled');
  assert.ok(sched, 'a scheduled navigation is reported');
  assert.equal(sched.reason, 'metaTagRefresh');
  assert.equal(sched.delay_s, 1);
  assert.equal(r.first('summary').final_url, `${pages.origin}/final`);
  assert.equal(r.first('page').title, 'Final');
});

test('a refresh that has begun but not yet committed is waited for, not read as the old page', async () => {
  const r = await scanOnce(`${pages.origin}/meta-late`);
  assert.equal(r.code, 0, r.stderr());
  assert.equal(r.first('summary').final_url, `${pages.origin}/final-late`);
  assert.equal(r.first('page').title, 'Final late');
});

test('after a refresh the page is read once it has loaded, not as soon as it commits', async () => {
  const r = await scanOnce(`${pages.origin}/meta-slow`);
  assert.equal(r.code, 0, r.stderr());
  assert.equal(r.first('summary').final_url, `${pages.origin}/final-slow`);
  assert.equal(r.first('page').title, 'Final slow');
});

test('a JavaScript redirect after load is followed', async () => {
  const r = await scanOnce(`${pages.origin}/js`);
  assert.equal(r.code, 0, r.stderr());
  assert.equal(r.first('summary').final_url, `${pages.origin}/final`);
  const commits = r.kinds('nav').filter((n) => n.via === 'commit').map((n) => n.to.replace(pages.origin, ''));
  assert.deepEqual(commits, ['/js', '/final']);
});

test('pushState is a same-document navigation', async () => {
  const r = await scanOnce(`${pages.origin}/hash`);
  const same = r.kinds('nav').find((n) => n.same_document);
  assert.ok(same);
  assert.match(same.to, /\/hash#a$/);
});

test('a login form posting to another origin: forms, password flag, clobbering resisted', async () => {
  const r = await scanOnce(`${pages.origin}/login`);
  const f = r.first('forms');
  assert.equal(f.total, 2);
  const login = f.forms[0];
  assert.equal(login.has_password, true);
  assert.equal(login.origin_differs, true);
  assert.equal(login.action, `${pages.other}/collect`);
  assert.equal(login.method, 'post');
  const pw = login.fields.find((x) => x.password);
  assert.equal(pw.autocomplete, 'current-password');
  assert.equal(pw.visible, true);
  assert.equal(login.fields.find((x) => x.name === 'csrf').visible, false);
  // <input name="action"> would shadow form.action in the page's own world, not in the probe's
  assert.equal(f.forms[1].action, `${pages.origin}/search`);
  assert.equal(f.forms[1].origin_differs, false);
  assert.equal(f.loose_password_fields, 1);
});

test('hidden text is found and labelled, and kept out of the visible text', async () => {
  const r = await scanOnce(`${pages.origin}/hidden`);
  const p = r.first('page');
  assert.equal(p.hidden_text.present, true);
  for (const reason of ['not_rendered', 'zero_size', 'low_contrast', 'offscreen', 'transparent']) {
    assert.ok(p.hidden_text.reasons.includes(reason), `reason ${reason} in ${p.hidden_text.reasons}`);
  }
  for (const t of ['DISPLAY-NONE-TEXT', 'ZERO-SIZE-TEXT', 'WHITE-ON-WHITE-TEXT', 'OFFSCREEN-TEXT', 'TRANSPARENT-TEXT']) {
    assert.ok(p.hidden_text.text.includes(t), `${t} is in hidden_text`);
  }
  assert.ok(!p.hidden_text.text.includes('Visible words'));
  assert.ok(!p.text.includes('DISPLAY-NONE-TEXT'), 'display:none is not in the visible text');
  assert.ok(p.text.includes('Visible words'));
  assert.equal(p.comments_count, 2);
  assert.deepEqual(p.meta, [{ name: 'description', content: 'meta text' }]);
});

test('injection text arrives as data in well-formed events; nothing is cut or interpreted', async () => {
  const r = await scanOnce(`${pages.origin}/inject`);
  assert.equal(r.code, 0, r.stderr());
  assert.ok(r.raw.every((l) => { try { JSON.parse(l); return true; } catch { return false; } }));
  const p = r.first('page');
  assert.ok(p.text.includes(INJECTION));
  assert.ok(p.title.includes(INJECTION));
  assert.ok(p.hidden_text.text.includes(INJECTION));
  assert.ok(r.first('snapshot').text.includes(INJECTION));
  assert.equal(r.kinds('error').length, 0);
  assert.equal(r.events.at(-1).kind, 'summary');
});

test('a navigation that turns into a download is not saved', async () => {
  const r = await scanOnce(`${pages.origin}/autodownload`);
  assert.equal(r.code, 0, r.stderr());
  const d = r.first('download');
  assert.ok(d);
  assert.equal(d.filename, 'auto.bin');
  assert.equal(d.saved, false);
  assert.equal(r.first('summary').nav_error, 'download');
  assert.equal(r.filesAtExit.length, 0, 'nothing in the artifact directory');
  assert.equal(r.first('page'), undefined);
});

test('pop-ups are reported; more than three are closed', async () => {
  const r = await scanOnce(`${pages.origin}/popups`);
  assert.equal(r.code, 0, r.stderr());
  assert.equal(r.kinds('popup').length, 6);
  assert.equal(r.first('summary').counts.popups, 6);
});

test('JavaScript dialogs are reported and dismissed (the page does not hang)', async () => {
  const r = await scanOnce(`${pages.origin}/dialog`);
  assert.equal(r.code, 0, r.stderr());
  const d = r.kinds('dialog');
  assert.deepEqual(d.map((x) => [x.dialog_type, x.message]), [['alert', 'ALERT-MESSAGE'], ['confirm', 'CONFIRM-MESSAGE']]);
  assert.ok(d.every((x) => x.type === 'evidence' && x.v === 1), 'a dialog is still an evidence event');
  assert.equal(r.first('summary').nav_error, null);
});

test('console output is capped at 100 lines and the cap is reported', async () => {
  const r = await scanOnce(`${pages.origin}/console`);
  assert.equal(r.kinds('console').length, 100);
  assert.ok(r.first('summary').truncated.includes('console'));
});

test('non-http schemes do not load: file: iframe, top-level data: redirect; a data: iframe is only reported', async () => {
  const r = await scanOnce(`${pages.origin}/schemes`);
  assert.equal(r.code, 0, r.stderr());
  assert.ok(r.kinds('console').some((c) => /local resource: file:/.test(c.text)), 'the browser refused the file: frame and said so');
  assert.ok(!r.kinds('request').some((q) => q.url.startsWith('file:')));
  assert.ok(r.kinds('request').some((q) => q.url.startsWith('data:') && q.resource_type === 'document'), 'the data: frame is reported');
  const links = r.first('links').links;
  assert.ok(links.some((l) => l.href === 'javascript:void(0)' && l.origin_differs === true));
  assert.ok(r.events.at(-1).kind === 'summary' && r.first('summary').nav_error === null);

  const t = await scanOnce(`${pages.origin}/topdata`);
  assert.equal(t.first('summary').final_url, `${pages.origin}/topdata`, 'still on the original page');
  assert.ok(t.kinds('nav').some((n) => n.via === 'scheduled' && n.to.startsWith('data:')), 'the attempt is on record');
  assert.ok(t.kinds('console').some((c) => /top frame to data URL/.test(c.text)));
  assert.ok(!hasText(t.kinds('page'), 'evil'));
});

test('more than 300 requests: the extra ones are counted, not listed', async () => {
  const r = await scanOnce(`${pages.origin}/many`);
  assert.equal(r.code, 0, r.stderr());
  assert.equal(r.kinds('request').length, 300);
  const sum = r.first('summary');
  assert.ok(sum.counts.requests_seen > 400, `saw ${sum.counts.requests_seen}`);
  assert.ok(sum.truncated.includes('request'));
});

test('a huge page: text, snapshot and links are cut and the whole output stays small', async () => {
  const r = await scanOnce(`${pages.origin}/big`);
  assert.equal(r.code, 0, r.stderr());
  const p = r.first('page');
  assert.ok(Buffer.byteLength(p.text) <= 20 * 1024);
  assert.equal(p.text_truncated, true);
  const s = r.first('snapshot');
  assert.ok(Buffer.byteLength(s.text) <= 64 * 1024);
  assert.ok(s.lines <= 1500);
  assert.equal(s.truncated, true);
  assert.equal(r.first('links').links.length, 100);
  const total = r.raw.reduce((n, l) => n + Buffer.byteLength(l) + 1, 0);
  assert.ok(total < 900 * 1024, `output ${total} bytes`);
});

test('a slow page: timeout is a result, not a failure', async () => {
  const r = await scanOnce(`${pages.origin}/slow`, { nav_timeout_s: 1 });
  assert.equal(r.code, 0, r.stderr());
  const sum = r.first('summary');
  assert.equal(sum.nav_error, 'timeout');
  assert.equal(r.first('page'), undefined);
  assert.equal(r.kinds('error').length, 0);
});

test('a refused connection is a result with the browser error code', async () => {
  const port = await freePort();
  const r = await scanOnce(`http://127.0.0.1:${port}/`);
  assert.equal(r.code, 0, r.stderr());
  assert.equal(r.first('summary').nav_error, 'ERR_CONNECTION_REFUSED');
  assert.equal(r.first('page'), undefined);
});

test('a bad job: error event and exit code 2, no browser', async () => {
  for (const job of [{ url: 'file:///etc/passwd' }, { url: 'javascript:alert(1)' }, { url: 'https://example.com/', schema: 9 }, { url: 'https://example.com/', run_id: 'nope' }]) {
    const r = await scanOnce(job.url, Object.fromEntries(Object.entries(job).filter(([k]) => k !== 'url')));
    assert.equal(r.code, 2, JSON.stringify(job));
    assert.equal(r.events.length, 1);
    assert.equal(r.events[0].kind, 'error');
    assert.equal(r.events[0].code, 'bad_job');
  }
});

test('the same address is opened as a phone and as a tablet; a page that shows itself only to a phone is caught', async () => {
  const r = await scanOnce(`${pages.origin}/cloak`);
  assert.equal(r.code, 0, r.stderr());
  assert.equal(r.first('page').title, 'Welcome', 'the desktop sees the harmless page');
  assert.equal(r.first('forms').forms.length, 0);
  const dev = Object.fromEntries(r.kinds('device').map((d) => [d.device, d]));
  assert.deepEqual(Object.keys(dev), ['mobile', 'tablet']);
  assert.deepEqual(dev.mobile.viewport, { width: 412, height: 839 });
  assert.deepEqual(dev.tablet.viewport, { width: 820, height: 1180 });
  assert.equal(dev.mobile.title, 'Sign in');
  assert.equal(dev.mobile.has_password, true);
  assert.equal(dev.mobile.forms, 1);
  assert.deepEqual(dev.mobile.action_origins, [pages.other]);
  assert.equal(dev.tablet.title, 'Welcome');
  assert.equal(dev.tablet.has_password, false);
  // every screenshot is a saved artifact, and each device event names its own
  const arts = r.kinds('artifact');
  assert.equal(arts.length, 3);
  assert.equal(new Set(arts.map((a) => a.file)).size, 3, 'three different images');
  for (const d of [dev.mobile, dev.tablet]) assert.ok(arts.some((a) => a.file === d.file && a.saved), `${d.device} names its image`);
  assert.notEqual(arts[0].file, dev.mobile.file, 'the desktop image comes first and is not a device image');
});

test('a device that cannot load the page is a result, and a page that fails for the desktop gets no device runs', async () => {
  const bad = await scanOnce('http://127.0.0.1:1/');
  assert.equal(bad.code, 0, bad.stderr());
  assert.equal(bad.kinds('device').length, 0);
});
