import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildFacts } from '../facts.ts';

const ev = (kind: string, o: Record<string, unknown> = {}) => ({ type: 'evidence', v: 1, kind, t: 0, ...o });
const field = (o: Record<string, unknown>) => ({ visible: true, type: 'text', name: '', label: '', autocomplete: '', password: false, ...o });

test('links: nowhere, this site, another site', () => {
  const link = (href: string, origin_differs = false) => ({ ref: 'e1', text: 'x', href, origin_differs });
  const facts = buildFacts([ev('links', { links: [link(''), link('#'), link('#top'), link('javascript:void(0)'), link('JavaScript:alert(1)'), link('/help'), link('https://x.example/a'), link('https://other.example/', true)] })]);
  assert.deepEqual(facts.links.map((l) => l.goes), ['nowhere', 'nowhere', 'nowhere', 'nowhere', 'nowhere', 'same', 'same', 'other']);
  assert.equal(facts.links[7]?.other_site, true);
});

test('forms: what they ask for, in our words', () => {
  const facts = buildFacts([ev('forms', { forms: [
    { action: 'https://x.example/pay', origin_differs: false, has_password: true, fields: [field({ type: 'password', password: true }), field({ name: 'cc-number', autocomplete: 'cc-number' }), field({ name: 'cvv' }), field({ type: 'hidden', name: 'token' })] },
    { action: '', origin_differs: false, has_password: false, fields: [] },
  ] })]);
  assert.deepEqual(facts.forms[0]?.asks, ['password', 'card_number', 'card_security']);
  assert.deepEqual(facts.forms[1]?.asks, []);
});

test('hidden text: only the deceptive kinds', () => {
  const page = (reasons: string[]) => buildFacts([ev('page', { url: 'https://x.example/', title: 't', text: 'x', hidden_text: { present: true, reasons, text: 'x' } })]);
  assert.equal(page(['not_rendered', 'offscreen']).hidden_text, false);
  assert.equal(page(['not_rendered', 'zero_size']).hidden_text, true);
});

test('garbage in the evidence gives empty facts, not a crash', () => {
  const facts = buildFacts([null, 5, 'x', ev('forms', { forms: [null, 5, { fields: 'x' }] }), ev('links', { links: [null, { href: 5 }] })]);
  assert.equal(facts.forms.length, 1);
  assert.deepEqual(facts.forms[0]?.asks, []);
  assert.equal(facts.links[0]?.goes, 'nowhere');
});

const geoOf = (ip: string) => (ip === '1.1.1.1' ? { country: 'AU', asn: 13335, org: 'Cloudflare, Inc.' } : { country: null, asn: null, org: null });

test('servers: one entry per address, busiest first, with the sites it served and its place', () => {
  const req = (url: string, ip: unknown) => ev('request', { url, method: 'GET', resource_type: 'script', status: 200, mime: null, blocked: null, initiator: '', ip });
  const facts = buildFacts([
    req('https://c.example/', '9.9.9.9'), req('https://d.example/', '2606:4700::1'),
    req('https://a.example/1', '1.1.1.1'), req('https://a.example/2', '1.1.1.1'), req('https://b.example/x', '1.1.1.1'),
  ], { geo: geoOf });
  assert.deepEqual(facts.servers[0], { ip: '1.1.1.1', country: 'AU', asn: 13335, org: 'Cloudflare, Inc.', hosts: ['a.example', 'b.example'], requests: 3 });
  assert.deepEqual(facts.servers.map((s) => s.ip), ['1.1.1.1', '9.9.9.9', '2606:4700::1']);
  assert.equal(facts.servers[1]?.country, null);
  assert.equal(facts.servers_total, 3);
});

test('servers: an address that is not an address is not kept, and without a database no place is named', () => {
  const req = (ip: unknown) => ev('request', { url: 'https://a.example/', ip });
  const facts = buildFacts([req('999.1.1.1'), req('<script>'), req(null), req(7), req(''), req('8.8.8.8')]);
  assert.deepEqual(facts.servers, [{ ip: '8.8.8.8', country: null, asn: null, org: null, hosts: ['a.example'], requests: 1 }]);
});

test('servers: no more than 20 are kept but all are counted; the owner name is cut', () => {
  const evs = Array.from({ length: 30 }, (_, i) => ev('request', { url: `https://h${i}.example/`, ip: `10.0.0.${i + 1}` }));
  const facts = buildFacts(evs, { geo: () => ({ country: 'DE', asn: 1, org: 'x'.repeat(200) }) });
  assert.equal(facts.servers.length, 20);
  assert.equal(facts.servers_total, 30);
  assert.equal(facts.servers[0]?.org?.length, 80);
});

test('domain: passed through, with its text cut', () => {
  const facts = buildFacts([], { domain: { domain: 'x.example', created: '2026-11-01T00:00:00.000Z', age_days: 4, registrar: 'r'.repeat(300) } });
  assert.deepEqual(facts.domain, { name: 'x.example', created: '2026-11-01T00:00:00.000Z', age_days: 4, registrar: 'r'.repeat(80) });
  assert.equal(buildFacts([]).domain, null);
});
