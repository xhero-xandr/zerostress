import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';
import { loadPrompt } from '../assess.ts';
import { loadAgentConfig } from '../config.ts';
import { createModelClient } from '../model.ts';
import { MODE_TEXT, ownerReport, publicReport, UNTRUSTED, type PublicReport } from '../report.ts';
import { runTask, type TaskResult } from '../runner.ts';
import { createSupervisorClient } from '../supervisor.ts';
import { answer, chat, startFakeModel } from './fakemodel.ts';
import { startFakeSup } from './fakesup.ts';

const closers: Array<{ close(): Promise<void> }> = [];
after(async () => { for (const c of closers) await c.close(); });

const lines = (path: string): any[] => readFileSync(new URL(path, import.meta.url), 'utf8').trim().split(String.fromCharCode(10)).map((l) => JSON.parse(l));

/** A real result: the evidence of a page goes through the fake supervisor, the hooks, the rules and (if asked) the fake model. */
async function realResult(events: any[], model: boolean): Promise<TaskResult> {
  const sup = await startFakeSup();
  closers.push(sup);
  let cfg = loadAgentConfig({});
  let client;
  if (model) {
    const m = await startFakeModel(() => chat(answer({ verdict: 'suspicious', summary: 'It looks odd.', reasons: [{ claim: 'The form goes elsewhere.', evidence: ['forms.cross_origin', 'password_form_cross_origin'] }] })));
    closers.push(m);
    cfg = loadAgentConfig({ INFERENCE_BASE_URL: m.url, INFERENCE_API_KEY: 'sk-test', INFERENCE_MODEL: 'm', AGENT_MODEL_RETRIES: '0' });
    client = createModelClient(cfg);
  }
  for (const s of ['preparing', 'booting', 'running']) sup.state(s);
  for (const e of events) sup.evidence(e);
  sup.state('destroying');
  sup.state('done');
  sup.end();
  return runTask({ url: 'http://page.test/login' }, { sup: createSupervisorClient({ baseUrl: sup.url }), cfg, prompt: loadPrompt(), model: client, limits: { totalMs: 10_000, reconnectDelayMs: 20 } });
}

const injection = () => realResult(lines('../../hooks/test/fixtures/inject.ndjson'), true);
const login = () => realResult(lines('./fixtures/login.ndjson'), true);

// ---- the public view ---------------------------------------------------------------------------------------------------------

test('public: the page is blamed for an injection only when the detectors fired on what the page gave', async () => {
  const r = await injection();
  const f = (place: string) => ({ ...r.hooks.findings[0]!, place });
  const source = (hooks: unknown) => publicReport({ ...r, hooks } as TaskResult).injection_source;
  assert.equal(source({ ...r.hooks, triggered: false, findings: [] }), null);
  assert.equal(source({ ...r.hooks, triggered: true, findings: [f('model')] }), 'answer');
  assert.equal(source({ ...r.hooks, triggered: true, findings: [f('model'), f('model')] }), 'answer');
  assert.equal(source({ ...r.hooks, triggered: true, findings: [f('model'), f('dossier')] }), 'page', 'any finding of the page counts');
  assert.equal(source({ ...r.hooks, triggered: true, findings: [f('page.text'), f('model')] }), 'page');
  assert.equal(source({ ...r.hooks, triggered: true, findings: [] }), 'page', 'fired without a finding: the page, as before');
  assert.equal(source({ ...r.hooks, triggered: true, findings: [{ ...f('model'), place: 'Model' }] }), 'page', 'exactly the place model');
});

test('public: the page that addressed the model: the fact is told, the rule and the place are not', async () => {
  const r = await injection();
  assert.ok(r.hooks.findings.length > 0);
  const pub = publicReport(r);
  const text = JSON.stringify(pub);
  assert.equal(pub.injection_attempt, true);
  assert.equal(pub.injection_source, 'page');
  assert.equal(pub.mode, 'rules_only');
  assert.equal(pub.mode_reason, 'hooks_fired');
  assert.equal(pub.mode_text, MODE_TEXT.hooks_fired);
  for (const f of r.hooks.findings) {
    assert.ok(!text.includes(f.rule), `the public report names the rule ${f.rule}`);
    assert.ok(!text.includes(f.place), `or the place ${f.place}`);
  }
  assert.doesNotMatch(text, /override\.|verdict\.|markup\.|address\.|directive\.|persona\./, 'no rule family names');
  assert.doesNotMatch(text, /ignore all previous|IGNORE ALL/i, 'nor the words of the page');
  for (const secret of [r.hooks.ruleset, r.assessment.versions.prompt]) assert.ok(!text.includes(secret), 'no hashes of ours');
  assert.ok(!('owner' in pub));
});

