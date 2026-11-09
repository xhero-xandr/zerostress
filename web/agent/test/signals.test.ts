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
  form: 0, action, method: 'post', ...(action ? { action_origin: new URL(action).origin } : {}), has_password: hasPassword, fields: [], ...extra,
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
  // the collector's flag decides only where the form gives no address of its own to compare
  const flagged = [...visit('https://shop.example/login'), forms(form('', true, { origin_differs: true }))];
  assert.equal(has(flagged, 'password_form_cross_origin')?.level, 'high');
  const sameSite = [...visit('https://shop.example/login'), forms(form('https://shop.example/x', true, { origin_differs: true }))];
  assert.equal(has(sameSite, 'password_form_cross_origin'), undefined);
});

test('a password sent to another host of the same site is not "another site"; a lookalike site is', () => {
  const bank = [...visit('https://www.bank.example/'), forms(form('https://connect.secure.bank.example/signon', true, { action_origin: 'https://connect.secure.bank.example', origin_differs: true }))];
  assert.equal(has(bank, 'password_form_cross_origin'), undefined);
  const away = [...visit('https://www.bank.example/'), forms(form('https://bank-example.evil.test/signon', true, { action_origin: 'https://bank-example.evil.test', origin_differs: true }))];
  assert.equal(has(away, 'password_form_cross_origin')?.level, 'high');
});

test('a brand is named by whole words only, and a brand\'s own site may name other brands', () => {
  const page = (url: string, title: string, text: string) => [...visit(url, title, text), forms(form(url, true))];
  // "purchase" does not name Chase
  assert.equal(has(page('https://www.shop.example/login', 'Sign in', 'Sign in to finish your purchase'), 'brand_domain_mismatch'), undefined);
  // Wells Fargo's own site mentions other brands: it is no one's lookalike
  assert.equal(has(page('https://www.wellsfargo.com/', 'Wells Fargo Sign On', 'Pay with PayPal or Apple Pay. Chase alternatives.'), 'brand_domain_mismatch'), undefined);
  // a site that is no brand's, with a sign-in naming one, still is
  assert.equal(has(page('https://secure-login.example/', 'Chase Online Sign in', 'Chase'), 'brand_domain_mismatch')?.level, 'high');
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
  const hidden = [nav('https://x.example/'), page('https://x.example/', 't', 'x', { hidden_text: { present: true, reasons: ['zero_size'], text: 'x' } }), summary('https://x.example/')];
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
    page('http://b.example/', 't', 'x', { hidden_text: { present: true, reasons: ['zero_size'], text: 'x' } }), summary('http://b.example/'),
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
  const four = analyze([nav('https://bit.ly/a', 'requested'), nav('https://b.example/'), page('https://b.example/', 't', 'x', { hidden_text: { present: true, reasons: ['transparent'], text: 'x' } }), summary('https://b.example/'), ev('popup', { url: 'https://p.example/' })]);
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
    // a name of one's own on a hosting service is a site of its own, not the service
    ['prasadmhetre2005.github.io', 'prasadmhetre2005.github.io', 'prasadmhetre2005'], ['a.b.pages.dev', 'b.pages.dev', 'b'],
    ['instagram-clone-x.vercel.app', 'instagram-clone-x.vercel.app', 'instagram-clone-x'], ['vercel.app', 'vercel.app', 'vercel'],
    ['n1790.2090313.meusitehostgator.com.br', '2090313.meusitehostgator.com.br', '2090313'], ['x.my.canva.site', 'x.my.canva.site', 'x'],
    // a country's own second level
    ['www.roblox.com.et', 'roblox.com.et', 'roblox'], ['shop.co.th', 'shop.co.th', 'shop'], ['www.example.co', 'example.co', 'example'],
  ];
  for (const [host, reg, label] of cases) {
    assert.equal(registrable(host), reg, host);
    assert.equal(sld(host), label, host);
  }
  assert.equal(mixedScripts('pаypal.com'), true);
  assert.equal(mixedScripts('paypal.com'), false);
  assert.equal(mixedScripts('пример.рф'), false);
});

