import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { ChatInput, ChatReply } from '../../agent/chat.ts';
import type { Progress, TaskInput, TaskResult } from '../../agent/runner.ts';
import { SupervisorError } from '../../agent/supervisor.ts';
import { createApp, MAX_BODY, type AppDeps } from '../app.ts';
import { createLimiter, DEFAULT_LIMITS, type LimitConfig } from '../limits.ts';
import { createStore } from '../store.ts';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const EVIL = '"><img src=x onerror=alert(1)><script>alert(1)</script>';
const HOST = 'zs.test';
const JSONH = { 'content-type': 'application/json', host: HOST };

/** a finished result whose every text that comes from outside is hostile */
function hostile(over: Partial<TaskResult> = {}): TaskResult {
  return {
    schema: 1,
    run_id: '11111111-2222-4333-8444-555555555555',
    url: `https://example.com/${EVIL}`,
    state: 'done',
    failure: null,
    assessment: {
      verdict: 'malicious', confidence: 0.9, mode: 'text', mode_reason: null,
      rules: { verdict: 'malicious', score: 60, confidence: 0.9, signals: [{ id: 'password_form_cross_origin', level: 'high', text: `Password goes to ${EVIL}`, refs: [1] }] },
      model: { verdict: 'malicious', confidence: 0.9, lowered: false },
      summary: `Summary ${EVIL}`, reasons: [{ claim: `Claim ${EVIL}`, evidence: [EVIL] }], next: null, usage: null, notes: [], versions: { ruleset: 'r', prompt: 'p', model: 'm' },
    },
    evidence_events: 5,
    facts: {
      final_host: `evil.example${EVIL}`, page_title: `Title ${EVIL}`,
      chain: [{ via: 'requested', host: 'a.example' }, { via: EVIL, host: `b.example${EVIL}` }],
      forms: [{ action_host: `c.example${EVIL}`, cross_origin: true, has_password: true }],
      tls: [{ host: 'a.example', issuer: `CA ${EVIL}`, valid_to: `2030-01-01${EVIL}` }],
      blocked_requests: 1, third_party_hosts: 2,
    },
    hooks: { triggered: false, findings: [], ruleset: 'x' },
    steps: [], refused: [], pending_approval: [], artifacts: [{ name: 'screenshot.png', bytes: PNG.length, sha256: 'a'.repeat(64), mime: 'image/png' }],
    timeline: [], notes: [],
    ...over,
  } as unknown as TaskResult;
}

interface Rig { app: ReturnType<typeof createApp>; calls: { approve: unknown[][]; cancel: string[]; inputs: TaskInput[]; shots: string[] }; finish(r?: TaskResult): void; fail(): void }

function rig(opts: { chat?: AppDeps['chat']; limits?: Partial<LimitConfig>; submitError?: Error; shot?: Buffer; result?: TaskResult; now?: () => number } = {}): Rig {
  const calls = { approve: [] as unknown[][], cancel: [] as string[], inputs: [] as TaskInput[], shots: [] as string[] };
  const dones: Array<(r: TaskResult) => void> = [];
  const bads: Array<(e: Error) => void> = [];
  const deps: AppDeps = {
    run(input, onProgress: (p: Progress) => void) {
      calls.inputs.push(input);
      if (opts.submitError) return Promise.reject(opts.submitError);
      return new Promise<TaskResult>((resolve, reject) => {
        dones.push(resolve); bads.push(reject);
        onProgress({ kind: 'state', state: 'queued', position: 1 });
        onProgress({ kind: 'state', state: 'running', position: null });
      });
    },
    fetchShot: async (_run, name) => { calls.shots.push(name); return opts.shot ?? PNG; },
    approve: async (...a) => { calls.approve.push(a); },
    cancel: async (id) => { calls.cancel.push(id); },
    chat: opts.chat,
    store: createStore(null, undefined, opts.now),
    limiter: createLimiter({ ...DEFAULT_LIMITS, ...opts.limits }, opts.now),
    demos: [{ label: 'Demo', url: 'https://example.com/' }],
    session: { idle_s: 30, max_s: 120 },
    clientIp: (c) => c.req.header('x-test-ip') ?? '9.9.9.9',
  };
  return { app: createApp(deps), calls, finish: (r) => { for (const d of dones) d(r ?? opts.result ?? hostile()); }, fail: () => { for (const b of bads) b(new Error('x')); } };
}

