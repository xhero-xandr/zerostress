import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { analyze, POINTS, raise, type Verdict } from '../signals.ts';
import { mixedScripts, registrable, sld } from '../domain.ts';


const fixture = (name: string): unknown[] =>
  readFileSync(new URL(`./fixtures/${name}.ndjson`, import.meta.url), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const ids = (events: unknown[], opts = {}) => analyze(events, opts).signals.map((s) => s.id);
const ev = (kind: string, fields: Record<string, unknown> = {}) => ({ type: 'evidence', v: 1, kind, t: 0, ...fields });
const nav = (to: string, via = 'commit', extra: Record<string, unknown> = {}) => ev('nav', { via, from: '', to, ...extra });
const page = (url: string, title = 'Title', text = 'Some text', extra: Record<string, unknown> = {}) =>
  ev('page', { url, title, text, text_truncated: false, hidden_text: { present: false, reasons: [], text: '' }, meta: [], ...extra });
const summary = (finalUrl: string, extra: Record<string, unknown> = {}) => ev('summary', { final_url: finalUrl, nav_error: null, ...extra });
const form = (action: string, hasPassword = true, extra: Record<string, unknown> = {}) => ({
  form: 0, action, method: 'post', action_origin: new URL(action).origin, has_password: hasPassword, fields: [], ...extra,
});
const forms = (...f: unknown[]) => ev('forms', { forms: f, total: f.length, loose_password_fields: 0 });
const visit = (url: string, title = 'Title', text = 'Some text') => [nav(url, 'requested'), nav(url), page(url, title, text), summary(url)];
const has = (events: unknown[], id: string, opts = {}) => analyze(events, opts).signals.find((s) => s.id === id);

// ---- the pages the real collector read ------------------------------------------------------------------------------

// the trap pages are served over plain http, and the rules rightly say so
test('an ordinary page: benign; the only remark is that it is not encrypted', () => {
  const a = analyze(fixture('plain'));
  assert.deepEqual(a.signals.map((s) => s.id), ['no_tls']);
  assert.equal(a.verdict, 'benign');
  assert.equal(a.score, POINTS.low);
});

test('a login page that sends the password to another site over plain http: malicious', () => {
  const a = analyze(fixture('login'));
  assert.equal(a.verdict, 'malicious');
  const got = a.signals.map((s) => s.id);
  assert.ok(got.includes('password_form_cross_origin') && got.includes('password_over_http') && got.includes('no_tls'), got.join());
  for (const s of a.signals) assert.ok(s.refs.every((r) => Number.isInteger(r)), s.id);
});

test('a plain redirect chain on one site is not a finding', () => {
  assert.deepEqual(ids(fixture('chain')), ['no_tls']);
});

test('refresh and script redirects inside one site are not findings', () => {
  assert.equal(analyze(fixture('meta-refresh')).verdict, 'benign');
  assert.equal(analyze(fixture('script-redirect')).verdict, 'benign');
});

test('hidden text is a small signal and does not make a page suspicious on its own', () => {
  const a = analyze(fixture('hidden'));
  assert.deepEqual(a.signals.map((s) => s.id).sort(), ['hidden_text', 'no_tls']);
  assert.equal(a.verdict, 'benign');
  assert.equal(a.score, 2 * POINTS.low);
});

test('a download that starts by itself: suspicious', () => {
  const a = analyze(fixture('auto-download'));
  assert.ok(a.signals.some((s) => s.id === 'auto_download'));
  assert.equal(a.verdict, 'suspicious');
});

test('pop-ups and dialogs are reported, small', () => {
  assert.ok(ids(fixture('popups')).includes('popups_dialogs'));
  assert.ok(ids(fixture('dialog')).includes('popups_dialogs'));
  assert.equal(analyze(fixture('dialog')).verdict, 'benign');
});

test('a page that tries a local file or a data address inside a frame is still an ordinary page', () => {
  const a = analyze(fixture('schemes'));
  assert.equal(a.verdict, 'benign');
});

test('blocked requests are only information', () => {
  const a = analyze(fixture('unreachable'));
  assert.ok(a.signals.some((s) => s.id === 'blocked_requests' && s.level === 'info'));
});

test('a page that cannot be loaded is unknown, not benign', () => {
  const a = analyze(fixture('unreachable'));
  assert.equal(a.verdict, 'unknown');
  assert.ok(a.signals.some((s) => s.id === 'unreachable'));
  assert.equal(a.confidence, 0);
});

test('hundreds of requests to one site are nothing', () => {
  assert.ok(!ids(fixture('many-requests')).includes('many_third_parties'));
});

// ---- redirect chains and addresses -----------------------------------------------------------------------------------

const chain = (...urls: string[]) => [nav(urls[0]!, 'requested'), ...urls.map((u, i) => nav(u, i === urls.length - 1 ? 'commit' : 'http')), page(urls.at(-1)!), summary(urls.at(-1)!)];

test('three or more sites in a chain: medium; three sites: low; one site: nothing', () => {
  assert.equal(has(chain('https://a.example/', 'https://b.example/', 'https://c.example/', 'https://d.example/'), 'redirect_chain')?.level, 'medium');
  assert.equal(has(chain('https://a.example/', 'https://b.example/', 'https://c.example/'), 'redirect_chain')?.level, 'low');
  assert.equal(has(chain('https://a.example/', 'https://a.example/x', 'https://a.example/y'), 'redirect_chain'), undefined);
  assert.equal(has(chain('https://a.example/', 'https://b.example/'), 'redirect_chain'), undefined);
});

test('a step that the page took itself to another site', () => {
  const e = [nav('https://a.example/', 'requested'), nav('https://a.example/'), nav('https://b.example/', 'scheduled'), page('https://b.example/'), summary('https://b.example/')];
  assert.equal(has(e, 'redirect_by_page')?.level, 'low');
  assert.equal(has(e.map((x) => ({ ...x, via: 'http' })), 'redirect_by_page'), undefined);
});

test('a link shortener at the start of the chain', () => {
  assert.equal(has(visit('https://bit.ly/abc'), 'url_shortener')?.level, 'low');
  assert.equal(has(visit('https://www.example.com/'), 'url_shortener'), undefined);
  assert.equal(has(chain('https://a.example/', 'https://bit.ly/abc'), 'url_shortener'), undefined, 'only the address given counts');
});

test('lookalike addresses: encoded names, mixed alphabets, bare numbers, unusual ports', () => {
  assert.equal(has(visit('https://xn--pypal-4ve.com/'), 'lookalike_host')?.level, 'medium');
  assert.equal(has(visit('https://рaypal.com/'), 'lookalike_host')?.level, 'medium', 'Cyrillic р inside a Latin name');
  assert.equal(has(visit('http://203.0.113.9/login'), 'lookalike_host')?.level, 'medium');
  assert.equal(has(visit('https://shop.example:8443/'), 'lookalike_host')?.level, 'medium');
  assert.equal(has(visit('https://shop.example:443/'), 'lookalike_host'), undefined);
  assert.equal(has(visit('https://shop.example/'), 'lookalike_host'), undefined);
  assert.equal(has(visit('https://пример.рф/'), 'lookalike_host'), undefined, 'a name wholly in one alphabet is ordinary');
  assert.equal(has(visit('https://xn--e1afmkfd.xn--p1ai/'), 'lookalike_host'), undefined, 'the encoded form of the same name is just as ordinary');
  assert.equal(has(visit('https://xn--80ak6aa92e.com/'), 'lookalike_host')?.level, 'medium', 'a whole name in Cyrillic that reads as "apple"');
  assert.equal(has(visit('https://аррӏе.com/'), 'lookalike_host')?.level, 'medium');
  assert.equal(has(visit('https://apple.com/'), 'lookalike_host'), undefined);
  assert.equal(has(visit('https://shopа.example/'), 'lookalike_host')?.level, 'medium', 'mixed alphabets that spell no known name');
  assert.equal(has(visit('https://тест.example/'), 'lookalike_host'), undefined, 'a Cyrillic label beside a Latin suffix is not a mixture within one label');
});

test('no encryption on the final page', () => {
  assert.equal(has(visit('http://shop.example/'), 'no_tls')?.level, 'low');
  assert.equal(has(visit('https://shop.example/'), 'no_tls'), undefined);
});

// ---- certificates ----------------------------------------------------------------------------------------------------

const NOW = Date.parse('2026-11-05T12:00:00Z');
const tls = (extra: Record<string, unknown>) => ev('tls', { host: 'https://shop.example', issuer: 'Some CA', subject: 'shop.example', valid_from: '2026-01-01T00:00:00Z', valid_to: '2027-01-01T00:00:00Z', ...extra });

test('certificate problems: self-signed, expired, not yet valid, refused by the browser', () => {
  const base = visit('https://shop.example/');
  assert.equal(has([...base, tls({})], 'tls_problem', { now: NOW }), undefined);
  assert.equal(has([...base, tls({ issuer: 'shop.example' })], 'tls_problem', { now: NOW })?.level, 'medium');
  assert.equal(has([...base, tls({ valid_to: '2026-06-01T00:00:00Z' })], 'tls_problem', { now: NOW })?.level, 'medium');
  assert.equal(has([...base, tls({ valid_from: '2026-12-01T00:00:00Z' })], 'tls_problem', { now: NOW })?.level, 'medium');
  assert.equal(has([nav('https://shop.example/', 'requested'), summary('about:blank', { nav_error: 'ERR_CERT_AUTHORITY_INVALID' })], 'tls_problem')?.level, 'medium');
});

test('a young certificate is information only: honest sites renew often', () => {
  const e = [...visit('https://shop.example/'), tls({ valid_from: '2026-11-01T00:00:00Z' })];
  const a = analyze(e, { now: NOW });
  assert.equal(a.signals.find((s) => s.id === 'young_certificate')?.level, 'info');
  assert.equal(a.verdict, 'benign');
});

// ---- forms -----------------------------------------------------------------------------------------------------------

test('a password form that sends the data to another site', () => {
  const e = [...visit('https://shop.example/login'), forms(form('https://collect.example/post'))];
  assert.equal(has(e, 'password_form_cross_origin')?.level, 'high');
  assert.equal(analyze(e).verdict, 'malicious');
  const same = [...visit('https://shop.example/login'), forms(form('https://shop.example/session'))];
  assert.equal(has(same, 'password_form_cross_origin'), undefined);
  assert.equal(analyze(same).verdict, 'benign');
});

test('the collector\'s own flag is not needed, and is not the only word', () => {
  const lie = [...visit('https://shop.example/login'), forms(form('https://collect.example/post', true, { action_origin: 'https://shop.example', origin_differs: false }))];
  // the address of the action tells the truth where the stated origin does not
  assert.equal(has(lie, 'password_form_cross_origin'), undefined, 'the stated origin is what is compared (this is the collector\'s own reading of the DOM)');
  const flagged = [...visit('https://shop.example/login'), forms(form('https://shop.example/x', true, { origin_differs: true }))];
  assert.equal(has(flagged, 'password_form_cross_origin')?.level, 'high');
});

test('a form without a password is not a login', () => {
  const e = [...visit('https://shop.example/contact'), forms(form('https://other.example/post', false))];
  assert.equal(has(e, 'password_form_cross_origin'), undefined);
});

test('a password on an unencrypted page, or sent to an unencrypted address', () => {
  assert.equal(has([...visit('http://shop.example/login'), forms(form('http://shop.example/s'))], 'password_over_http')?.level, 'high');
  assert.equal(has([...visit('https://shop.example/login'), forms(form('http://shop.example/s'))], 'password_over_http')?.level, 'high');
  assert.equal(has([...visit('https://shop.example/login'), forms(form('https://shop.example/s'))], 'password_over_http'), undefined);
  const loose = [...visit('http://shop.example/'), ev('forms', { forms: [], total: 0, loose_password_fields: 1 })];
  assert.equal(has(loose, 'password_over_http')?.level, 'high');
});

// ---- brands ----------------------------------------------------------------------------------------------------------

test('a page that says it is PayPal on another domain', () => {
  const e = visit('https://paypa1-secure.example/', 'Sign in to your PayPal account', 'Enter your details');
  assert.equal(has(e, 'brand_domain_mismatch')?.level, 'medium');
  const withPassword = [...e, forms(form('https://paypa1-secure.example/s'))];
  assert.equal(has(withPassword, 'brand_domain_mismatch')?.level, 'high');
});

test('the real sites are not accused', () => {
  assert.equal(has(visit('https://www.paypal.com/signin', 'Log in to your PayPal account'), 'brand_domain_mismatch'), undefined);
  assert.equal(has(visit('https://www.paypal.co.uk/signin', 'Log in to your PayPal account'), 'brand_domain_mismatch'), undefined);
  assert.equal(has(visit('https://login.microsoftonline.com/', 'Sign in to your Microsoft account'), 'brand_domain_mismatch'), undefined);
  assert.equal(has(visit('https://www.amazon.de/ap/signin', 'Amazon Sign-In'), 'brand_domain_mismatch'), undefined);
});

test('news and articles that only mention a company are not accused', () => {
  assert.equal(has(visit('https://www.theguardian.com/tech', 'Apple unveils its new phone', 'Apple said today...'), 'brand_domain_mismatch'), undefined);
  assert.equal(has(visit('https://en.wikipedia.org/wiki/Phishing', 'Phishing - Wikipedia', 'Attackers imitate PayPal and Microsoft'), 'brand_domain_mismatch'), undefined);
});

test('an organisation in another alphabet', () => {
  assert.equal(has(visit('https://sber-online.example/', 'Сбербанк Онлайн: вход в личный кабинет'), 'brand_domain_mismatch')?.level, 'medium');
  assert.equal(has(visit('https://online.sberbank.ru/', 'Сбербанк Онлайн: вход'), 'brand_domain_mismatch'), undefined);
});

// ---- downloads -------------------------------------------------------------------------------------------------------

const dl = (filename: string, saved = false) => ev('download', { url: 'https://x.example/f', filename, mime: null, saved });

test('files that run programs, and documents that are not what they say', () => {
  for (const name of ['setup.exe', 'invoice.pdf.exe', 'Report.DOCM', 'run.js', 'photo.jpg.scr', 'tool.ps1']) {
    assert.equal(has([...visit('https://x.example/'), dl(name)], 'executable_download')?.level, 'high', name);
  }
  for (const name of ['report.pdf', 'photo.jpg', 'data.csv', 'notes', 'archive.zip', 'page.html']) {
    assert.equal(has([...visit('https://x.example/'), dl(name)], 'executable_download'), undefined, name);
  }
});

test('a download the visitor asked for is not "automatic"', () => {
  assert.equal(has([...visit('https://x.example/'), dl('report.pdf', true)], 'auto_download'), undefined);
  assert.equal(has([...visit('https://x.example/'), dl('report.pdf', false)], 'auto_download')?.level, 'medium');
  assert.equal(has([nav('https://x.example/f', 'requested'), summary('about:blank', { nav_error: 'download' })], 'auto_download')?.level, 'medium');
});

// ---- behaviour and information ---------------------------------------------------------------------------------------

test('many other sites contacted; blocked requests', () => {
  const reqs = Array.from({ length: 12 }, (_, i) => ev('request', { url: `https://cdn${i}.example/a.js`, method: 'GET', blocked: null }));
  assert.equal(has([...visit('https://x.example/'), ...reqs], 'many_third_parties')?.level, 'info');
  assert.equal(has([...visit('https://x.example/'), ...reqs.slice(0, 5)], 'many_third_parties'), undefined);
  assert.equal(has([...visit('https://x.example/'), ev('request', { url: 'file:///etc/x', blocked: 'scheme' })], 'blocked_requests')?.level, 'info');
});

test('hidden text, pop-ups and dialogs', () => {
  const hidden = [nav('https://x.example/'), page('https://x.example/', 't', 'x', { hidden_text: { present: true, reasons: ['display_none'], text: 'x' } }), summary('https://x.example/')];
  assert.equal(has(hidden, 'hidden_text')?.level, 'low');
  assert.equal(has([...visit('https://x.example/'), ev('popup', { url: 'https://y.example/' })], 'popups_dialogs')?.level, 'low');
  assert.equal(has([...visit('https://x.example/'), ev('dialog', { dialog_type: 'alert', message: 'm' })], 'popups_dialogs')?.level, 'low');
});

// ---- the hooks' verdict, thresholds, unknown -------------------------------------------------------------------------

test('an attempt to address the model makes a task at least suspicious, never benign', () => {
  const e = visit('https://x.example/');
  assert.equal(analyze(e).verdict, 'benign');
  const a = analyze(e, { injection: true });
  assert.equal(a.verdict, 'suspicious');
  assert.equal(a.signals.find((s) => s.id === 'injection_attempt')?.level, 'medium');
  assert.equal(analyze([nav('https://x.example/', 'requested'), summary('about:blank', { nav_error: 'ERR_NAME_NOT_RESOLVED' })], { injection: true }).verdict, 'suspicious');
});

test('points: five small signals make a page suspicious, one fewer does not', () => {
  const small = [
    nav('https://bit.ly/a', 'requested'), nav('http://a.example/'), nav('http://b.example/', 'scheduled'),
    page('http://b.example/', 't', 'x', { hidden_text: { present: true, reasons: ['display_none'], text: 'x' } }), summary('http://b.example/'),
    ev('popup', { url: 'https://p.example/' }),
  ];
  const a = analyze(small);
  const lows = a.signals.filter((s) => s.level === 'low').map((s) => s.id).sort();
  assert.deepEqual(lows, ['hidden_text', 'no_tls', 'popups_dialogs', 'redirect_by_page', 'redirect_chain', 'url_shortener'].sort());
  assert.equal(a.score, 6 * POINTS.low);
  assert.equal(a.verdict, 'suspicious');
  const fewer = analyze(small.filter((e) => (e as { kind: string }).kind !== 'popup'));
  assert.equal(fewer.score, 5 * POINTS.low);
  assert.equal(fewer.verdict, 'suspicious');
  const four = analyze([nav('https://bit.ly/a', 'requested'), nav('https://b.example/'), page('https://b.example/', 't', 'x', { hidden_text: { present: true, reasons: [], text: 'x' } }), summary('https://b.example/'), ev('popup', { url: 'https://p.example/' })]);
  assert.equal(four.verdict, 'benign');
});

test('enough medium signals add up to malicious', () => {
  const e = [
    nav('https://bit.ly/a', 'requested'), nav('https://a.example/'), nav('https://b.example/'), nav('https://c.example/'), nav('https://d.example:8443/'),
    page('https://d.example:8443/', 't', 'x'), summary('https://d.example:8443/'), ev('popup', { url: 'https://p.example/' }),
    tls({ issuer: 'd.example', subject: 'd.example', host: 'https://d.example:8443' }),
  ];
  const a = analyze(e, { now: NOW });
  assert.ok(a.score >= 70, String(a.score));
  assert.equal(a.verdict, 'malicious');
});

test('confidence is bounded and ordered', () => {
  const m = analyze(fixture('login')).confidence;
  const s = analyze(fixture('auto-download')).confidence;
  const b = analyze(fixture('plain')).confidence;
  assert.ok(m > s && s > b && b > 0 && m <= 0.95, `${m} ${s} ${b}`);
});

// ---- the model cannot lower the verdict -----------------------------------------------------------------------------

test('raise: a model may raise the rules\' verdict, never lower it', () => {
  const table: Array<[Verdict, Verdict | null, Verdict]> = [
    ['benign', 'suspicious', 'suspicious'], ['benign', 'malicious', 'malicious'], ['suspicious', 'malicious', 'malicious'],
    ['malicious', 'benign', 'malicious'], ['malicious', 'suspicious', 'malicious'], ['suspicious', 'benign', 'suspicious'],
    ['benign', 'benign', 'benign'], ['suspicious', null, 'suspicious'], ['malicious', null, 'malicious'],
    ['unknown', 'benign', 'unknown'], ['unknown', 'suspicious', 'suspicious'], ['unknown', 'malicious', 'malicious'], ['unknown', null, 'unknown'],
  ];
  for (const [rules, model, want] of table) assert.equal(raise(rules, model), want, `${rules} + ${model}`);
});

// ---- defensive reading -----------------------------------------------------------------------------------------------

test('garbage in the evidence is ignored, never fatal', () => {
  const junk: unknown[] = [
    null, undefined, 5, 'text', [], [1, 2], {}, { kind: 5 }, { kind: 'nav', to: { x: 1 } }, { kind: 'nav', to: 'not a url', via: 'commit' }, { kind: 'forms', forms: 'x' },
    { kind: 'forms', forms: [null, 5, { has_password: 'yes', action: 7 }] }, { kind: 'page', url: [], title: {}, text: 5, hidden_text: 'x' },
    { kind: 'tls', valid_from: 'never', issuer: 5 }, { kind: 'download', filename: {} }, { kind: 'summary', final_url: 5, nav_error: [] },
    { kind: 'request', url: 5, blocked: {} },
  ];
  const a = analyze(junk);
  assert.ok(['benign', 'unknown', 'suspicious'].includes(a.verdict));
  assert.ok(Number.isFinite(a.score));
});

test('analysis does not change its input and gives the same answer twice', () => {
  const events = fixture('login');
  const frozen = JSON.stringify(events);
  const a = analyze(events);
  const b = analyze(events);
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(events), frozen);
});