test("a brand's name on a free hosting service is a reason (instagram-clone on vercel.app)", () => {
  for (const url of ['http://instagram-clone-konstantindev1.vercel.app/', 'https://paypal-verify.netlify.app/', 'https://paypal.vercel.app/', 'https://netflix-login.github.io/']) {
    const s = has(visit(url, 'Home', 'A feed of posts. '.repeat(30)), 'brand_on_shared_host');
    assert.equal(s?.level, 'medium', url);
  }
  assert.equal(analyze(visit('http://instagram-clone-konstantindev1.vercel.app/', 'Home', 'A feed. '.repeat(40))).verdict, 'suspicious', 'whatever the page shows this time');
});

test('a hosting name with no brand in it, or a brand only inside a longer word, is no reason', () => {
  for (const url of ['https://myblog.vercel.app/', 'https://microsoft.github.io/', 'https://chasewilson.netlify.app/', 'https://www.paypal.com/', 'https://appleseed-farm.pages.dev/']) {
    assert.equal(has(visit(url), 'brand_on_shared_host'), undefined, url);
  }
});

test("a page that names a brand on a hosting name made of it is no brand's own site", () => {
  const url = 'https://paypal.vercel.app/signin';
  const e = [nav(url, 'requested'), nav(url), page(url, 'PayPal: Log in', 'Log in to your PayPal account'), forms(form(url)), summary(url)];
  assert.ok(has(e, 'brand_domain_mismatch'), 'paypal.vercel.app is not PayPal');
  assert.equal(analyze(e).verdict, 'malicious');
});

// ---- a bot-check page is not the site -----------------------------------------------------------------------------

const req = (url: string, status = 200, resource_type = 'document') => ev('request', { url, method: 'GET', resource_type, status, mime: 'text/html', blocked: null, initiator: 'other' });

test('Cloudflare\'s wait page: no verdict, and the report says the real page was not seen', () => {
  const events = [nav('https://shop.example/', 'requested'), req('https://shop.example/', 403), req('https://shop.example/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1', 200, 'script'),
    nav('https://shop.example/'), page('https://shop.example/', 'Just a moment...', 'Checking if the site connection is secure'), summary('https://shop.example/')];
  const a = analyze(events);
  assert.deepEqual(a.signals.map((s) => s.id), ['bot_challenge']);
  assert.equal(a.verdict, 'unknown', 'a page nobody read is not "no threat found"');
  assert.equal(a.confidence, 0);
});

test('other bot walls are recognised by their title too, in other languages as well', () => {
  for (const title of ['Just a moment...', 'Attention Required! | Cloudflare', 'Checking your browser before accessing example.com', 'Verifying you are human. This may take a few seconds.', 'DDoS protection by Example', 'Access denied', 'Pardon Our Interruption', 'Проверяем, что вы не робот', 'Один момент…', 'Einen Moment…', 'Un instant…', 'Bestätigen Sie, dass Sie kein Roboter sind', 'しばらくお待ちください']) {
    const events = [nav('https://x.example/', 'requested'), nav('https://x.example/'), page('https://x.example/', title, 'wait'), summary('https://x.example/')];
    assert.equal(has(events, 'bot_challenge') !== undefined, true, title);
    assert.equal(analyze(events).verdict, 'unknown', title);
  }
});

test('a real page that only carries a captcha widget is read as usual', () => {
  const events = [nav('https://shop.example/login', 'requested'), req('https://shop.example/login', 200), req('https://challenges.cloudflare.com/turnstile/v0/api.js', 200, 'script'),
    req('https://shop.example/cdn-cgi/challenge-platform/scripts/jsd/main.js', 200, 'script'),
    nav('https://shop.example/login'), page('https://shop.example/login', 'Sign in to Shop', 'Sign in to your account to see orders, saved items and offers. '.repeat(8)),
    ev('links', { links: ['a', 'b', 'c', 'd', 'e'].map((x) => ({ ref: x, text: x, href: `https://shop.example/${x}`, origin_differs: false })) }), summary('https://shop.example/login')];
  assert.equal(has(events, 'bot_challenge'), undefined);
  assert.equal(analyze(events).verdict, 'benign');
});

test('a normal page with the word "access" or "security" in its title is not a wall', () => {
  for (const title of ['Access control in Postgres', 'Security checklist for small teams', 'Moment of truth: a review']) {
    assert.equal(has(visit('https://blog.example/post', title), 'bot_challenge'), undefined, title);
  }
});