const post = (app: Rig['app'], body: unknown, headers: Record<string, string> = {}) =>
  app.request('/api/tasks', { method: 'POST', headers: { ...JSONH, ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const tick = () => new Promise((r) => setTimeout(r, 10));

// ---- pages, headers, files ---------------------------------------------------------------------------------------

test('the home page and every answer carry the protective headers; nothing is inline', async () => {
  const { app } = rig();
  for (const path of ['/', '/healthz', '/static/app.js', '/nope', '/r/' + 'a'.repeat(32)]) {
    const res = await app.request(path, { headers: { host: HOST } });
    assert.match(res.headers.get('content-security-policy') ?? '', /default-src 'none'.*script-src 'self'.*frame-ancestors 'none'/, path);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff', path);
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer', path);
    assert.equal(res.headers.get('cross-origin-opener-policy'), 'same-origin', path);
  }
  const html = await (await app.request('/', { headers: { host: HOST } })).text();
  assert.doesNotMatch(html, /<script(?![^>]*\ssrc=)/i, 'no inline script');
  assert.doesNotMatch(html, /\sstyle=|<style|\son[a-z]+=/i, 'no inline style or handler');
  assert.match(html, /data-fill="https:\/\/example\.com\/"/);
});

test('only the two static files are served, and never anything outside them', async () => {
  const { app } = rig();
  assert.equal((await app.request('/static/style.css')).headers.get('content-type'), 'text/css; charset=utf-8');
  assert.equal((await app.request('/static/app.js')).headers.get('content-type'), 'text/javascript; charset=utf-8');
  for (const p of ['/static/..%2Fapp.ts', '/static/../app.ts', '/static/main.ts', '/static/constructor', '/static/__proto__', '/static/%2e%2e%2fgate.ts']) {
    assert.equal((await app.request(p)).status, 404, p);
  }
});

test('the page script never writes markup or runs text', () => {
  const js = readFileSync(new URL('../static/app.js', import.meta.url), 'utf8');
  for (const bad of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function', 'setTimeout("', "setTimeout('"]) assert.ok(!js.includes(bad), bad);
});

// ---- starting a check --------------------------------------------------------------------------------------------

test('a good request is accepted and the key is only ever returned once', async () => {
  const r = rig();
  const res = await post(r.app, { url: 'https://example.com/a' });
  assert.equal(res.status, 202);
  const j = (await res.json()) as { id: string; key: string };
  assert.match(j.id, /^[0-9a-f]{32}$/);
  assert.ok(j.key.length >= 40);
  assert.equal(r.calls.inputs[0]!.url, 'https://example.com/a');
  assert.equal(r.calls.inputs[0]!.session, undefined);
  const page = await (await r.app.request(`/r/${j.id}`)).text();
  assert.ok(!page.includes(j.key), 'the key is not on the page');
  r.finish();
  await tick();
});

test('the gate runs before anything starts, and an answer never repeats the address', async () => {
  const r = rig();
  const cases: Array<[string, string]> = [['http://169.254.169.254/latest/meta-data/', 'private_address'], ['javascript:alert(1)', 'bad_scheme'], ['http://localhost:8080/', 'private_address'], ['https://user:p@example.com/', 'credentials'], ['http://example.com:22/', 'bad_port'], ['', 'bad_url']];
  for (const [url, code] of cases) {
    const res = await post(r.app, { url });
    assert.equal(res.status, 400, url);
    const j = (await res.json()) as { code: string; message: string };
    assert.equal(j.code, code, url);
    assert.ok(!j.message.includes('169.254') && !j.message.includes('localhost'), 'the message does not repeat the address');
  }
  assert.equal(r.calls.inputs.length, 0, 'nothing was started');
});

test('what is passed on is the parser\'s form, not the text that was typed', async () => {
  const r = rig();
  await post(r.app, { url: '  HTTPS://Example.COM/x#frag ' });
  assert.equal(r.calls.inputs[0]!.url, 'https://example.com/x');
  r.finish();
  await tick();
});

test('requests of the wrong shape are refused', async () => {
  const { app } = rig();
  assert.equal((await post(app, { url: 'https://example.com/', extra: 1 })).status, 400);
  assert.equal((await post(app, { url: 'https://example.com/', deep: 'yes' })).status, 400);
  assert.equal((await post(app, '[1]')).status, 400);
  assert.equal((await post(app, 'not json')).status, 400);
  assert.equal((await post(app, '{"url":"https://example.com/"}', { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await post(app, { url: 'https://example.com/' + 'a'.repeat(MAX_BODY) })).status, 413);
  assert.equal((await post(app, { url: 'https://example.com/' }, { origin: 'https://evil.test' })).status, 403, 'a form on another site');
  assert.equal((await post(app, { url: 'https://example.com/' }, { origin: `https://${HOST}` })).status, 202);
});

test('a deep check asks for a live session; the plain one does not', async () => {
  const r = rig({ limits: { active: 5 } });
  await post(r.app, { url: 'https://example.com/', deep: true });
  assert.deepEqual(r.calls.inputs[0]!.session, { idle_s: 30, max_s: 120 });
  await post(r.app, { url: 'https://example.com/', deep: false });
  assert.equal(r.calls.inputs[1]!.session, undefined);
});

test('a supervisor that is full or away becomes our own sentence', async () => {
  const full = rig({ submitError: new SupervisorError(429, 'queue_full', 'x') });
  const a = await post(full.app, { url: 'https://example.com/' });
  assert.equal(a.status, 503);
  assert.equal(((await a.json()) as { code: string }).code, 'busy');
  const away = rig({ submitError: new SupervisorError(0, 'unreachable', 'x') });
  const b = await post(away.app, { url: 'https://example.com/' });
  assert.equal(((await b.json()) as { code: string }).code, 'supervisor_unavailable');
  // the slot was given back: the same person can try again at once
  assert.equal((await post(away.app, { url: 'https://example.com/' })).status, 503);
});

// ---- limits ------------------------------------------------------------------------------------------------------

test('one running check per person, until it ends', async () => {
  const r = rig();
  assert.equal((await post(r.app, { url: 'https://example.com/' })).status, 202);
  const second = await post(r.app, { url: 'https://example.org/' });
  assert.equal(second.status, 429);
  assert.equal(((await second.json()) as { code: string }).code, 'too_many_active');
  assert.ok(Number(second.headers.get('retry-after')) > 0);
  assert.equal((await post(r.app, { url: 'https://example.org/' }, { 'x-test-ip': '8.8.4.4' })).status, 202, 'someone else is not held back');
  r.finish();
  await tick();
  assert.equal((await post(r.app, { url: 'https://example.org/' })).status, 202, 'the slot is free once the check ended');
});

test('the hourly limit, and the daily cap of the whole service', async () => {
  let t = 1_000_000_000_000;
  const r = rig({ limits: { perHour: 2, active: 9, dailyCap: 3 }, now: () => t });
  assert.equal((await post(r.app, { url: 'https://example.com/' })).status, 202);
  assert.equal((await post(r.app, { url: 'https://example.com/' })).status, 202);
  const third = await post(r.app, { url: 'https://example.com/' });
  assert.equal(third.status, 429);
  assert.equal(((await third.json()) as { code: string }).code, 'rate_hour');
  assert.equal((await post(r.app, { url: 'https://example.com/' }, { 'x-test-ip': '1.1.1.1' })).status, 202);
  const capped = await post(r.app, { url: 'https://example.com/' }, { 'x-test-ip': '2.2.2.2' });
  assert.equal(capped.status, 503);
  assert.equal(((await capped.json()) as { code: string }).code, 'daily_cap');
  t += 3_600_001 + 24 * 3_600_000;
  assert.equal((await post(r.app, { url: 'https://example.com/' })).status, 202, 'a new day');
});

// ---- the report --------------------------------------------------------------------------------------------------

async function finished(r: Rig, result: TaskResult = hostile()): Promise<{ id: string; key: string }> {
  const j = (await (await post(r.app, { url: 'https://example.com/' })).json()) as { id: string; key: string };
  r.finish(result);
  await tick();
  return j;
}

test('while it runs the page shows progress; afterwards the report', async () => {
  const r = rig();
  const j = (await (await post(r.app, { url: 'https://example.com/' })).json()) as { id: string };
  const mid = await (await r.app.request(`/r/${j.id}`)).text();
  assert.match(mid, /data-live="1"/);
  assert.match(mid, /Opening the page/);
  r.finish();
  await tick();
  const end = await (await r.app.request(`/r/${j.id}`)).text();
  assert.match(end, /class="badge v-malicious"/);
  assert.doesNotMatch(end, /data-live="1"/);
});

test('every text that comes from outside is escaped on every section of the report', async () => {
  const r = rig();
  const { id } = await finished(r);
  for (const path of ['', '/security', '/network', '/links', '/behavior']) {
    const res = await r.app.request(`/r/${id}${path}`);
    assert.equal(res.status, 200, path);
    const html = await res.text();
    for (const bad of ['<img src=x', '<script>alert', '"><img src=x', 'onerror=alert(1)><script']) assert.ok(!html.includes(bad), `unescaped on ${path || '/summary'}: ${bad}`);
    assert.equal((html.match(/<script/g) ?? []).length, 1, `only our own script tag on ${path || '/summary'}`);
    assert.doesNotMatch(html, /<a [^>]*href="[^"]*(example\.com|evil\.example|[a-c]\.example)/, `no address of the checked page is a link on ${path || '/summary'}`);
  }
  const html = await (await r.app.request(`/r/${id}/network`)).text();
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'), 'it is there, as text');
});

test('the sections are fixed: an unknown one is a 404, and the file names are not taken for sections', async () => {
  const r = rig();
  const { id } = await finished(r);
  for (const p of ['/nope', '/__proto__', '/constructor', '/security.html', '/%2e%2e']) assert.equal((await r.app.request(`/r/${id}${p}`)).status, 404, p);
  assert.equal((await r.app.request(`/r/${id}/screenshot.png`)).status, 200);
  const json = await r.app.request(`/r/${id}/report.json`);
  assert.equal(json.status, 200);
  assert.match(json.headers.get('content-disposition') ?? '', /attachment/);
  const body = await json.text();
  assert.doesNotMatch(body, /SECRET|sha256|run_id.*hooks/);
  assert.equal(JSON.parse(body).schema, 1);
  assert.equal((await r.app.request(`/r/${id}/report.json`, { method: 'POST' })).status, 404);
});

test('the report keeps the owner\'s details out', async () => {
  const r = rig();
  const res = hostile({ hooks: { triggered: true, findings: [{ rule: 'SECRET_RULE_NAME', category: 'x', strength: 'high', place: 'SECRET_PLACE', layer: 1 }], ruleset: 'deadbeef' } });
  const { id } = await finished(r, res);
  const html = await (await r.app.request(`/r/${id}`)).text();
  for (const secret of ['SECRET_RULE_NAME', 'SECRET_PLACE', 'deadbeef', 'sha256', 'a'.repeat(64)]) assert.ok(!html.includes(secret), secret);
  assert.match(html, /addressed to AI assistants/);
});

test('unknown and malformed ids are the same plain 404', async () => {
  const { app } = rig();
  for (const id of ['0'.repeat(32), 'short', '../../etc/passwd', 'G'.repeat(32), '%00']) {
    assert.equal((await app.request(`/r/${id}`)).status, 404, id);
    assert.equal((await app.request(`/r/${id}/screenshot.png`)).status, 404, id);
    assert.equal((await app.request(`/api/tasks/${id}/events`)).status, 404, id);
  }
});

test('the screenshot is a sandboxed PNG, and anything else is refused', async () => {
  const r = rig();
  const { id } = await finished(r);
  const res = await r.app.request(`/r/${id}/screenshot.png`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.equal(res.headers.get('content-security-policy'), 'sandbox');
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), PNG);
  const html = rig({ shot: Buffer.from('<html><script>alert(1)</script></html>'.padEnd(64, ' ')) });
  const j = await finished(html);
  assert.equal((await html.app.request(`/r/${j.id}/screenshot.png`)).status, 404, 'not a PNG');
  const none = rig();
  const k = await finished(none, hostile({ artifacts: [] }));
  assert.equal((await none.app.request(`/r/${k.id}/screenshot.png`)).status, 404);
});

test('a run that produced nothing shows our failure page', async () => {
  const r = rig();
  const j = (await (await post(r.app, { url: 'https://example.com/' })).json()) as { id: string };
  r.fail();
  await tick();
  const html = await (await r.app.request(`/r/${j.id}`)).text();
  assert.match(html, /did not finish/);
});

// ---- the stream --------------------------------------------------------------------------------------------------

test('the stream tells the stages and ends with the final event; a finished task answers at once', async () => {
  const r = rig();
  const j = (await (await post(r.app, { url: 'https://example.com/' })).json()) as { id: string };
  r.finish();
  await tick();
  const res = await r.app.request(`/api/tasks/${j.id}/events`);
  assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
  const text = await res.text();
  assert.match(text, /event: stage\ndata: \{"stage":"queued"/);
  assert.match(text, /"stage":"opening"/);
  assert.match(text, /event: final/);
  assert.ok(!text.includes('example.com'), 'no address or page text goes through the stream');
  const resumed = await (await r.app.request(`/api/tasks/${j.id}/events`, { headers: { 'last-event-id': '99' } })).text();
  assert.match(resumed, /event: final/);
});

test('one person may hold only so many streams', async () => {
  const r = rig({ limits: { streams: 1 } });
  const j = (await (await post(r.app, { url: 'https://example.com/' })).json()) as { id: string };
  const first = await r.app.request(`/api/tasks/${j.id}/events`);
  const second = await r.app.request(`/api/tasks/${j.id}/events`);
  assert.equal(second.status, 429);
  await first.body?.cancel();
  r.finish();
  await tick();
});

// ---- the owner's decisions ---------------------------------------------------------------------------------------

const pendingResult = () => hostile({ pending_approval: [{ command_id: 'cmd-1', cmd: 'submit_form', sha256: 'b'.repeat(64) }] });
const keyed = (key: string) => ({ ...JSONH, 'x-task-key': key });

test('without the key nobody can read or decide', async () => {
  const r = rig();
  const { id, key } = await finished(r, pendingResult());
  for (const h of [{}, { 'x-task-key': 'wrong' }, { 'x-task-key': 'x'.repeat(43) }, { 'x-task-key': key.slice(0, -1) + (key.endsWith('A') ? 'B' : 'A') }]) {
    assert.equal((await r.app.request(`/api/tasks/${id}/pending`, { headers: h })).status, 403);
    assert.equal((await r.app.request(`/api/tasks/${id}/approvals`, { method: 'POST', headers: { ...JSONH, ...h }, body: JSON.stringify({ command_id: 'cmd-1', command_sha256: 'b'.repeat(64), allow: true }) })).status, 403);
  }
  assert.equal(r.calls.approve.length, 0);
  const ok = await r.app.request(`/api/tasks/${id}/pending`, { headers: { 'x-task-key': key } });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { pending: [{ command_id: 'cmd-1', command_sha256: 'b'.repeat(64), label: 'Submit a form on the page' }] });
});

test('a key of another task does not open this one, and guessing is slowed down', async () => {
  const r = rig({ limits: { active: 9 } });
  const a = await finished(r, pendingResult());
  const b = await finished(r, pendingResult());
  assert.equal((await r.app.request(`/api/tasks/${a.id}/pending`, { headers: { 'x-task-key': b.key } })).status, 403);
  let last = 0;
  for (let i = 0; i < 12; i++) last = (await r.app.request(`/api/tasks/${a.id}/pending`, { headers: { 'x-task-key': 'g'.repeat(43) } })).status;
  assert.equal(last, 429);
});

test('the owner allows the very command that was shown, and only that one', async () => {
  const r = rig();
  const { id, key } = await finished(r, pendingResult());
  const send = (body: unknown) => r.app.request(`/api/tasks/${id}/approvals`, { method: 'POST', headers: keyed(key), body: JSON.stringify(body) });
  assert.equal((await send({ command_id: 'cmd-1', command_sha256: 'c'.repeat(64), allow: true })).status, 400, 'another hash');
  assert.equal((await send({ command_id: 'cmd-2', command_sha256: 'b'.repeat(64), allow: true })).status, 400, 'another command');
  assert.equal((await send({ command_id: 'cmd-1', command_sha256: 'b'.repeat(64) })).status, 400, 'no decision');
  assert.equal(r.calls.approve.length + r.calls.cancel.length, 0);
  const yes = await send({ command_id: 'cmd-1', command_sha256: 'b'.repeat(64), allow: true });
  assert.equal(yes.status, 202);
  assert.deepEqual(r.calls.approve[0], ['11111111-2222-4333-8444-555555555555', 'cmd-1', 'b'.repeat(64)]);
});

test('refusing closes the session and approves nothing; a late decision is told so', async () => {
  const r = rig();
  const { id, key } = await finished(r, pendingResult());
  const no = await r.app.request(`/api/tasks/${id}/approvals`, { method: 'POST', headers: keyed(key), body: JSON.stringify({ command_id: 'cmd-1', command_sha256: 'b'.repeat(64), allow: false }) });
  assert.equal(no.status, 202);
  assert.equal(r.calls.approve.length, 0);
  assert.deepEqual(r.calls.cancel, ['11111111-2222-4333-8444-555555555555']);
});

test('a bot-check wall is reported as such, never as "no threat found"', async () => {
  const wall = hostile({ assessment: { ...hostile().assessment, verdict: 'unknown', confidence: 0, mode: 'rules_only', summary: null, reasons: [], model: null,
    rules: { verdict: 'unknown', score: 0, confidence: 0, signals: [{ id: 'bot_challenge', level: 'info', text: 'The site showed a bot-check page instead of its own content, so the real page was not seen.', refs: [] }] } } as never });
  const r = rig();
  const { id } = await finished(r, wall);
  const html = await (await r.app.request(`/r/${id}`)).text();
  assert.match(html, /class="badge v-unknown"/);
  assert.match(html, /Could not check/);
  assert.match(html, /bot-check page\), which an automated browser cannot pass/);
  assert.doesNotMatch(html, /No threat found/);
});

test('an error answer and an empty page are told apart from a wall, and neither is "no threat found"', async () => {
  const mk = (id: string, text: string) => hostile({ assessment: { ...hostile().assessment, verdict: 'unknown', confidence: 0, mode: 'rules_only', summary: null, reasons: [], model: null,
    rules: { verdict: 'unknown', score: 0, confidence: 0, signals: [{ id, level: 'info', text, refs: [] }] } } as never });
  for (const [id, text, wanted] of [['http_error', 'The site answered with an error (HTTP 403) instead of its page, so the real page was not seen.', /answered our automated visit with an error/], ['empty_page', 'The page loaded but showed nothing, so there was nothing to judge.', /loaded but showed nothing/]] as const) {
    const r = rig();
    const { id: taskId } = await finished(r, mk(id, text));
    const html = await (await r.app.request(`/r/${taskId}`)).text();
    assert.match(html, /class="badge v-unknown"/, id);
    assert.match(html, wanted, id);
    assert.doesNotMatch(html, /No threat found/, id);
  }
});

test('the Cloudflare warning is shown as a serious sign, never as a bot-check or "no threat found"', async () => {
  const sig = { id: 'provider_warning', level: 'medium', text: 'Cloudflare shows a warning that this site is suspected of phishing or malware, and does not let a visitor reach the page. The real page was not seen.', refs: [] };
  const warned = hostile({ assessment: { ...hostile().assessment, verdict: 'suspicious', confidence: 0.6, mode: 'rules_only', summary: null, reasons: [], model: null,
    rules: { verdict: 'suspicious', score: 20, confidence: 0.6, signals: [sig] } } as never });
  const r = rig();
  const { id } = await finished(r, warned);
  const html = await (await r.app.request(`/r/${id}`)).text();
  assert.match(html, /class="badge v-suspicious"/);
  assert.match(html, /Cloudflare itself shows a warning/);
  assert.match(html, /do not open this link/);
  assert.doesNotMatch(html, /No threat found|which an automated browser cannot pass/);
});

test('the report says what a form asks for, and says plainly when links lead nowhere', async () => {
  const base = hostile();
  const mk = (links: Array<{ text: string; host: string; other_site: boolean; goes: string }>) => hostile({ facts: { ...(base.facts as object), forms: [{ action_host: 'shop.example', cross_origin: false, has_password: true, asks: ['password', 'card_number', 'card_security'] }], links } as never });
  const r = rig();
  const dead = mk(Array.from({ length: 5 }, (_, i) => ({ text: `Help ${i}`, host: '', other_site: false, goes: 'nowhere' })));
  const { id } = await finished(r, dead);
  const sec = await (await r.app.request(`/r/${id}/security`)).text();
  assert.match(sec, /Asks for: a password, a card number, the card security code/);
  const links = await (await r.app.request(`/r/${id}/links`)).text();
  assert.match(links, /Nowhere \(stays on the page\)/);
  assert.match(links, /5 of 5 links lead nowhere/);
  assert.doesNotMatch(links, /<td class="mono">—<\/td>/);
  const live = mk([{ text: 'a', host: '', other_site: false, goes: 'same' }, { text: 'b', host: 'other.example', other_site: true, goes: 'other' }, { text: 'c', host: '', other_site: false, goes: 'nowhere' }]);
  const { id: id2 } = await finished(r, live);
  const l2 = await (await r.app.request(`/r/${id2}/links`)).text();
  assert.doesNotMatch(l2, /lead nowhere/, 'one dead link is not a finding');
  assert.match(l2, /Another page of this site/);
  assert.match(l2, /other\.example/);
  const home = await (await r.app.request(`/r/${id}`)).text();
  assert.match(home, /Our confidence: /);
});

test('the dead-link note needs at least three dead links and at least half of all links', async () => {
  const base = hostile();
  const link = (goes: string, i: number) => ({ text: `l${i}`, host: '', other_site: false, goes });
  const r = rig();
  for (const [dead, live, note] of [[2, 0, false], [3, 0, true], [3, 7, false], [5, 5, true], [5, 6, false]] as const) {
    const links = [...Array.from({ length: dead }, (_, i) => link('nowhere', i)), ...Array.from({ length: live }, (_, i) => link('same', i + 100))];
    const { id } = await finished(r, hostile({ facts: { ...(base.facts as object), links } as never }));
    const html = await (await r.app.request(`/r/${id}/links`)).text();
    assert.equal(/lead nowhere/.test(html), note, `${dead} dead, ${live} live`);
  }
});

test('the network section lists the servers with their country and network, and the security section the age of the domain', async () => {
  const base = hostile();
  const servers = [
    { ip: '172.64.149.123', country: 'US', asn: 13335, org: 'Cloudflare, Inc.', hosts: ['shop.example', 'api.shop.example'], requests: 17 },
    { ip: '23.207.210.83', country: 'DE', asn: 20940, org: '<b>Akamai</b>', hosts: ['img.example'], requests: 21 },
    { ip: '10.9.9.9', country: null, asn: null, org: null, hosts: [], requests: 1 },
  ];
  const mk = (domain: unknown, over: object = {}) => hostile({ facts: { ...(base.facts as object), servers, servers_total: 3, domain, requests_total: 39, ...over } as never });
  const r = rig();
  const { id } = await finished(r, mk({ name: 'shop.example', created: '2026-11-01T00:00:00.000Z', age_days: 4, registrar: '<i>Reg</i>' }));
  const net = await (await r.app.request(`/r/${id}/network`)).text();
  assert.match(net, /connected to 3 addresses in 2 countries, serving 3 sites, to make 39 requests/);
  assert.match(net, /United States \(US\)/);
  assert.match(net, /Germany \(DE\)/);
  assert.match(net, /AS13335/);
  assert.match(net, /172\.64\.149\.123/);
  assert.match(net, /IP Geolocation by DB-IP/);
  assert.doesNotMatch(net, /<b>Akamai/, 'the owner of a network is text from outside: escaped');
  assert.match(net, /&lt;b&gt;Akamai/);
  const sec = await (await r.app.request(`/r/${id}/security`)).text();
  assert.match(sec, /2026-11-01/);
  assert.match(sec, /4 days ago/);
  assert.match(sec, />new</);
  assert.doesNotMatch(sec, /<i>Reg/);
  assert.match(sec, /&lt;i&gt;Reg/);
  const sum = await (await r.app.request(`/r/${id}`)).text();
  assert.match(sum, /Registered/);

  const old = await finished(r, mk({ name: 'decathlon.si', created: '2011-06-17T00:00:00.000Z', age_days: 5620, registrar: null }));
  const secOld = await (await r.app.request(`/r/${old.id}/security`)).text();
  assert.match(secOld, /15 years ago/);
  assert.doesNotMatch(secOld, />new</);

  const none = await finished(r, mk(null, { servers: [], servers_total: 0 }));
  assert.match(await (await r.app.request(`/r/${none.id}/security`)).text(), /age of the domain is not known/);
  const netNone = await (await r.app.request(`/r/${none.id}/network`)).text();
  assert.match(netNone, /No server addresses were recorded/);
  assert.doesNotMatch(netNone, /DB-IP/, 'no attribution where no database was used');
});

test('the screenshot can be chosen by device, and only among the images of this very run', async () => {
  const base = hostile();
  const art = (name: string) => ({ name, bytes: 100, sha256: 'a'.repeat(64), mime: 'image/png' });
  const names = { d: 'aaaaaaaaaaaaaaaa.png', m: 'bbbbbbbbbbbbbbbb.png', t: 'cccccccccccccccc.png' };
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40)]);
  const r = rig({ shot: png });
  const result = hostile({ artifacts: [art(names.d), art(names.m), art(names.t)], shots: { desktop: names.d, mobile: names.m, tablet: names.t } });
  const { id } = await finished(r, result);
  const page = await (await r.app.request(`/r/${id}`)).text();
  assert.match(page, /<nav class="shot-switch"/);
  assert.match(page, /\?shot=mobile/);
  assert.match(page, /screenshot\.png\?device=desktop/);
  const mobile = await (await r.app.request(`/r/${id}?shot=mobile`)).text();
  assert.match(mobile, /src="\/r\/[^"]+\/screenshot\.png\?device=mobile"/);
  assert.match(mobile, /class="shot-mobile"/);
  assert.match(await (await r.app.request(`/r/${id}?shot=<script>`)).text(), /device=desktop/, 'anything else is the desktop');
  for (const q of ['', '?device=mobile', '?device=tablet', '?device=../../x', '?device=desktop']) assert.equal((await r.app.request(`/r/${id}/screenshot.png${q}`)).status, 200, q);
  assert.deepEqual(r.calls.shots, [names.d, names.m, names.t, names.d, names.d], 'each device gets its own image; anything unknown is the desktop');
  // without a phone image, the switch is not offered and the phone image is not found
  const one = await finished(r, hostile({ artifacts: [art(names.d)], shots: { desktop: names.d, mobile: null, tablet: null } }));
  assert.doesNotMatch(await (await r.app.request(`/r/${one.id}`)).text(), /shot-switch/);
  assert.equal((await r.app.request(`/r/${one.id}/screenshot.png?device=mobile`)).status, 404);
  assert.equal((await r.app.request(`/r/${one.id}?shot=mobile`)).status, 200);
  // a name that the run did not save is never fetched
  const forged = await finished(r, hostile({ artifacts: [art(names.d)], shots: { desktop: names.d, mobile: names.m, tablet: null } }));
  assert.equal((await r.app.request(`/r/${forged.id}/screenshot.png?device=mobile`)).status, 404);
});

test('the security section tells what a phone saw that a computer did not', async () => {
  const base = hostile();
  const mk = (devices: unknown[]) => hostile({ facts: { ...(base.facts as object), devices } as never });
  const r = rig();
  const bad = await finished(r, mk([{ device: 'mobile', nav_error: null, final_host: 'shop.example', title: '<b>Sign in</b>', forms: 1, has_password: true, action_hosts: ['evil.example'], differs: ['password_only_here'], image: true }, { device: 'tablet', nav_error: 'timeout', final_host: 'ghost.example', title: '', forms: 0, has_password: false, action_hosts: [], differs: [], image: false }]));
  const t = await (await r.app.request(`/r/${bad.id}/security`)).text();
  assert.match(t, /On a phone and a tablet/);
  assert.match(t, /shows a password form to a phone or a tablet that a computer does not see/);
  assert.match(t, /It asks for a password only here/);
  assert.match(t, /The page did not open/);
  assert.doesNotMatch(t, /ghost\.example/, 'a device that did not open names no site');
  assert.doesNotMatch(t, /<b>Sign in/);
  const same = await finished(r, mk([{ device: 'mobile', nav_error: null, final_host: 'shop.example', title: 'Shop', forms: 0, has_password: false, action_hosts: [], differs: [], image: true }]));
  const s = await (await r.app.request(`/r/${same.id}/security`)).text();
  assert.match(s, /the page was the same site with no new sign-in form/);
  assert.doesNotMatch(s, /hiding from checkers/);
  const diff = await finished(r, mk([{ device: 'mobile', nav_error: null, final_host: 'other.example', title: '', forms: 0, has_password: false, action_hosts: [], differs: ['other_site'], image: true }]));
  assert.match(await (await r.app.request(`/r/${diff.id}/security`)).text(), /It ends up on a different site/);
  const none = await finished(r, mk([]));
  assert.doesNotMatch(await (await r.app.request(`/r/${none.id}/security`)).text(), /On a phone and a tablet/);
});


// ---- Explain and questions ----------------------------------------------------------------------------------------------------------------
function talker(over: Partial<ChatReply> = {}) {
  const seen: Array<{ input: ChatInput; report: unknown }> = [];
  let n = 0;
  const chat: AppDeps['chat'] = {
    async reply(report, input) {
      seen.push({ input, report });
      n++;
      return { text: `answer ${n}`, source: 'model', reason: null, ...over };
    },
  };
  return { chat, seen };
}
const chatPost = (r: Rig, id: string, body: unknown, headers: Record<string, string> = {}) =>
  r.app.request(`/api/reports/${id}/chat`, { method: 'POST', headers: { ...JSONH, ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

test('Explain: the reply of the assistant, asked once per report and kept; the public report is what it reads', async () => {
  const t = talker();
  const r = rig({ chat: t.chat });
  const { id } = await finished(r);
  const a = await chatPost(r, id, { kind: 'explain' }, { 'x-test-ip': '1.1.1.1' });
  assert.equal(a.status, 200);
  assert.deepEqual(await a.json(), { text: 'answer 1', source: 'model', note: null });
  // a second person, or the same one again, gets the kept explanation without another call
  const b = await chatPost(r, id, { kind: 'explain' }, { 'x-test-ip': '2.2.2.2' });
  assert.deepEqual(await b.json(), { text: 'answer 1', source: 'model', note: null });
  assert.equal(t.seen.length, 1);
  assert.deepEqual(t.seen[0]!.input, { kind: 'explain' });
  const rep = JSON.stringify(t.seen[0]!.report);
  assert.ok(!rep.includes('"owner"') && !rep.includes('command_sha256'), 'the owner\'s details are not in what the assistant reads');
});

test('Explain: an explanation made by rules because of a temporary reason is not kept, one made for a lasting reason is', async () => {
  const temp = talker({ source: 'rules', reason: 'budget', text: 'by rules' });
  const r1 = rig({ chat: temp.chat });
  const { id: i1 } = await finished(r1);
  const a = await (await chatPost(r1, i1, { kind: 'explain' })).json() as { note: string };
  assert.match(a.note, /daily limit/);
  await chatPost(r1, i1, { kind: 'explain' }, { 'x-test-ip': '3.3.3.3' });
  assert.equal(temp.seen.length, 2, 'asked again: the budget may be back');
  const lasting = talker({ source: 'rules', reason: 'hooks_fired', text: 'by rules' });
  const r2 = rig({ chat: lasting.chat });
  const { id: i2 } = await finished(r2);
  await chatPost(r2, i2, { kind: 'explain' }, { 'x-test-ip': '1.1.1.1' });
  await chatPost(r2, i2, { kind: 'explain' }, { 'x-test-ip': '2.2.2.2' });
  assert.equal(lasting.seen.length, 1);
});

test('a question: cut to a clean line, sent with what the same person asked before (only answers of the model)', async () => {
  const t = talker();
  const r = rig({ chat: t.chat });
  const { id } = await finished(r);
  const h = { 'x-test-ip': '1.1.1.1' };
  assert.equal((await chatPost(r, id, { kind: 'ask', message: '  Is the\u0000 password form safe?  ' }, h)).status, 200);
  await chatPost(r, id, { kind: 'ask', message: 'And the domain?' }, h);
  await chatPost(r, id, { kind: 'ask', message: 'Somebody else asks' }, { 'x-test-ip': '2.2.2.2' });
  assert.deepEqual(t.seen.map((x) => x.input), [
    { kind: 'ask', message: 'Is the password form safe?', history: [] },
    { kind: 'ask', message: 'And the domain?', history: [{ q: 'Is the password form safe?', a: 'answer 1' }] },
    { kind: 'ask', message: 'Somebody else asks', history: [] },
  ]);
  const rules = talker({ source: 'rules', reason: 'budget', text: 'x' });
  const r2 = rig({ chat: rules.chat });
  const { id: id2 } = await finished(r2);
  await chatPost(r2, id2, { kind: 'ask', message: 'one' });
  await chatPost(r2, id2, { kind: 'ask', message: 'two' }, { 'x-test-ip': '9.9.9.9' });
  await chatPost(r2, id2, { kind: 'ask', message: 'three' });
  assert.deepEqual((rules.seen[2]!.input as unknown as { history: unknown[] }).history, [], 'an answer written by rules is not part of the talk');
});

test('only a well-formed request is taken: kind, message and nothing more', async () => {
  const t = talker();
  const r = rig({ chat: t.chat });
  const { id } = await finished(r);
  const bad: unknown[] = [
    {}, { kind: 'other' }, { kind: 'explain', message: 'hi' }, { kind: 'ask' }, { kind: 'ask', message: 5 }, { kind: 'ask', message: ['x'] },
    { kind: 'explain', extra: 1 }, { kind: 'ask', message: 'x', run_id: 'y' }, [], 'plain', 7, null,
  ];
  for (const b of bad) assert.equal((await chatPost(r, id, JSON.stringify(b))).status, 400, JSON.stringify(b));
  for (const m of ['', '   ', '\u0000\u0001', 'x'.repeat(301)]) {
    const res = await chatPost(r, id, { kind: 'ask', message: m });
    assert.equal(res.status, 400, JSON.stringify(m).slice(0, 20));
    assert.match(((await res.json()) as { message: string }).message, /up to 300/);
  }
  assert.equal((await chatPost(r, id, { kind: 'ask', message: 'x'.repeat(300) }, { 'x-test-ip': '4.4.4.4' })).status, 200, 'the limit itself is allowed');
  assert.equal((await chatPost(r, id, '{not json')).status, 400);
  assert.equal((await r.app.request(`/api/reports/${id}/chat`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"kind":"explain"}' })).status, 415);
  assert.equal((await chatPost(r, id, { kind: 'explain' }, { origin: 'https://evil.example', host: 'zerostress.space' })).status, 403);
  assert.equal((await chatPost(r, id, 'x'.repeat(5000))).status, 413);
  assert.equal(t.seen.length, 1, 'only the one good request reached the assistant');
});

test('only a finished report can be talked about; no assistant, no endpoint', async () => {
  const t = talker();
  const r = rig({ chat: t.chat });
  const j = (await (await post(r.app, { url: 'https://example.com/' })).json()) as { id: string };
  assert.equal((await chatPost(r, j.id, { kind: 'explain' })).status, 404, 'still running');
  assert.equal((await chatPost(r, 'f'.repeat(32), { kind: 'explain' })).status, 404, 'unknown');
  assert.equal((await chatPost(r, '../x', { kind: 'explain' })).status, 404);
  const none = rig();
  const { id } = await finished(none);
  assert.equal((await chatPost(none, id, { kind: 'explain' })).status, 404);
  assert.equal(t.seen.length, 0);
  const broken = rig({ chat: t.chat });
  const { id: failedId } = await finished(broken, hostile({ state: 'failed', failure: 'nav_timeout' }));
  assert.equal((await chatPost(broken, failedId, { kind: 'explain' })).status, 404, 'a failed run still carries a result, but is not done');
  assert.equal(t.seen.length, 0);
});

test('the limits of the chat: per person per hour, per report, one at a time', async () => {
  const t = talker();
  const r = rig({ chat: t.chat, limits: { chatPerHour: 3, chatPerReport: 2 } });
  const { id } = await finished(r);
  const me = { 'x-test-ip': '1.1.1.1' };
  assert.equal((await chatPost(r, id, { kind: 'ask', message: 'one' }, me)).status, 200);
  assert.equal((await chatPost(r, id, { kind: 'ask', message: 'two' }, { 'x-test-ip': '2.2.2.2' })).status, 200);
  const cap = await chatPost(r, id, { kind: 'ask', message: 'three' }, { 'x-test-ip': '3.3.3.3' });
  assert.equal(cap.status, 429);
  assert.match(((await cap.json()) as { message: string }).message, /as many questions as it can take/);
  const { id: id2 } = await finished(r);
  for (const m of ['a', 'b']) assert.equal((await chatPost(r, id2, { kind: 'ask', message: m }, me)).status, 200);
  const rate = await chatPost(r, id2, { kind: 'ask', message: 'c' }, me);
  assert.equal(rate.status, 429);
  assert.ok(Number(rate.headers.get('retry-after')) > 0);
  // one at a time: while an answer is being written, the same person gets "busy"
  let release: () => void = () => {};
  let started: () => void = () => {};
  const begun = new Promise<void>((res) => { started = res; });
  let slowCalls = 0;
  const slow: AppDeps['chat'] = { reply: () => (slowCalls++ > 0 ? Promise.resolve({ text: 'quick', source: 'model', reason: null }) : new Promise((res) => { release = () => res({ text: 'late', source: 'model', reason: null }); started(); })) };
  const r3 = rig({ chat: slow });
  const { id: id3 } = await finished(r3);
  const first = chatPost(r3, id3, { kind: 'ask', message: 'x' }, me);
  await begun;
  const second = await chatPost(r3, id3, { kind: 'ask', message: 'y' }, me);
  assert.equal(second.status, 429);
  assert.match(((await second.json()) as { message: string }).message, /still being answered/);
  release();
  assert.equal((await first).status, 200);
  assert.equal((await chatPost(r3, id3, { kind: 'ask', message: 'z' }, me)).status, 200, 'and the slot is free again');
});

test('an assistant that breaks gives our plain error, and frees the person\'s slot', async () => {
  let n = 0;
  const flaky: AppDeps['chat'] = { reply: async () => { if (n++ === 0) throw new Error('boom secret'); return { text: 'ok', source: 'model', reason: null }; } };
  const r = rig({ chat: flaky });
  const { id } = await finished(r);
  const bad = await chatPost(r, id, { kind: 'ask', message: 'x' });
  assert.equal(bad.status, 500);
  assert.doesNotMatch(await bad.text(), /boom|secret/);
  assert.equal((await chatPost(r, id, { kind: 'ask', message: 'y' })).status, 200);
});

test('the report page offers Explain, and the page script writes the answer as text only', async () => {
  const r = rig({ chat: talker().chat });
  const { id } = await finished(r);
  const page = await (await r.app.request(`/r/${id}`)).text();
  assert.match(page, /id="explain-open"/);
  assert.match(page, /<aside class="chat" id="chat" hidden/);
  assert.match(page, /<input id="chat-input"[^>]*maxlength="300"/);
  assert.match(page, /Answers come from this report only/);
  const js = readFileSync(new URL('../static/app.js', import.meta.url), 'utf8');
  assert.match(js, /\/api\/reports\/' \+ id \+ '\/chat/);
  assert.doesNotMatch(js, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/);
});
