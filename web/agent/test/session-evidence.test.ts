import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyze } from '../signals.ts';
import { buildFacts } from '../facts.ts';
import { buildDossier } from '../dossier.ts';

// The events in the order the real collector sends them in a deep check (guest/collector: scan.mjs reportPage and
// reportSnapshot, then session.mjs, then collect.mjs): the scan's page, forms, snapshot and links; session_ready; after
// each command that moved the page, the new page's page, forms, snapshot and links; and last the summary, whose
// final_url is still where the link itself led.

const ev = (kind: string, fields: Record<string, unknown> = {}) => ({ type: 'evidence', v: 1, kind, t: 0, ...fields });
const text = 'Payments industry news, analysis and interviews. '.repeat(20);
const pageView = (url: string, title: string, formList: unknown[] = []) => [
  ev('page', { url, title, text, text_truncated: false, hidden_text: { present: false, reasons: [], text: '' }, meta: [] }),
  ev('forms', { forms: formList, total: formList.length, loose_password_fields: 0 }),
  ev('snapshot', { snap: 1, text: '', lines: 0, truncated: false }),
  ev('links', { snap: 1, links: [{ ref: 'e1', text: 'Read more', href: `${url}more`, origin_differs: false }, { ref: 'e2', text: 'a', href: `${url}a` }, { ref: 'e3', text: 'b', href: `${url}b` }] }),
];
const pwForm = (action: string) => ({ form: 0, action, method: 'post', action_origin: new URL(action).origin, has_password: true, fields: [], origin_differs: false });

const scanOf = (url: string, title: string) => [
  ev('nav', { via: 'requested', from: '', to: url }),
  ev('nav', { via: 'commit', from: '', to: url }),
  ev('request', { url, resource_type: 'document', status: 200 }),
  ...pageView(url, title),
];
const agentOpens = (url: string, title: string, formList: unknown[]) => [
  ev('nav', { via: 'commit', from: '', to: url }),
  ev('request', { url, resource_type: 'document', status: 200 }),
  ...pageView(url, title, formList),
  ev('cmd_result', { id: 'c1', ok: true, snap: 2 }),
];
const deepCheck = (landing: string, agentPage: { url: string; title: string; forms: unknown[] }) => [
  ...scanOf(landing, 'Payments news'),
  ev('session_ready'),
  ...agentOpens(agentPage.url, agentPage.title, agentPage.forms),
  ev('summary', { final_url: landing, nav_error: null }),
];

const realPaypal = { url: 'https://www.paypal.com/signin', title: 'Log in to your PayPal account', forms: [pwForm('https://www.paypal.com/signin')] };
const fakePaypal = { url: 'https://paypa1-secure.test/signin', title: 'Log in to your PayPal account', forms: [pwForm('https://collect.evil.test/p')] };

test('a deep check that follows a link to the real PayPal does not accuse the news page or PayPal', () => {
  const a = analyze(deepCheck('https://news.example/', realPaypal));
  const got = a.signals.map((s) => s.id);
  assert.ok(!got.includes('brand_domain_mismatch'), got.join());
  assert.ok(!got.includes('password_form_cross_origin'), got.join());
  assert.notEqual(a.verdict, 'malicious');
});

test('a deep check that reaches a fake PayPal page judges that page by its own address', () => {
  const a = analyze(deepCheck('https://news.example/', fakePaypal));
  const brand = a.signals.find((s) => s.id === 'brand_domain_mismatch');
  assert.ok(brand, a.signals.map((s) => s.id).join());
  assert.match(brand.text, /paypa1-secure/);
  assert.ok(a.signals.some((s) => s.id === 'password_form_cross_origin'));
  assert.equal(a.verdict, 'malicious');
});

test('the agent\'s own navigation is not a redirect chain of the link', () => {
  const evs = [
    ...scanOf('https://news.example/', 'Payments news'),
    ev('session_ready'),
    ...agentOpens('https://one.example/', 'One', []),
    ...agentOpens('https://two.example/', 'Two', []),
    ...agentOpens('https://three.example/', 'Three', []),
    ev('summary', { final_url: 'https://news.example/', nav_error: null }),
  ];
  const got = analyze(evs).signals.map((s) => s.id);
  assert.ok(!got.includes('redirect_chain'), got.join());
});

test('the report describes the page the link led to, all from that one page', () => {
  const evs = deepCheck('https://news.example/', fakePaypal);
  // the agent's click went through a redirect on a tracker and loaded the fake page's resources from their servers
  evs.splice(evs.findIndex((e) => e.kind === 'session_ready') + 1, 0,
    ev('nav', { via: 'http', from: 'https://news.example/', to: 'https://tracker.evil.test/r' }),
    ev('request', { url: 'https://tracker.evil.test/r', resource_type: 'document', status: 302, ip: '203.0.113.9' }),
    ev('request', { url: 'https://cdn.evil.test/kit.js', resource_type: 'script', status: 200, ip: '203.0.113.10' }));
  const f = buildFacts(evs);
  assert.equal(f.third_party_hosts, 0);
  assert.deepEqual(f.servers, []);
  assert.equal(f.final_host, 'news.example');
  assert.equal(f.page_title, 'Payments news');
  assert.deepEqual(f.forms, []);
  assert.deepEqual(f.chain.map((c) => c.host), ['news.example']);
});

test('the model sees the page in front of it with that page\'s own address, and where the link led apart', () => {
  const evs = deepCheck('https://news.example/', fakePaypal);
  const d = buildDossier(evs, analyze(evs), 'text').json as { final_url: string; page: { url: string; title: string }; chain: Array<{ host: string }> };
  assert.equal(d.final_url, 'https://news.example/');
  assert.equal(d.page.url, 'https://paypa1-secure.test/signin');
  assert.equal(d.page.title, 'Log in to your PayPal account');
  assert.deepEqual(d.chain.map((c) => c.host), ['news.example']);
});

test('without a session nothing changes: the last page is the page the link led to', () => {
  const evs = [...scanOf('https://news.example/', 'Payments news'), ev('summary', { final_url: 'https://news.example/', nav_error: null })];
  const f = buildFacts(evs);
  assert.equal(f.final_host, 'news.example');
  assert.equal(f.page_title, 'Payments news');
});

test('sites contacted by a page the agent opened are not counted against the link', () => {
  const evs = deepCheck('https://news.example/', realPaypal);
  const at = evs.findIndex((e) => e.kind === 'session_ready') + 1;
  evs.splice(at, 0, ...Array.from({ length: 12 }, (_, i) => ev('request', { url: `https://cdn${i}.paypal-assets.example/x.js`, resource_type: 'script', status: 200 })));
  assert.ok(!analyze(evs).signals.some((s) => s.id === 'many_third_parties'));
  // the control: the same requests made by the link's own visit are counted
  const own = deepCheck('https://news.example/', realPaypal);
  own.splice(3, 0, ...Array.from({ length: 12 }, (_, i) => ev('request', { url: `https://cdn${i}.paypal-assets.example/x.js`, resource_type: 'script', status: 200 })));
  assert.ok(analyze(own).signals.some((s) => s.id === 'many_third_parties'));
});