test('a wall that also carries a real warning keeps the warning', () => {
  const events = [nav('https://x.example/', 'requested'), nav('https://x.example/'), page('https://x.example/', 'Just a moment...', 'wait'), forms(form('https://other.example/c')), summary('https://x.example/')];
  assert.equal(analyze(events).verdict, 'malicious');
});

// What the real collector saw on 5 November 2026 from this server (see the evidence: statuses, titles and text are as read).
const live = (url: string, o: { status: number; title: string; text: string; links?: number; forms?: number; extra?: string[] }) => [
  nav(url, 'requested'), req(url, o.status), ...(o.extra ?? []).map((u) => req(u, 200, 'script')), nav(url), page(url, o.title, o.text),
  ev('links', { links: Array.from({ length: o.links ?? 0 }, (_, i) => ({ ref: `e${i}`, text: `l${i}`, href: `${url}l${i}`, origin_differs: false })) }),
  forms(...Array.from({ length: o.forms ?? 0 }, () => form(`${url}x`, false))), summary(url)];

test('a DataDome captcha wall that answers 403 and loads its captcha frame afterwards (g2.com)', () => {
  const e = live('https://www.g2.com/', { status: 403, title: 'g2.com', text: '', extra: ['https://ct.captcha-delivery.com/c.js', 'https://www.g2.com/cdn-cgi/challenge-platform/scripts/jsd/main.js'] });
  e.splice(2, 0, req('https://geo.captcha-delivery.com/captcha/?initialCid=x', 200, 'document'));
  const a = analyze(e);
  assert.equal(a.verdict, 'unknown');
  assert.ok(a.signals.some((s) => s.id === 'bot_challenge'), 'the status that counts is the one of the page asked for, not of the captcha frame');
});

test('a bare "Forbidden" (glassdoor.com) is an error the site answered, not a page', () => {
  const a = analyze(live('https://www.glassdoor.com/', { status: 403, title: '', text: 'Forbidden' }));
  assert.equal(a.verdict, 'unknown');
  assert.deepEqual(a.signals.map((s) => s.id), ['http_error']);
  assert.match(a.signals[0]!.text, /HTTP 403/);
});

test('a human-check widget that is the whole page (nowsecure.nl) is a wall too', () => {
  const a = analyze(live('https://nowsecure.nl/', { status: 200, title: 'nowsecure.nl', text: 'NOWSECURE\nBY NODRIVER', forms: 2, extra: ['https://challenges.cloudflare.com/turnstile/v0/api.js'] }));
  assert.equal(a.verdict, 'unknown');
  assert.ok(a.signals.some((s) => s.id === 'bot_challenge'));
});

test('a block page with its own text and links (indeed.com) is still a wall', () => {
  const a = analyze(live('https://www.indeed.com/', { status: 403, title: 'Blocked - Indeed.com', text: 'Request Blocked '.repeat(40), links: 10, extra: ['https://www.indeed.com/cdn-cgi/challenge-platform/scripts/jsd/main.js'] }));
  assert.equal(a.verdict, 'unknown');
  assert.ok(a.signals.some((s) => s.id === 'bot_challenge'), 'named as a wall: the status and the wall script together');
});

test('only the status tells: a roomy page that the site refused, with a captcha frame loaded afterwards', () => {
  const e = live('https://www.g2.com/', { status: 403, title: 'Verify', text: 'Please confirm that you are a person before you continue. '.repeat(12), links: 6, extra: ['https://ct.captcha-delivery.com/c.js'] });
  e.splice(2, 0, req('https://geo.captcha-delivery.com/captcha/?initialCid=x', 200, 'document'));
  const a = analyze(e);
  assert.equal(a.verdict, 'unknown');
  assert.ok(a.signals.some((s) => s.id === 'bot_challenge'), 'the first document decides, not the captcha frame that follows');
});

// temu.com on 8 November 2026: the home page sent the visitor on to its own verification page, whose text was nothing
// but zero-width spaces and whose captcha was drawn later by a script, with no title and no wall script we know
test('a site that moves the visitor to its own verification page (temu.com) is a wall', () => {
  const wall = 'https://www.temu.com/bgn_verification.html?verifyCode=L6Nr&from=https%3A%2F%2Fwww.temu.com%2F';
  const e = [nav('https://www.temu.com/', 'requested'), req('https://www.temu.com/', 200), nav(wall), req(wall, 200), page(wall, '', '\u200b'.repeat(400)),
    ev('links', { links: [] }), forms(), summary(wall)];
  const a = analyze(e);
  assert.equal(a.verdict, 'unknown');
  assert.ok(a.signals.some((s) => s.id === 'bot_challenge'));
});