test('public: no command line, no approval hash, no token count, no notes, no timeline', async () => {
  const r = await login();
  const text = JSON.stringify(publicReport(r));
  assert.ok(!/"line"|command_sha256|sha256|"usage"|"notes"|"timeline"|"versions"|evidence_events/.test(text), text.slice(0, 300));
  assert.equal(publicReport(r).verdict, 'malicious');
});

test('public: the verdict, the signals in our words, the model\'s explanation', async () => {
  const r = await login();
  const pub = publicReport(r);
  assert.equal(pub.verdict, 'malicious');
  assert.ok(pub.signals.some((s) => s.id === 'password_form_cross_origin' && s.level === 'high'));
  assert.equal(pub.summary, 'It looks odd.');
  assert.deepEqual(pub.reasons, [{ claim: 'The form goes elsewhere.', evidence: ['forms.cross_origin', 'password_form_cross_origin'] }]);
  assert.equal(pub.mode, 'text');
  assert.equal(pub.mode_text, null);
  assert.equal(pub.status.state, 'done');
});

// a run in which the agent acted: a step taken, a download left for a person
async function withSteps(): Promise<TaskResult> {
  const r = JSON.parse(JSON.stringify(await login())) as TaskResult;
  r.steps.push({ id: 'a1', action: 'open_link', line: '{"cmd":"open_link","id":"a1","snap":1,"ref":"e3"}', risk: 'safe', status: 'done' });
  r.steps.push({ id: 'a2', action: 'download', line: '{"cmd":"download","id":"a2","snap":2,"ref":"e5"}', risk: 'risky', status: 'awaiting_approval', error: 'x_err' });
  r.pending_approval.push({ command_id: 'a2', cmd: 'download', sha256: 'f'.repeat(64) });
  r.refused.push({ proposal: { action: 'open_link', ref: 'e999' }, reason: 'ref_not_in_links' });
  return r;
}

test('public: what was done is told by name and state; the commands themselves and the way to approve them are not', async () => {
  const pub = publicReport(await withSteps());
  assert.deepEqual(pub.steps, [{ action: 'open_link', status: 'done' }, { action: 'download', status: 'awaiting_approval' }]);
  assert.equal(pub.pending_approval, 1);
  const text = JSON.stringify(pub);
  assert.ok(!text.includes('"cmd"') && !text.includes('"ref"') && !text.includes('ffffffff') && !text.includes('x_err') && !text.includes('e999'), text.slice(0, 300));
});

test('owner: the commands as sent, the hash a person needs to approve, what the gatekeeper refused', async () => {
  const own = ownerReport(await withSteps());
  assert.equal(own.owner.steps[0]!.line, '{"cmd":"open_link","id":"a1","snap":1,"ref":"e3"}');
  assert.equal(own.owner.steps[1]!.error, 'x_err');
  assert.deepEqual(own.owner.pending_approval, [{ command_id: 'a2', cmd: 'download', command_sha256: 'f'.repeat(64) }]);
  assert.deepEqual(own.owner.refused, [{ action: 'open_link', reason: 'ref_not_in_links' }]);
});

// ---- the owner's view ------------------------------------------------------------------------------------------------------------

test('owner: the public view plus what is needed to understand a run', async () => {
  const r = await injection();
  const own = ownerReport(r);
  const { owner, ...rest } = own;
  assert.deepEqual(rest, publicReport(r), 'the public part is the same');
  assert.deepEqual(owner.hook_findings.map((f) => f.rule).sort(), r.hooks.findings.map((f) => f.rule).sort());
  assert.ok(owner.hook_findings.every((f) => f.place !== ''));
  assert.equal(owner.versions.ruleset, r.hooks.ruleset);
  assert.match(owner.versions.prompt, /^[0-9a-f]{64}$/);
  assert.ok(owner.timeline.length > 0);
});

test('owner: no quotation of the page even for the owner', async () => {
  const r = await injection();
  assert.doesNotMatch(JSON.stringify(ownerReport(r)), /ignore all previous|IGNORE ALL/i);
});

