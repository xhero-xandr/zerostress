// What the report says, decided from its data (carried over from web/server/test/app.test.ts with views.ts).
import { describe, expect, test } from 'vitest';
import { LOG_CODES } from '../../agent/agent-log.ts';
import { agentLines, asLink, asLogEntry, injectionText, noFindingsText, mailboxOf, panelFacts, linkFromQuery, linksFromEmail, logLine, logTime, ageWords, countryName, deadLinks, devicesSummary, findings, keyFromHash, serversLine, verdictLine } from '../src/logic.ts';
import { hostile, unread } from './fixtures.ts';
import { T } from '../src/text.ts';

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


describe('the agent log in our words', () => {
  test('every code has a sentence, and none says undefined', () => {
    for (const code of LOG_CODES) {
      const line = logLine({ t: 0, code, d: {} });
      expect(line.length, code).toBeGreaterThan(5);
      expect(line, code).not.toMatch(/undefined|NaN|null/);
    }
  });
  test('the values go into their places', () => {
    expect(logLine({ t: 0, code: 'vm_booting', d: { slot: 1, vcpu: 2, mem_mib: 1024, image: '7e016b2b2375' } })).toBe('Booting a fresh Firecracker microVM: 2 vCPUs, 1024 MiB, network slot 1, guest image 7e016b2b2375');
    expect(logLine({ t: 0, code: 'model_asked', d: { model: 'qwen3.8-27b', mode: 'vision' } })).toMatch(/qwen3\.8-27b on Vultr Serverless Inference, with the screenshot/);
    expect(logLine({ t: 0, code: 'vm_state', d: { state: 'failed', reason: 'net_setup' } })).toBe('The run stopped (net setup)');
    expect(logLine({ t: 0, code: 'rules_only', d: { reason: 'hooks_fired' } })).toMatch(/tried to instruct the model/);
    expect(logTime(12345)).toBe('+12.3 s');
  });
  test('only something shaped like an entry is taken from the stream', () => {
    expect(asLogEntry({ t: 1, code: 'page', d: {} })).not.toBeNull();
    for (const bad of [null, 5, 'x', { t: '1', code: 'page', d: {} }, { t: 1, code: 'page', d: [] }]) expect(asLogEntry(bad)).toBeNull();
  });
});

describe('links in an email', () => {
  test('plain text: addresses found, trailing punctuation dropped, duplicates once', () => {
    const links = linksFromEmail('Your parcel is waiting: https://track.example.com/p?id=7. Or see https://track.example.com/p?id=7, https://help.example.org/x)');
    expect(links.map((l) => l.url)).toEqual(['https://track.example.com/p?id=7', 'https://help.example.org/x']);
  });
  test('an HTML email: a link whose text shows another site is marked', () => {
    const html = '<p>Hello</p><a href="https://paypa1-secure.test/login">www.paypal.com</a> <a href="https://www.paypal.com/help">www.paypal.com/help</a> <a href="https://shop.test/">Open your account</a>';
    const links = linksFromEmail(html);
    expect(links.map((l) => [l.host, l.shown])).toEqual([['paypa1-secure.test', 'www.paypal.com'], ['www.paypal.com', null], ['shop.test', null]]);
  });
  test('the source of an email in quoted-printable', () => {
    const src = 'Content-Transfer-Encoding: quoted-printable\n\n<a href=3D"https://evil.test/very/long/pa=\nth?x=3D1">https://bank.example/</a>';
    expect(linksFromEmail(src).map((l) => [l.url, l.shown])).toEqual([['https://evil.test/very/long/path?x=1', 'https://bank.example/']]);
  });
  test('redirectors are unwrapped to the address a click really opens', () => {
    const safe = `https://eur01.safelinks.protection.outlook.com/?url=${encodeURIComponent('https://login-update.test/a?b=1')}&data=05`;
    const g = `https://www.google.com/url?q=${encodeURIComponent('https://target.test/')}&sa=D`;
    const links = linksFromEmail(`${safe}\n${g}\nhttps://www.google.com/search?q=https://not-a-redirect.test/`);
    expect(links.map((l) => [l.url, l.wrapper])).toEqual([['https://login-update.test/a?b=1', 'Microsoft Safe Links'], ['https://target.test/', 'Google'], ['https://www.google.com/search?q=https://not-a-redirect.test/', null]]);
  });
  test('a host that only starts with google is not taken for Google\'s redirector', () => {
    const inner = encodeURIComponent('https://www.mybank.example/login');
    for (const h of ['google.attacker.com', 'www.google.evil.test', 'google.com.attacker.net', 'google.co.uk.evil.test', 'google.c0m']) {
      expect(linksFromEmail(`https://${h}/url?q=${inner}`).map((l) => [l.host, l.wrapper])).toEqual([[h, null]]);
    }
    for (const h of ['google.com', 'www.google.de', 'google.co.uk', 'www.google.com.br']) {
      expect(linksFromEmail(`https://${h}/url?q=${inner}`).map((l) => [l.host, l.wrapper])).toEqual([['www.mybank.example', 'Google']]);
    }
  });
  test('only web addresses: no script, mail or data links, and no more than thirty', () => {
    expect(linksFromEmail('<a href="javascript:alert(1)">x</a><a href="mailto:a@b.c">m</a><a href="data:text/html,x">d</a>')).toEqual([]);
    const many = Array.from({ length: 50 }, (_, i) => `https://s${i}.example/`).join(' ');
    expect(linksFromEmail(many)).toHaveLength(30);
  });
  test('"/?u=" gives an address to check, nothing else', () => {
    expect(linkFromQuery('?u=https%3A%2F%2Fexample.com%2Fa')).toBe('https://example.com/a');
    expect(linkFromQuery('?u=javascript:alert(1)')).toBe('');
    expect(linkFromQuery('?x=1')).toBe('');
  });
});