test('invisible characters are not text: a page of zero-width spaces is empty', () => {
  const e = [nav('https://x.example/', 'requested'), nav('https://x.example/'), page('https://x.example/', '', '\u200b\u200c\ufeff'.repeat(50)), summary('https://x.example/')];
  assert.ok(has(e, 'empty_page'));
  assert.equal(analyze(e).verdict, 'unknown');
});

test('"Security verification" as the title is a wall', () => {
  assert.ok(has(visit('https://x.example/', 'Security verification'), 'bot_challenge'));
});

test('a real page with "verification" or "captcha" in its address is read as usual', () => {
  const article = live('https://blog.example/why-captcha-fails/', { status: 200, title: 'Why captcha fails', text: 'Captchas cost people time and stop few bots. '.repeat(10), links: 6 });
  assert.equal(has(article, 'bot_challenge'), undefined, 'an article has text and links');
  const verifyEmail = live('https://shop.example/account/verification', { status: 200, title: 'Verify your email', text: 'Enter the code we sent you.', forms: 1 });
  assert.equal(has(verifyEmail, 'bot_challenge'), undefined, 'a page with a form is a page');
  const query = live('https://shop.example/?step=verification', { status: 200, title: '', text: 'Hi', links: 0 });
  assert.equal(has(query, 'bot_challenge'), undefined, 'only the path counts, not the query');
});

test('a small real landing page with links and a captcha widget, answered 200, is read as usual', () => {
  const a = analyze(live('https://small.example/', { status: 200, title: 'Small studio', text: 'We make furniture.', links: 5, extra: ['https://challenges.cloudflare.com/turnstile/v0/api.js'] }));
  assert.equal(a.verdict, 'benign', 'few words but real links: not a wall');
});

test('an ordinary site behind Cloudflare is read as usual', () => {
  const a = analyze(live('https://example.com/', { status: 200, title: 'Example Domain', text: 'This domain is for use in documentation examples without needing permission. '.repeat(4), links: 1, extra: ['https://example.com/cdn-cgi/challenge-platform/scripts/jsd/main.js'] }));
  assert.equal(a.verdict, 'benign');
  assert.equal(a.signals.some((s) => s.id === 'bot_challenge' || s.id === 'http_error'), false);
});

test('error statuses are errors, 200 is not, and the real error numbers are named', () => {
  for (const status of [401, 403, 404, 410, 429, 451, 500, 502, 503]) {
    const a = analyze(live('https://x.example/', { status, title: 'Oops', text: 'Something happened here. '.repeat(30), links: 4 }));
    assert.equal(a.verdict, 'unknown', String(status));
    assert.match(a.signals.find((s) => s.id === 'http_error')!.text, new RegExp(`HTTP ${status}`));
  }
  assert.equal(analyze(live('https://x.example/', { status: 200, title: 'Fine', text: 'Words '.repeat(80), links: 4 })).verdict, 'benign');
});

test('a page with nothing on it is not "no threat found"', () => {
  const a = analyze(live('https://x.example/', { status: 200, title: '', text: '' }));
  assert.equal(a.verdict, 'unknown');
  assert.deepEqual(a.signals.map((s) => s.id), ['empty_page']);
});

test('a wall never hides a real warning', () => {
  const e = live('https://x.example/', { status: 403, title: 'Just a moment...', text: 'wait' });
  e.splice(-1, 0, forms(form('https://other.example/c')));
  assert.equal(analyze(e).verdict, 'malicious');
});

// ---- Cloudflare's own warning is a verdict about the site, not a wall ------------------------------------------------
// Seen on 5 November 2026 on 28 of 50 live phishing addresses from the OpenPhish feed.