test('owner: commands, hashes and tokens of a run with a model', async () => {
  const r = await login();
  const own = ownerReport(r);
  assert.deepEqual(own.owner.usage, { prompt: 1000, completion: 100, total: 1100 });
  assert.equal(own.owner.model?.verdict, 'suspicious');
  assert.equal(own.owner.model?.lowered, true, 'the model asked for less than malicious');
  assert.equal(own.owner.rules.verdict, 'malicious');
});

// ---- built by listing, not by deleting --------------------------------------------------------------------------------------------------

test('a field nobody listed does not reach either report, however deep it is', async () => {
  const r = await login();
  const dirty = JSON.parse(JSON.stringify(r));
  const plant = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(plant);
    else if (v && typeof v === 'object') {
      (v as Record<string, unknown>).planted_secret = 'S3CR3T-VALUE';
      Object.values(v).forEach(plant);
    }
  };
  plant(dirty);
  dirty.steps.push({ id: 'a9', action: 'snapshot', line: 'x', risk: 'safe', status: 'done', planted_secret: 'S3CR3T-VALUE' });
  assert.ok(!JSON.stringify(publicReport(dirty)).includes('S3CR3T'));
  assert.ok(!JSON.stringify(ownerReport(dirty)).includes('S3CR3T'));
});

test('values are coerced and cut: odd verdicts, huge strings, long lists', async () => {
  const r = await login();
  const bad: any = JSON.parse(JSON.stringify(r));
  bad.assessment.verdict = 'definitely safe!!';
  bad.assessment.confidence = 7;
  bad.assessment.mode = 'who knows';
  bad.assessment.mode_reason = '<script>alert(1)</script>';
  bad.assessment.summary = 'x'.repeat(5000);
  bad.assessment.reasons = Array.from({ length: 50 }, () => ({ claim: 'c'.repeat(900), evidence: Array.from({ length: 30 }, () => 'e'.repeat(300)) }));
  bad.assessment.rules.signals = Array.from({ length: 300 }, () => ({ id: 'i'.repeat(300), level: 'l'.repeat(300), text: 't'.repeat(3000) }));
  bad.url = 'u'.repeat(9000);
  bad.failure = 'f'.repeat(500);
  bad.steps = Array.from({ length: 100 }, () => ({ action: 'a'.repeat(100), status: 's'.repeat(100) }));
  const pub = publicReport(bad);
  assert.equal(pub.verdict, 'unknown');
  assert.equal(pub.confidence, 1);
  assert.equal(pub.mode, 'rules_only');
  assert.equal(pub.mode_reason, null, 'a code that is not in the table is not passed on');
  assert.equal(pub.mode_text, null);
  assert.equal(pub.summary!.length, 400);
  assert.equal(pub.reasons.length, 8);
  assert.ok(pub.reasons.every((x) => x.claim.length <= 200 && x.evidence.length <= 6 && x.evidence.every((e) => e.length <= 80)));
  assert.ok(pub.signals.length <= 40 && pub.signals.every((x) => x.id.length <= 40 && x.text.length <= 300));
  assert.equal(pub.url.length, 2048);
  assert.equal(pub.steps.length, 20);
  assert.ok(JSON.stringify(pub).length < 60_000);
});

test('garbage instead of a result does not throw', () => {
  for (const junk of [{}, { assessment: null }, { assessment: 5, steps: 'x', hooks: [] }, { assessment: { rules: { signals: 'x' }, reasons: 5 } }]) {
    assert.doesNotThrow(() => publicReport(junk as unknown as TaskResult));
    assert.doesNotThrow(() => ownerReport(junk as unknown as TaskResult));
  }
  assert.equal(publicReport({} as unknown as TaskResult).verdict, 'unknown');
});

test('the reports are plain data and the same each time', async () => {
  const r = await login();
  assert.deepEqual(JSON.parse(JSON.stringify(ownerReport(r))), ownerReport(r));
  assert.deepEqual(publicReport(r), publicReport(r));
});

// ---- every text field has been decided about --------------------------------------------------------------------------------------------

