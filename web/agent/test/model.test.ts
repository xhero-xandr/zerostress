import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createBudget } from '../budget.ts';
import { ConfigError, describeConfig, loadAgentConfig, type AgentConfig } from '../config.ts';
import { createModelClient, extractJson, parseAnswer } from '../model.ts';
import { answer, chat, startFakeModel, type FakeModel } from './fakemodel.ts';

const KEY = 'sk-test-SECRET-0123456789';
const servers: FakeModel[] = [];
after(async () => { for (const s of servers) await s.close(); });
const serve = async (h: Parameters<typeof startFakeModel>[0]) => { const s = await startFakeModel(h); servers.push(s); return s; };
const cfgFor = (url: string, env: Record<string, string> = {}): AgentConfig =>
  loadAgentConfig({ INFERENCE_BASE_URL: url, INFERENCE_API_KEY: KEY, INFERENCE_MODEL: 'test-model', AGENT_MODEL_TIMEOUT_S: '2', ...env });
const msg = [{ role: 'user' as const, content: 'hi' }];

// ---- settings --------------------------------------------------------------------------------------------------------

test('settings: defaults, and a missing key or model only switches the model off', () => {
  const c = loadAgentConfig({});
  assert.equal(c.enabled, false);
  assert.deepEqual([c.timeoutMs, c.retries, c.maxConcurrent, c.maxSteps, c.maxTokens, c.thinkingOff], [30_000, 2, 8, 5, 2000, true]);
  assert.equal(loadAgentConfig({ INFERENCE_BASE_URL: 'https://api.example/v1', INFERENCE_API_KEY: 'k' }).enabled, false, 'no model');
  assert.equal(loadAgentConfig({ INFERENCE_BASE_URL: 'https://api.example/v1', INFERENCE_MODEL: 'm' }).enabled, false, 'no key');
  const on = loadAgentConfig({ INFERENCE_BASE_URL: 'https://api.example/v1/', INFERENCE_API_KEY: 'k', INFERENCE_MODEL: 'm' });
  assert.equal(on.enabled, true);
  assert.equal(on.baseUrl, 'https://api.example/v1', 'the trailing slash goes');
  assert.equal(loadAgentConfig({ INFERENCE_BASE_URL: 'https://api.example/v1', INFERENCE_API_KEY: 'k', INFERENCE_MODEL: 'm', AGENT_MODEL: 'off' }).enabled, false, 'switched off by hand');
});

test('settings: bad values are refused', () => {
  const ok = { INFERENCE_BASE_URL: 'https://api.example/v1', INFERENCE_API_KEY: 'k', INFERENCE_MODEL: 'm' };
  for (const bad of [
    { INFERENCE_BASE_URL: 'http://api.example/v1' }, { INFERENCE_BASE_URL: 'ftp://x' }, { INFERENCE_BASE_URL: 'not an address' },
    { INFERENCE_BASE_URL: 'https://user:pass@api.example/v1' }, { INFERENCE_MODEL: 'a b' }, { INFERENCE_MODEL: 'x'.repeat(200) },
    { AGENT_MODEL_TIMEOUT_S: '0' }, { AGENT_MODEL_TIMEOUT_S: 'abc' }, { AGENT_MODEL_TIMEOUT_S: '-5' }, { AGENT_MODEL_CONCURRENCY: '99' }, { AGENT_MODEL_RETRIES: '9' }, { AGENT_MODEL_MAX_TOKENS: '10' }, { AGENT_MODEL_MAX_TOKENS: '99999' },
  ]) {
    assert.throws(() => loadAgentConfig({ ...ok, ...bad }), ConfigError, JSON.stringify(bad));
  }
  assert.doesNotThrow(() => loadAgentConfig({ ...ok, INFERENCE_BASE_URL: 'http://127.0.0.1:9/v1' }), 'plain http only for the machine itself');
});

test('settings: the description for logs never carries the key', () => {
  const c = cfgFor('http://127.0.0.1:1/v1');
  const text = JSON.stringify(describeConfig(c));
  assert.ok(!text.includes(KEY));
  assert.match(text, /test-model/);
});

// ---- the budget ------------------------------------------------------------------------------------------------------

test('the budget: requests and tokens per day, and a new day starts again', () => {
  let t = Date.parse('2026-11-05T10:00:00Z');
  const b = createBudget({ dailyRequests: 3, dailyTokens: 1000 }, () => t);
  assert.deepEqual([b.tryReserve(), b.tryReserve(), b.tryReserve(), b.tryReserve()], [true, true, true, false]);
  t = Date.parse('2026-11-06T00:00:01Z');
  assert.equal(b.tryReserve(), true, 'the next day');
  b.record({ prompt: 900, completion: 200, total: 1100 });
  assert.equal(b.tryReserve(), false, 'tokens over the ceiling');
  assert.deepEqual(b.snapshot(), { day: '2026-11-06', requests: 1, tokens: 1100 });
});