test('Cloudflare\'s "Suspected Phishing" page is a warning that raises the verdict, not a bot-check', () => {
  for (const [status, title, links] of [[403, 'Suspected Phishing | Cloudflare', 2], [200, 'Suspected Phishing | Cloudflare', 4], [403, 'Suspected Malware | Cloudflare', 0], [200, 'Suspected Malware | Cloudflare', 3]] as const) {
    const a = analyze(live('https://abc.pages.dev/', { status, title, text: 'Warning. Suspected phishing. Learn more.', links, extra: ['https://challenges.cloudflare.com/turnstile/v0/api.js'] }));
    assert.equal(a.verdict, 'suspicious', `${status} ${title}`);
    assert.deepEqual(a.signals.map((s) => s.id), ['provider_warning'], 'no bot_challenge, http_error or unreachable beside it');
    assert.equal(a.signals[0]?.level, 'medium');
    assert.match(a.signals[0]?.text ?? '', /Cloudflare/);
  }
});

test('the warning page is recognised by its title only, and only the Cloudflare one', () => {
  for (const title of ['Suspected Phishing', 'Suspected phishing sites and how to spot them', 'Report a suspected malware | Example', 'Cloudflare | Suspected Phishing', 'Report: Suspected Phishing | Cloudflare Radar']) {
    const a = analyze(live('https://blog.example/post', { status: 200, title, text: 'Words '.repeat(80), links: 4 }));
    assert.equal(a.signals.some((s) => s.id === 'provider_warning'), false, title);
  }
});

test('a model that says "benign" cannot lower the warning', () => {
  const a = analyze(live('https://abc.pages.dev/', { status: 403, title: 'Suspected Phishing | Cloudflare', text: 'x', links: 2 }));
  assert.equal(raise(a.verdict, 'benign'), 'suspicious');
});

// ---- hidden text: only the kinds that deceive -------------------------------------------------------------------------
// On 5 November 2026 the old rule fired on 39 of 50 live pages, because menus and dialogs are `display: none` everywhere.

test('parts of a page that are merely not on screen are not "hidden text"', () => {
  for (const reasons of [['not_rendered'], ['visibility'], ['clipped'], ['offscreen'], ['not_rendered', 'clipped', 'offscreen', 'visibility']]) {
    const e = [nav('https://x.example/'), page('https://x.example/', 't', 'x', { hidden_text: { present: true, reasons, text: 'Menu | Close | Skip to content' } }), summary('https://x.example/')];
    assert.equal(ids(e).includes('hidden_text'), false, reasons.join());
  }
});

test('text made invisible on purpose is still reported, whatever else is on the page', () => {
  for (const reason of ['zero_size', 'transparent', 'low_contrast']) {
    const e = [nav('https://x.example/'), page('https://x.example/', 't', 'x', { hidden_text: { present: true, reasons: ['not_rendered', reason], text: 'x' } }), summary('https://x.example/')];
    assert.equal(ids(e).includes('hidden_text'), true, reason);
  }
  const absent = [nav('https://x.example/'), page('https://x.example/', 't', 'x', { hidden_text: { present: false, reasons: ['zero_size'], text: '' } }), summary('https://x.example/')];
  assert.equal(ids(absent).includes('hidden_text'), false, 'present: false wins');
});

// ---- the age of the domain ----------------------------------------------------------------------------------------------------------------
test('a domain registered in the last weeks is a reason; an older one is not', () => {
  const evs = visit('https://shop.example/');
  const find = (days: number | null | undefined) => analyze(evs, { domainAgeDays: days }).signals.find((s) => s.id === 'young_domain');
  assert.equal(find(0)?.level, 'medium');
  assert.match(find(0)?.text ?? '', /registered today/);
  assert.match(find(1)?.text ?? '', /1 day ago/);
  assert.equal(find(29)?.level, 'medium');
  assert.match(find(29)?.text ?? '', /29 days ago/);
  assert.equal(find(30)?.level, 'low');
  assert.equal(find(89)?.level, 'low');
  for (const none of [90, 5000, null, undefined, -1, NaN, Infinity]) assert.equal(find(none as number), undefined, String(none));
});

test('a young domain adds exactly the weight of a medium reason, and never decides alone', () => {
  const evs = visit('https://shop.example/');
  const base = analyze(evs, { domainAgeDays: 5000 });
  const young = analyze(evs, { domainAgeDays: 3 });
  assert.equal(young.score - base.score, POINTS.medium);
  assert.notEqual(young.verdict, 'malicious');
  const withForm = [...evs, forms(form('https://other.example/login'))];
  assert.equal(analyze(withForm, { domainAgeDays: 3 }).score - analyze(withForm, { domainAgeDays: 5000 }).score, POINTS.medium);
});

