// The rules, the report and the dossier describe the same visit: for the same evidence they must give the same
// answers (review A2). Each case is one the three used to read differently.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyze } from '../signals.ts';
import { buildFacts } from '../facts.ts';
import { buildDossier } from '../dossier.ts';

const ev = (kind: string, o: Record<string, unknown> = {}) => ({ type: 'evidence', v: 1, kind, t: 0, ...o });
const URL0 = 'https://shop.example/login';
const request = (url: string, blocked: unknown = null) => ev('request', { url, method: 'GET', resource_type: 'script', status: 200, mime: null, blocked, initiator: '', ip: '' });
const base = (extra: unknown[]) => [
  ev('nav', { via: 'requested', from: '', to: URL0 }), ev('nav', { via: 'commit', from: '', to: URL0 }),
  ev('page', { url: URL0, title: 'Sign in', text: 'Sign in', text_truncated: false, hidden_text: { present: false, reasons: [], text: '' }, meta: [] }),
  ...extra,
  ev('summary', { final_url: URL0, nav_error: null }),
];
const all = (events: unknown[]) => {
  const analysis = analyze(events);
  return { analysis, facts: buildFacts(events), dossier: buildDossier(events, analysis, 'text') };
};

test('other sites: the same count in the signal and in the report; the page\'s own host, over either scheme, is not one', () => {
  const urls = [
    'https://shop.example/a.js', 'http://shop.example/b.js', // the page itself, whatever the scheme
    ...Array.from({ length: 11 }, (_, i) => `https://cdn${i}.example/x.js`),
    'https://cdn0.example/y.js', 'http://cdn0.example/z.js', // the same host again: one site, not three
  ];
  const { analysis, facts } = all(base(urls.map((u) => request(u))));
  assert.equal(facts.third_party_hosts, 11);
  assert.match(analysis.signals.find((s) => s.id === 'many_third_parties')?.text ?? '', /contacted 11 other sites/);
});

test('blocked requests: only a reason given as text counts, everywhere the same', () => {
  const events = base([request('https://a.example/1', 'net::ERR_BLOCKED_BY_CLIENT'), request('https://a.example/2', ''), request('https://a.example/3', true), request('https://a.example/4', null), request('https://a.example/5', false)]);
  const { analysis, facts } = all(events);
  assert.equal(facts.blocked_requests, 1);
  assert.equal(analysis.signals.find((s) => s.id === 'blocked_requests')?.refs.length, 1);
});

test('a form that only names its action (no action_origin) is compared by site too', () => {
  const form = (action: string, flag: boolean) => ev('forms', { forms: [{ form: 0, action, method: 'post', has_password: true, origin_differs: flag, fields: [] }], total: 1, loose_password_fields: 0 });
  for (const [action, flag, crosses] of [
    ['https://evil.example/steal', false, true],
    ['https://pay.shop.example/ok', true, false],
  ] as const) {
    const { analysis, facts, dossier } = all(base([form(action, flag)]));
    assert.equal(analysis.signals.some((s) => s.id === 'password_form_cross_origin'), crosses, `signal for ${action}`);
    assert.equal(facts.forms[0]?.cross_origin, crosses, `report for ${action}`);
    assert.equal((dossier.json.forms as Array<{ cross_origin: boolean }> | undefined)?.[0]?.cross_origin, crosses, `dossier for ${action}`);
  }
});

test('a password form sent to another site: the signal and the report say the same, whatever the collector\'s flag says', () => {
  const form = (action: string, flag: boolean) => ev('forms', { forms: [{ form: 0, action, action_origin: new URL(action).origin, method: 'post', has_password: true, origin_differs: flag, fields: [] }], total: 1, loose_password_fields: 0 });
  for (const [action, flag, crosses] of [
    ['https://evil.example/steal', false, true], // the flag says "same" but the form really goes elsewhere
    ['https://pay.shop.example/ok', true, false], // the flag says "other" but it is the same site
    ['https://shop.example/post', false, false],
  ] as const) {
    const { analysis, facts, dossier } = all(base([form(action, flag)]));
    assert.equal(analysis.signals.some((s) => s.id === 'password_form_cross_origin'), crosses, `signal for ${action}`);
    assert.equal(facts.forms[0]?.cross_origin, crosses, `report for ${action}`);
    assert.equal((dossier.json.forms as Array<{ cross_origin: boolean }> | undefined)?.[0]?.cross_origin, crosses, `dossier for ${action}`);
  }
});
