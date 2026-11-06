// What the report says, decided from its data (carried over from web/server/test/app.test.ts with views.ts).
import { describe, expect, test } from 'vitest';
import { agentLines, ageWords, countryName, deadLinks, devicesSummary, findings, keyFromHash, serversLine, verdictLine } from './logic.ts';
import { hostile, unread } from './test/fixtures.ts';

describe('the sentence under the verdict', () => {
  test('a bot-check wall, an error answer and an empty page are told apart, and none is "no threat found"', () => {
    expect(verdictLine(unread('bot_challenge', 'x'))).toMatch(/bot-check page\), which an automated browser cannot pass/);
    expect(verdictLine(unread('http_error', 'x'))).toMatch(/answered our automated visit with an error/);
    expect(verdictLine(unread('empty_page', 'x'))).toMatch(/loaded but showed nothing/);
    expect(verdictLine(unread('something_else', 'x'))).toMatch(/could not be loaded or read/);
    for (const id of ['bot_challenge', 'http_error', 'empty_page']) expect(verdictLine(unread(id, 'x'))).not.toMatch(/nothing that points to a threat/);
  });

  test('the Cloudflare warning is a serious sign, never a bot-check or "no threat found"', () => {
    const warned = hostile({ verdict: 'suspicious', confidence: 0.6, signals: [{ id: 'provider_warning', level: 'medium', text: 'x' }] });
    expect(verdictLine(warned)).toMatch(/Cloudflare itself shows a warning/);
    expect(verdictLine(warned)).toMatch(/do not open this link/);
    expect(verdictLine(warned)).not.toMatch(/which an automated browser cannot pass/);
  });

  test('otherwise the line of the verdict', () => {
    expect(verdictLine(hostile({ verdict: 'benign', signals: [] }))).toMatch(/nothing that points to a threat/);
    expect(verdictLine(hostile())).toMatch(/clear signs of an attack/);
  });
});

test('findings: the serious first, and notes only when there are few findings', () => {
  const r = hostile({ signals: [{ id: 'a', level: 'low', text: 'l' }, { id: 'b', level: 'info', text: 'i' }, { id: 'c', level: 'high', text: 'h' }] });
  expect(findings(r).map((s) => s.level)).toEqual(['high', 'low', 'info']);
  const many = hostile({ signals: ['high', 'low', 'low', 'medium', 'info'].map((level, i) => ({ id: String(i), level, text: level })) });
  expect(findings(many).map((s) => s.level)).toEqual(['high', 'medium', 'low', 'low']);
});

test('the age of a domain in words', () => {
  expect(ageWords(0)).toBe('today');
  expect(ageWords(4)).toBe('4 days ago');
  expect(ageWords(1)).toBe('1 day ago');
  expect(ageWords(200)).toBe('7 months ago');
  expect(ageWords(5620)).toBe('15 years ago');
});

test('the dead-link note needs at least three dead links and at least half of all links', () => {
  const link = (goes: 'nowhere' | 'same', i: number) => ({ text: `l${i}`, host: '', other_site: false, goes });
  for (const [dead, live, note] of [[2, 0, false], [3, 0, true], [3, 7, false], [5, 5, true], [5, 6, false]] as const) {
    const links = [...Array.from({ length: dead }, (_, i) => link('nowhere', i)), ...Array.from({ length: live }, (_, i) => link('same', i + 100))];
    expect(deadLinks(hostile({}, { links })) !== null, `${dead} dead, ${live} live`).toBe(note);
  }
  expect(deadLinks(hostile({}, { links: Array.from({ length: 5 }, (_, i) => link('nowhere', i)) }))).toEqual({ nowhere: 5, total: 5 });
});

test('the servers in one line: addresses, countries without the unknown, sites, requests', () => {
  const servers = [
    { ip: '172.64.149.123', country: 'US', asn: 13335, org: 'Cloudflare, Inc.', hosts: ['shop.example', 'api.shop.example'], requests: 17 },
    { ip: '23.207.210.83', country: 'DE', asn: 20940, org: 'Akamai', hosts: ['img.example'], requests: 21 },
    { ip: '10.9.9.9', country: null, asn: null, org: null, hosts: [], requests: 1 },
  ];
  expect(serversLine(hostile({}, { servers, servers_total: 3, requests_total: 39 }))).toBe('The page connected to 3 addresses in 2 countries, serving 3 sites, to make 39 requests.');
  expect(countryName('US')).toBe('United States (US)');
  expect(countryName(null)).toBe('—');
});

test('what a phone and a tablet saw, in one sentence', () => {
  const dev = (over: object) => ({ device: 'mobile' as const, nav_error: null, final_host: 'shop.example', title: '', forms: 0, has_password: false, action_hosts: [], differs: [] as Array<'other_site' | 'password_only_here'>, image: true, ...over });
  expect(devicesSummary(hostile({}, { devices: [dev({ differs: ['password_only_here'] }), dev({ device: 'tablet', nav_error: 'timeout' })] }))).toMatch(/shows a password form to a phone or a tablet that a computer does not see/);
  expect(devicesSummary(hostile({}, { devices: [dev({ differs: ['other_site'] })] }))).toMatch(/behaves differently/);
  expect(devicesSummary(hostile({}, { devices: [dev({})] }))).toMatch(/the page was the same site with no new sign-in form/);
  expect(devicesSummary(hostile({}, { devices: [dev({}), dev({ device: 'tablet', nav_error: 'timeout' })] }))).toMatch(/not every attempt loaded/);
  expect(devicesSummary(hostile({}, { devices: [] }))).toBeNull();
});

test('the task key is read from the fragment only in its own shape', () => {
  const key = 'A'.repeat(43);
  expect(keyFromHash(`#k=${key}`)).toBe(key);
  expect(keyFromHash(`#x=1&k=${key}`)).toBe(key);
  expect(keyFromHash('#k=short')).toBe('');
  expect(keyFromHash(`#k=${'A'.repeat(20)}"><img`)).toBe('A'.repeat(20));
  expect(keyFromHash('')).toBe('');
});

describe('what the agent did', () => {
  test('a risky action says what became of it, in words', () => {
    const line = (status: string) => agentLines(hostile({ steps: [{ action: 'download', status }] }));
    expect(line('done')).toContain('Downloaded the file inside the sandbox, after your approval');
    expect(line('rejected')).toContain('Did not download the file: you said no');
    expect(line('expired')).toContain('Did not download the file: nobody decided in time');
    expect(agentLines(hostile({ steps: [{ action: 'scroll', status: 'done' }] }))).toContain('Agent action: scroll (done)');
  });

  test('a finished report never says it is still waiting', () => {
    const lines = agentLines(hostile({ pending_approval: 1 }));
    expect(lines.join(' ')).not.toMatch(/^Waiting|Waiting for your decision/);
    expect(lines).toContain('An action waited for your decision, but the check ended first');
  });
});