test('a brand\'s own site that names other brands, or a word that only contains a brand, is no impersonation', () => {
  const bank = (title: string, text: string) => [...visit('https://www.wellsfargo.com/', title, text), forms(form('https://connect.secure.wellsfargo.com/auth', true))];
  assert.equal(has(bank('Wells Fargo Bank', 'Sign on. Pay with Apple Pay or PayPal. Chase your goals.'), 'brand_domain_mismatch'), undefined);
  const shop = [...visit('https://shop.example/login', 'Sign in', 'Your purchase history'), forms(form('https://shop.example/session', true))];
  assert.equal(has(shop, 'brand_domain_mismatch'), undefined, '"purchase" does not name Chase');
  const fake = [...visit('https://secure-login.example/', 'Sign in', 'Chase online banking'), forms(form('https://secure-login.example/s', true))];
  assert.equal(has(fake, 'brand_domain_mismatch')?.level, 'high');
});

// ---- a file read inside the sandbox ------------------------------------------------------------------------------------

const fileVisit = (f: Record<string, unknown>) => [
  ev('download', { url: 'https://zerostress.space/f/x', filename: String(f.filename ?? 'file.bin'), mime: 'application/octet-stream', saved: true, status: 200 }),
  ev('file', { filename: 'file.bin', file_type: 'other', bytes: 10, sha256: 'a'.repeat(64), findings: [], ext_mismatch: false, double_extension: false, ...f }),
  summary('https://zerostress.space/f/x', { nav_error: 'file' }),
];

test('each finding in a file is a reason of its own weight', () => {
  const cases: Array<[Record<string, unknown>, string, string]> = [
    [{ ext_mismatch: true, file_type: 'pe' }, 'file_disguised', 'high'],
    [{ double_extension: true }, 'file_double_extension', 'high'],
    [{ findings: [{ id: 'executable', detail: '' }] }, 'file_executable', 'high'],
    [{ findings: [{ id: 'script_file', detail: '' }] }, 'file_script', 'high'],
    [{ findings: [{ id: 'shortcut', detail: '' }] }, 'file_shortcut', 'high'],
    [{ findings: [{ id: 'macros', detail: '' }] }, 'file_macros', 'medium'],
    [{ findings: [{ id: 'macros', detail: '' }, { id: 'auto_exec', detail: 'AutoOpen' }] }, 'file_macros', 'high'],
    [{ findings: [{ id: 'external_template', detail: 'evil.example' }] }, 'file_remote_template', 'high'],
    [{ findings: [{ id: 'dde', detail: '' }] }, 'file_dde', 'high'],
    [{ findings: [{ id: 'ole_object', detail: '' }] }, 'file_embedded_object', 'medium'],
    [{ findings: [{ id: 'pdf_launch', detail: '' }] }, 'file_pdf_launch', 'high'],
    [{ findings: [{ id: 'pdf_javascript', detail: '' }] }, 'file_pdf_javascript', 'medium'],
    [{ findings: [{ id: 'pdf_javascript', detail: '' }, { id: 'pdf_open_action', detail: '' }] }, 'file_pdf_javascript', 'high'],
    [{ findings: [{ id: 'pdf_embedded_file', detail: '' }] }, 'file_pdf_embedded', 'medium'],
    [{ findings: [{ id: 'pdf_submit_form', detail: '' }] }, 'file_pdf_form', 'medium'],
    [{ findings: [{ id: 'archive_executable', detail: 'invoice.pdf.exe' }] }, 'file_archive_program', 'high'],
    [{ findings: [{ id: 'archive_encrypted', detail: '' }] }, 'file_archive_locked', 'medium'],
    [{ findings: [{ id: 'nested_archive', detail: '' }] }, 'file_nested_archive', 'low'],
    [{ findings: [{ id: 'disk_image', detail: '' }] }, 'file_disk_image', 'medium'],
    [{ findings: [{ id: 'html_smuggling', detail: '' }] }, 'file_html_smuggling', 'high'],
    [{ findings: [{ id: 'svg_script', detail: '' }] }, 'file_svg_script', 'high'],
    [{ findings: [{ id: 'html_password_form', detail: '' }] }, 'file_html_password', 'high'],
    [{ findings: [{ id: 'html_form_elsewhere', detail: 'evil.example' }] }, 'file_html_form_elsewhere', 'medium'],
    [{ findings: [{ id: 'html_obfuscated_script', detail: '' }] }, 'file_obfuscated', 'medium'],
    [{ findings: [{ id: 'html_redirect', detail: '' }] }, 'file_redirect', 'medium'],
    [{ findings: [{ id: 'macro_shell', detail: 'WScript.Shell' }] }, 'file_macro_shell', 'high'],
    [{ findings: [{ id: 'macro_download', detail: 'URLDownloadToFile' }] }, 'file_macro_download', 'high'],
    [{ findings: [{ id: 'macro_hotkey', detail: 'Application.OnKey' }] }, 'file_macro_hotkey', 'medium'],
    [{ findings: [{ id: 'macro_keystrokes', detail: 'SendKeys' }] }, 'file_macro_keystrokes', 'medium'],
    [{ findings: [{ id: 'pe_injection_api', detail: 'VirtualAllocEx, WriteProcessMemory' }] }, 'file_injection_api', 'high'],
    [{ findings: [{ id: 'pe_keyboard_api', detail: 'GetAsyncKeyState' }] }, 'file_keyboard_api', 'low'],
    [{ findings: [{ id: 'miner_strings', detail: 'stratum+tcp://pool.example:3333' }] }, 'file_miner', 'high'],
    [{ findings: [{ id: 'miner_strings', detail: 'xmrig' }] }, 'file_miner', 'medium'],
  ];
  for (const [f, id, level] of cases) {
    const s = analyze(fileVisit(f)).signals.find((x) => x.id === id);
    assert.equal(s?.level, level, `${id} from ${JSON.stringify(f)}`);
  }
  assert.match(analyze(fileVisit({ findings: [{ id: 'external_template', detail: 'evil.example' }] })).signals[0]!.text, /evil\.example/);
  assert.match(analyze(fileVisit({ ext_mismatch: true, file_type: 'pe' })).signals[0]!.text, /\(pe\)/, 'the content type as the collector names it');
  assert.equal(analyze(fileVisit({ findings: [{ id: 'archive_executable', detail: 'invoice.pdf.exe' }] })).verdict, 'malicious');
});