test('injection notice: the page is blamed only when the detectors fired on it', () => {
  expect(injectionText({ injection_source: 'page' })).toBe(T.injection);
  expect(injectionText({ injection_source: null })).toBe(T.injection);
  expect(injectionText({ injection_source: 'answer' })).toBe(T.injectionAnswer);
  expect(T.injectionAnswer).not.toBe(T.injection);
  expect(T.injectionAnswer).toMatch(/Nothing like it was found on the page itself/);
});

test('a link into a webmail inbox is known by its host (and path), never by a lookalike', () => {
  expect(mailboxOf('https://mail.google.com/mail/u/0/?tab=rm&ogbl')).toBe('Gmail');
  expect(mailboxOf('https://outlook.live.com/mail/0/inbox/id/AQMk')).toBe('Outlook');
  expect(mailboxOf('https://outlook.office.com/owa/?path=/mail')).toBe('Outlook');
  expect(mailboxOf('https://www.icloud.com/mail/')).toBe('iCloud Mail');
  for (const no of ['https://mail.google.com.evil.test/mail', 'https://google.com/', 'https://www.icloud.com/photos', 'https://outlook.live.com/owa-fake', 'https://evil.test/?u=mail.google.com', 'not a url']) expect(mailboxOf(no), no).toBeNull();
});


test('the panel\'s facts: where it ended, what forms ask for, where they send it', () => {
  const f = panelFacts(hostile());
  const m = Object.fromEntries(f);
  expect(m['Final site']).toBeTruthy();
  expect(f.length).toBeGreaterThan(2);
  expect(f.every(([k, v]) => typeof k === 'string' && typeof v === 'string')).toBe(true);
});

test('the panel\'s facts for a file leave out our own page\'s site, age and servers, and keep its forms', () => {
  const file = { name: 'a.html', bytes: 1, sha256: 'c'.repeat(64), type: 'html', read: true, findings: [], links: [], entries: [], viewed: true, virustotal: null };
  const m = Object.fromEntries(panelFacts(hostile({ file })));
  for (const k of ['Final site', 'Redirects', 'Registered', 'Other sites']) expect(m[k], k).toBeUndefined();
  expect(Object.keys(m).some((k) => /server/i.test(k))).toBe(false);
  expect(m.Forms).toBeTruthy();
  expect(Object.fromEntries(panelFacts(hostile()))['Other sites']).toBeTruthy();
});

test('the deep-check hint says what really waits for approval: a download, never a form', () => {
  expect(T.deepHint).toMatch(/download/);
  expect(T.deepHint).not.toMatch(/such as (sending|submitting) a form/);
});

test('the deep-check box says how it differs from a normal check, on the home page and in the panel', () => {
  expect(T.deepHint).toMatch(/normal check/i);
  expect(T.deepHint).toMatch(/asks you before anything risky/);
  expect(T.panel.deepHint).toMatch(/slower/i);
  expect(T.panel.deepHint).toMatch(/asks you first/);
});

test('no rule finding next to a raised verdict says who raised it', () => {
  const so = hostile().second_opinion!;
  expect(noFindingsText({ verdict: 'benign', mode: 'vision', second_opinion: null })).toBe(T.noFindings);
  expect(noFindingsText({ verdict: 'unknown', mode: 'rules_only', second_opinion: null })).toBe(T.noFindings);
  expect(noFindingsText({ verdict: 'malicious', mode: 'vision', second_opinion: null })).toBe(T.noFindingsModel);
  expect(noFindingsText({ verdict: 'suspicious', mode: 'text', second_opinion: null })).toBe(T.noFindingsModel);
  expect(noFindingsText({ verdict: 'malicious', mode: 'rules_only', second_opinion: { ...so, malicious: true } })).toBe(T.noFindingsCloudflare);
  expect(noFindingsText({ verdict: 'malicious', mode: 'vision', second_opinion: { ...so, malicious: false } })).toBe(T.noFindingsModel);
  expect(noFindingsText({ verdict: 'suspicious', mode: 'rules_only', second_opinion: null })).toBe(T.noFindings);
});

test('a bare address, as people type it, becomes a link; questions, schemes and hosts without a domain do not', () => {
  for (const [typed, link] of [['google.com', 'https://google.com'], ['  vk.com ', 'https://vk.com'], ['www.tiktok.com/@user?x=1', 'https://www.tiktok.com/@user?x=1'], ['пример.рф/путь', 'https://пример.рф/путь'], ['example.com:8443/a', 'https://example.com:8443/a']]) expect(asLink(typed), typed).toBe(link);
  for (const same of ['https://google.com', 'http://x.example/', 'javascript:alert(1)', 'is google.com safe?', 'localhost:3000', 'hello', '1.2.3.4', 'mailto:a@b.example', 'a@b.example']) expect(asLink(same), same).toBe(same.trim());
});