const SAFE: Record<string, RegExp> = {
  run_id: /^[0-9a-f-]{36}$/,
  verdict: /^(benign|suspicious|malicious|unknown)$/,
  'status.state': /^[a-z]{1,20}$/,
  'status.failure': /^[a-z_]{1,40}$/,
  mode: /^(rules_only|text|vision)$/,
  mode_reason: /^[a-z_]{1,40}$/,
  mode_text: /^[A-Z][^<>]{1,300}$/,
  injection_source: /^(page|answer)$/,
  'signals[].id': /^[a-z_]{1,40}$/,
  'signals[].level': /^(info|low|medium|high)$/,
  'facts.forms[].asks[]': /^(password|card_number|card_security|card_expiry|one_time_code|id_number|birth_date|email|phone|address|name)$/,
  'facts.servers[].ip': /^(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-f:]{2,45})$/i,
  'facts.servers[].country': /^[A-Z]{2}$/,
  'facts.domain.created': /^\d{4}-\d{2}-\d{2}T[\d:.]{8,12}Z$/,
  'facts.devices[].device': /^(mobile|tablet)$/,
  'facts.devices[].nav_error': /^[a-zA-Z0-9_]{1,60}$/,
  'facts.devices[].differs[]': /^(other_site|password_only_here)$/,
  'facts.links[].goes': /^(nowhere|same|other)$/,
  'steps[].action': /^[a-z_]{1,20}$/,
  'steps[].status': /^[a-z_]{1,20}$/,
  'artifacts[].name': /^[0-9a-f]{16}\.(png|bin)$/,
  'artifacts[].mime': /^[a-z]+\/[a-z0-9.+-]+$/,
  'log[].code': /^[a-z_]{1,30}$/,
  'log[].d.state': /^[a-z][a-z0-9_]{0,39}$/,
  'log[].d.reason': /^[a-z][a-z0-9_]{0,39}$/,
  'log[].d.mode': /^(rules_only|text|vision)$/,
  'log[].d.verdict': /^(benign|suspicious|malicious|unknown)$/,
  'log[].d.next': /^[a-z_]{1,30}$/,
  'log[].d.action': /^[a-z_]{1,30}$/,
  'log[].d.risk': /^(safe|risky)$/,
  'log[].d.device': /^(mobile|tablet)$/,
  'log[].d.result': /^[a-z_]{1,30}$/,
  'log[].d.by': /^(rules_only|text|vision)$/,
  'log[].d.image': /^[0-9a-f]{8,64}$/,
  'log[].d.model': /^[A-Za-z0-9._:/-]{1,100}$/,
  'log[].d.source': /^(found|submitted)$/,
  'second_opinion.source': /^(found|submitted)$/,
  'second_opinion.scan_id': /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  'second_opinion.scanned_at': /^\d{4}-\d{2}-\d{2}T[\d:.]{8,12}Z$/,
};

function leaves(v: unknown, path = ''): Array<[string, string]> {
  if (typeof v === 'string') return [[path, v]];
  if (Array.isArray(v)) return v.flatMap((x) => leaves(x, `${path}[]`));
  if (v && typeof v === 'object') return Object.entries(v).flatMap(([k, x]) => leaves(x, path ? `${path}.${k}` : k));
  return [];
}

const withNetwork = async (): Promise<TaskResult> => {
  const r = await login();
  const facts = { ...(r.facts as object), servers: [{ ip: '1.2.3.4', country: 'DE', asn: 13335, org: 'Net', hosts: ['a.example'], requests: 3 }], servers_total: 1, devices: [{ device: 'mobile', nav_error: null, final_host: 'a.example', title: 'T', forms: 1, has_password: true, action_hosts: ['e.example'], differs: ['password_only_here'], image: true }, { device: 'tablet', nav_error: 'timeout', final_host: '', title: '', forms: 0, has_password: false, action_hosts: [], differs: [], image: false }], domain: { name: 'a.example', created: '2026-11-01T00:00:00.000Z', age_days: 4, registrar: 'Reg' } };
  return { ...r, facts } as TaskResult;
};

test('every text in the public report is either listed as untrusted or has a strict shape of our own', async () => {
  const withOpinion = async (): Promise<TaskResult> => ({ ...(await login()), second_opinion: { uuid: '11111111-2222-4333-8444-555555555555', source: 'found', scanned_at: '2026-11-04T12:08:00.000Z', final_url: 'https://evil.example/x', status: 200, title: '"><script>alert(1)</script>', malicious: true, title_withheld: false, screenshot: true } } as TaskResult);
  for (const make of [withOpinion, injection, login, withNetwork, () => realResult(lines('./fixtures/plain.ndjson'), false), () => realResult(lines('./fixtures/unreachable.ndjson'), false)]) {
    const pub: PublicReport = publicReport(await make());
    for (const [path, value] of leaves(pub)) {
      if (UNTRUSTED.includes(path)) continue;
      const shape = SAFE[path];
      assert.ok(shape, `the field "${path}" has been neither listed as untrusted nor given a shape: decide about it`);
      assert.match(value, shape, `${path} = ${JSON.stringify(value).slice(0, 80)}`);
    }
  }
});