test('a file with nothing found is "nothing found", not "could not check"; an unknown finding is no reason', () => {
  const a = analyze(fileVisit({ file_type: 'pdf', findings: [{ id: 'something_new', detail: 'x' }] }));
  assert.deepEqual(a.signals.map((s) => s.id), []);
  assert.equal(a.verdict, 'benign');
  assert.equal(analyze([summary('https://x.example/', { nav_error: 'file' })]).verdict, 'unknown', 'no file read: nothing to say');
});

test('a file handed over is judged by what is inside it, not as a download a page offered; a brand page in it is no site', () => {
  const up = [ev('subject', { what: 'uploaded_file' }), ...fileVisit({ filename: 'Invoice-2026-11.docm', file_type: 'ooxml', findings: [{ id: 'macros', detail: '' }] })];
  const ids = analyze(up).signals.map((s) => s.id);
  assert.ok(ids.includes('file_macros'));
  assert.equal(ids.includes('executable_download'), false);
  assert.ok(analyze(fileVisit({ filename: 'Invoice-2026-11.docm' })).signals.some((s) => s.id === 'executable_download'), 'a page that offers it: still a reason');
  const url = 'https://zerostress.space/f/tok/view';
  const page = (subject: boolean) => [...(subject ? [ev('subject', { what: 'uploaded_file' })] : []), nav(url, 'requested'), nav(url), page_(url), forms(form('https://collect.evil.example/p')), summary(url)];
  const page_ = (u: string) => ev('page', { url: u, title: 'Microsoft 365 - Sign in', lang: 'en', text: 'Sign in', text_truncated: false, hidden_text: { present: false, reasons: [], text: '' }, meta: [] });
  assert.match(has(page(true), 'brand_domain_mismatch')!.text, /as Microsoft, but it is a file someone sent, not Microsoft's site/);
  assert.match(has(page(false), 'brand_domain_mismatch')!.text, /its address is zerostress/);
});