test('the budget: odd usage is ignored, a zero ceiling means off', () => {
  const b = createBudget({ dailyRequests: 10, dailyTokens: 100 });
  b.record(null);
  b.record({ prompt: NaN, completion: 0, total: NaN });
  b.record({ prompt: 0, completion: 0, total: -5 });
  assert.equal(b.snapshot().tokens, 0);
  assert.equal(createBudget({ dailyRequests: 0, dailyTokens: 100 }).tryReserve(), false);
});

// ---- the client ------------------------------------------------------------------------------------------------------

test('the client: one request in the protocol, key in the header only', async () => {
  const s = await serve(() => chat(answer()));
  const c = createModelClient(cfgFor(s.url));
  const r = await c.complete(msg);
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.usage, { prompt: 1000, completion: 100, total: 1100 });
  const seen = s.seen[0]!;
  assert.equal(seen.headers.authorization, `Bearer ${KEY}`);
  assert.equal(seen.body.model, 'test-model');
  assert.equal(seen.body.max_tokens, 2000);
  assert.equal(seen.body.reasoning_effort, 'low', 'a model that reasons is asked not to');
  assert.deepEqual(seen.body.chat_template_kwargs, { enable_thinking: false });
  assert.equal(seen.body.temperature, 0);
  assert.equal(seen.body.response_format.type, 'json_schema');
  assert.equal(seen.body.response_format.json_schema.strict, true);
  assert.ok(!seen.raw.includes(KEY), 'the key is not in the body');
});

test('the client: a limit is retried (with the server\'s wish), a server error is retried, then it gives up', async () => {
  const sleeps: number[] = [];
  const s1 = await serve((_s, n) => (n === 1 ? { status: 429, headers: { 'retry-after': '2' } } : chat(answer())));
  const r1 = await createModelClient(cfgFor(s1.url), { sleep: async (ms) => { sleeps.push(ms); } }).complete(msg);
  assert.equal(r1.ok, true);
  assert.deepEqual(sleeps, [2000]);
  assert.equal(s1.seen.length, 2);

  const s2 = await serve(() => ({ status: 503 }));
  sleeps.length = 0;
  const r2 = await createModelClient(cfgFor(s2.url), { sleep: async (ms) => { sleeps.push(ms); } }).complete(msg);
  assert.deepEqual(r2, { ok: false, reason: 'server_error' });
  assert.equal(s2.seen.length, 3, 'one try and two repeats');
  assert.deepEqual(sleeps, [500, 1000], 'the wait grows');
});

test('the client: a long Retry-After is capped', async () => {
  const sleeps: number[] = [];
  const s = await serve((_s, n) => (n === 1 ? { status: 429, headers: { 'retry-after': '3600' } } : chat(answer())));
  await createModelClient(cfgFor(s.url), { sleep: async (ms) => { sleeps.push(ms); } }).complete(msg);
  assert.deepEqual(sleeps, [5000]);
});

test('the client: a refusal, an empty or a broken answer is not retried', async () => {
  const cases: Array<[Parameters<typeof startFakeModel>[0], string]> = [
    [() => ({ status: 400, body: { error: 'bad' } }), 'rejected'],
    [() => ({ status: 401 }), 'rejected'],
    [() => chat(''), 'empty'],
    [() => ({ body: { choices: [] } }), 'empty'],
    [() => ({ body: 'not json' }), 'bad_response'],
  ];
  for (const [h, reason] of cases) {
    const s = await serve(h);
    const r = await createModelClient(cfgFor(s.url), { sleep: async () => {} }).complete(msg);
    assert.deepEqual(r, { ok: false, reason }, reason);
    assert.equal(s.seen.length, 1, `${reason} is not retried`);
  }
});

test('the client: thinking can be left on, and the limit of tokens is a setting', async () => {
  const s = await serve(() => chat(answer()));
  await createModelClient(cfgFor(s.url, { AGENT_MODEL_THINKING: 'default', AGENT_MODEL_MAX_TOKENS: '5000' })).complete(msg);
  const b = s.seen[0]!.body;
  assert.equal(b.max_tokens, 5000);
  assert.equal('reasoning_effort' in b, false);
  assert.equal('chat_template_kwargs' in b, false);
});