test('the owner view too: its text fields are decided about', async () => {
  const own = ownerReport(await login());
  const decided = new Set([...UNTRUSTED, ...Object.keys(SAFE)]);
  const ownerSafe = /^owner\.(rules\.verdict|model\.verdict|versions\.(ruleset|prompt|model)|hook_findings\[\]\.(rule|category|strength)|steps\[\]\.(id|action|line|risk|status)|refused\[\]\.(action|reason)|pending_approval\[\]\.(command_id|cmd|command_sha256)|artifacts\[\]\.(name|sha256|mime)|timeline\[\])$/;
  for (const [path] of leaves(own)) assert.ok(decided.has(path) || ownerSafe.test(path), `undecided: ${path}`);
});

test('what a form asks for is cut to our own list, and a link goes to one of three places', async () => {
  const r = await login();
  const facts = { ...(r.facts as object), forms: [{ action_host: 'x', cross_origin: false, has_password: true, asks: ['password', '<script>alert(1)</script>', 'card_number', 'password', 7] }], links: [{ text: 'a', host: '', other_site: false, goes: '<b>' }, { text: 'b', host: 'h', other_site: true, goes: 'other' }] };
  const pub = publicReport({ ...r, facts } as never);
  assert.deepEqual(pub.facts.forms[0]?.asks, ['password', 'card_number']);
  assert.deepEqual(pub.facts.links.map((l) => l.goes), ['same', 'other']);
});

test('servers and the domain are cut to their shapes: a place is two capitals, an address is an address, a date is a date', async () => {
  const r = await login();
  const facts = {
    ...(r.facts as object),
    servers: [
      { ip: '1.2.3.4', country: 'DE', asn: 13335, org: 'Net', hosts: ['a.example'], requests: 3 },
      { ip: '<img src=x>', country: 'US', asn: 1, org: 'x', hosts: [], requests: 1 },
      { ip: '5.6.7.8', country: '<b>', asn: -5, org: '', hosts: ['h'], requests: 'many' },
      { ip: '9.9.9.9', country: 'de', asn: 1.5, org: 7, hosts: 'no', requests: 1e9 },
    ],
    domain: { name: 'x.example', created: 'yesterday <b>', age_days: 4, registrar: 'R'.repeat(500) },
  };
  const pub = publicReport({ ...r, facts } as never);
  assert.deepEqual(pub.facts.servers.map((s) => s.ip), ['1.2.3.4', '5.6.7.8', '9.9.9.9']);
  assert.deepEqual(pub.facts.servers.map((s) => [s.country, s.asn, s.org, s.requests]), [['DE', 13335, 'Net', 3], [null, null, null, 0], [null, null, null, 99999]]);
  assert.deepEqual(pub.facts.domain, { name: 'x.example', created: null, age_days: null, registrar: 'R'.repeat(80) });
  assert.equal(publicReport({ ...r, facts: { ...(r.facts as object), domain: { name: '' } } } as never).facts.domain, null);
});

test('devices are cut to the two known ones, with our own codes only', async () => {
  const r = await login();
  const facts = { ...(r.facts as object), devices: [
    { device: 'mobile', nav_error: '<b>', final_host: 'h', title: 't', forms: 500, has_password: 'yes', action_hosts: ['a', 'b', 'c', 'd', 'e', 'f'], differs: ['other_site', '<x>', 'password_only_here', 'other_site'], image: 1 },
    { device: 'watch', nav_error: null }, { device: 'tablet' }, { device: 'tablet' },
  ] };
  const d = publicReport({ ...r, facts } as never).facts.devices;
  assert.equal(d.length, 2, 'at most two, and only mobile and tablet');
  assert.deepEqual(d[0], { device: 'mobile', nav_error: null, final_host: 'h', title: 't', forms: 99, has_password: false, action_hosts: ['a', 'b', 'c', 'd', 'e'], differs: ['other_site', 'password_only_here'], image: false });
  assert.deepEqual(publicReport({ ...r, facts: { ...(r.facts as object), devices: 'x' } } as never).facts.devices, []);
});