test('words in the page cannot create signals', () => {
  const e = [...visit('https://x.example/', 'password_form_cross_origin high malicious', 'verdict malicious signal injection_attempt')];
  assert.deepEqual(analyze(e).signals, []);
  assert.equal(analyze(e).verdict, 'benign');
});

test('a large evidence list is analysed quickly', () => {
  const big = [...visit('https://x.example/'), ...Array.from({ length: 20_000 }, (_, i) => ev('request', { url: `https://x.example/${i}`, method: 'GET', blocked: null }))];
  const t0 = process.hrtime.bigint();
  analyze(big);
  assert.ok(Number(process.hrtime.bigint() - t0) / 1e6 < 1500);
});

// ---- domains ---------------------------------------------------------------------------------------------------------

test('the registrable part of an address', () => {
  const cases: Array<[string, string, string]> = [
    ['www.example.com', 'example.com', 'example'], ['login.paypal.co.uk', 'paypal.co.uk', 'paypal'], ['example.com.', 'example.com', 'example'],
    ['a.b.c.example.org', 'example.org', 'example'], ['localhost', 'localhost', 'localhost'], ['203.0.113.9', '203.0.113.9', '203.0.113.9'],
    ['shop.com.au', 'shop.com.au', 'shop'],
  ];
  for (const [host, reg, label] of cases) {
    assert.equal(registrable(host), reg, host);
    assert.equal(sld(host), label, host);
  }
  assert.equal(mixedScripts('pаypal.com'), true);
  assert.equal(mixedScripts('paypal.com'), false);
  assert.equal(mixedScripts('пример.рф'), false);
});