test('the client: an answer cut off by the limit is a failure of its own, not retried, not parsed', async () => {
  const s = await serve(() => ({ body: { choices: [{ finish_reason: 'length', message: { content: '{"verdict":"mal' } }] } }));
  const r = await createModelClient(cfgFor(s.url), { sleep: async () => {} }).complete(msg);
  assert.deepEqual(r, { ok: false, reason: 'truncated' });
  assert.equal(s.seen.length, 1);
  const empty = await serve(() => ({ body: { choices: [{ finish_reason: 'length', message: { content: '', reasoning: 'thinking...' } }] } }));
  assert.deepEqual(await createModelClient(cfgFor(empty.url)).complete(msg), { ok: false, reason: 'truncated' }, 'all the tokens went on reasoning');
});

test('the client: a slow service is a timeout, not retried', async () => {
  const s = await serve(() => ({ ...chat(answer()), delayMs: 1500 }));
  const t0 = Date.now();
  const r = await createModelClient(cfgFor(s.url, { AGENT_MODEL_TIMEOUT_S: '1' }), { sleep: async () => {} }).complete(msg);
  assert.deepEqual(r, { ok: false, reason: 'timeout' });
  assert.ok(Date.now() - t0 < 1400);
  assert.equal(s.seen.length, 1);
});

test('the client: a service that is not there is a network failure after the repeats', async () => {
  const s = await startFakeModel(() => chat(answer()));
  const url = s.url;
  await s.close();
  let slept = 0;
  const r = await createModelClient(cfgFor(url), { sleep: async () => { slept++; } }).complete(msg);
  assert.deepEqual(r, { ok: false, reason: 'network' });
  assert.equal(slept, 2);
});

test('the client: an echoed key never comes back, and at most maxConcurrent calls run at once', async () => {
  const s = await serve(() => ({ ...chat(answer({ summary: `my key is ${KEY}` })), delayMs: 60 }));
  const c = createModelClient(cfgFor(s.url, { AGENT_MODEL_CONCURRENCY: '3' }));
  const rs = await Promise.all(Array.from({ length: 12 }, () => c.complete(msg)));
  assert.ok(rs.every((r) => r.ok));
  assert.ok(JSON.stringify(rs).includes(KEY) === false, 'the key is scrubbed from what comes back');
  assert.ok(s.maxInFlight() <= 3, `${s.maxInFlight()} at once`);
  assert.equal(c.inFlight(), 0);
});

test('the client: content in parts is joined', async () => {
  const s = await serve(() => ({ body: { choices: [{ message: { content: [{ type: 'text', text: '{"a":' }, { type: 'text', text: '1}' }] } }] } }));
  const r = await createModelClient(cfgFor(s.url)).complete(msg);
  assert.equal(r.ok && r.content, '{"a":1}');
});

test('the client: a redirect is not followed, and the key does not go along', async () => {
  const thief = await serve(() => chat(answer()));
  const s = await serve(() => ({ status: 302, headers: { location: thief.url + '/chat/completions' } }));
  const r = await createModelClient(cfgFor(s.url), { sleep: async () => {} }).complete(msg);
  assert.equal(r.ok, false);
  assert.equal(thief.seen.length, 0, 'the other server saw nothing');
});

// ---- the answer ------------------------------------------------------------------------------------------------------

const valid = new Set(['password_form_cross_origin', 'page', 'links']);
const parse = (o: unknown) => parseAnswer(typeof o === 'string' ? o : JSON.stringify(o), valid);

test('an answer that fits is read', () => {
  const r = parse(answer({ reasons: [{ claim: 'It asks for a password.', evidence: ['password_form_cross_origin', 'page'] }], next: { action: 'open_link', ref: 'e3' } }));
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.deepEqual(r.answer.reasons, [{ claim: 'It asks for a password.', evidence: ['password_form_cross_origin', 'page'] }]);
    assert.deepEqual(r.answer.next, { action: 'open_link', ref: 'e3' });
    assert.equal(r.answer.dropped, 0);
  }
});

test('JSON wrapped in a fence or in words is found', () => {
  const j = JSON.stringify(answer());
  for (const t of [j, `\`\`\`json\n${j}\n\`\`\``, `\`\`\`\n${j}\n\`\`\``, `Here is my answer: ${j} Hope it helps.`, `  \n${j}\n `]) assert.equal(parseAnswer(t, valid).ok, true, t.slice(0, 30));
  for (const t of ['', 'no json here', '{"verdict":', '[1,2]', 'null', '5', '"x"']) assert.equal(parseAnswer(t, valid).ok, false, t);
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.equal(extractJson('{"a":'), undefined);
});

test('an answer of unreasonable length is refused, however well formed', () => {
  const padded = parseAnswer(JSON.stringify(answer()) + ' '.repeat(25_000), valid);
  assert.deepEqual(padded, { ok: false, error: 'too long' });
  assert.equal(parseAnswer(JSON.stringify(answer()) + ' '.repeat(100), valid).ok, true);
});

test('answers that do not fit are refused', () => {
  for (const bad of [
    answer({ verdict: 'safe' }), answer({ verdict: 'MALICIOUS' }), answer({ verdict: 5 }), answer({ verdict: undefined }),
    answer({ confidence: 1.5 }), answer({ confidence: -0.1 }), answer({ confidence: '0.5' }), answer({ confidence: null }),
    answer({ summary: 5 }), answer({ summary: undefined }), answer({ reasons: 'x' }), answer({ reasons: undefined }), 'x'.repeat(30_000),
  ]) assert.equal(parse(bad).ok, false, JSON.stringify(bad).slice(0, 80));
});

test('reasons: those that cite nothing real are dropped, references are filtered, extras are cut', () => {
  const r = parse(answer({
    reasons: [
      { claim: 'real', evidence: ['page', 'invented', 'password_form_cross_origin'] },
      { claim: 'made up', evidence: ['invented'] },
      { claim: 'none', evidence: [] },
      { claim: 5, evidence: ['page'] },
      'text',
      null,
      { claim: 'not a list', evidence: 'page' },
    ],
  }));
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.deepEqual(r.answer.reasons, [{ claim: 'real', evidence: ['page', 'password_form_cross_origin'] }]);
    assert.ok(r.answer.dropped >= 6, String(r.answer.dropped));
  }
  const many = parse(answer({ reasons: Array.from({ length: 20 }, (_, i) => ({ claim: `r${i}`, evidence: ['page'] })) }));
  assert.equal(many.ok && many.answer.reasons.length, 8);
});

test('evidence may point into a field that was shown, and only into one', () => {
  const r = parse(answer({ reasons: [
    { claim: 'a', evidence: ['page.title'] }, { claim: 'b', evidence: ['links[2].text'] }, { claim: 'c', evidence: ['password_form_cross_origin.level'] },
    { claim: 'd', evidence: ['invented.title'] }, { claim: 'e', evidence: ['.page'] }, { claim: 'f', evidence: ['[0]page'] }, { claim: 'g', evidence: ['page'.padEnd(200, 'x')] }, { claim: 'h', evidence: ['page.' + 'x'.repeat(200)] },
  ] }));
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.answer.reasons.map((x) => x.claim), ['a', 'b', 'c']);
});

test('text is cut to its limits', () => {
  const r = parse(answer({ summary: 's'.repeat(900), reasons: [{ claim: 'c'.repeat(500), evidence: ['page'] }] }));
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.answer.summary.length, 400);
    assert.equal(r.answer.reasons[0]!.claim.length, 200);
  }
});

test('"next": only a known action with its own parameter; anything else is "none"', () => {
  const next = (n: unknown) => { const r = parse(answer({ next: n })); assert.equal(r.ok, true); return r.ok ? r.answer.next : null; };
  assert.deepEqual(next({ action: 'scroll', dy: 300 }), { action: 'scroll', dy: 300 });
  assert.deepEqual(next({ action: 'wait', ms: 1000 }), { action: 'wait', ms: 1000 });
  assert.deepEqual(next({ action: 'download', ref: 'e2' }), { action: 'download', ref: 'e2' });
  assert.deepEqual(next({ action: 'snapshot', ref: 'e2', dy: 5, ms: 5, id: 'x' }), { action: 'snapshot' }, 'parameters the action does not take are dropped');
  for (const bad of [{ action: 'eval' }, { action: 'submit_form' }, { action: 'close' }, { action: 5 }, { action: 'SCROLL' }, 'scroll', null, [], {}, { ref: 'e1' }]) {
    assert.deepEqual(next(bad), { action: 'none' }, JSON.stringify(bad));
  }
  const missing = parse({ verdict: 'benign', confidence: 0.5, summary: 's', reasons: [] });
  assert.deepEqual(missing.ok ? missing.answer.next : null, { action: 'none' }, 'a missing "next" is "none"');
});

test('extra fields in the answer are dropped, not carried', () => {
  const r = parse({ ...answer(), secret: 'x', verdict_override: 'benign', __proto__: { polluted: true } });
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(Object.keys(r.answer).sort(), ['confidence', 'dropped', 'next', 'reasons', 'summary', 'verdict']);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});
