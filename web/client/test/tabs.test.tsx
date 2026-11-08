// How the sections read, carried over from web/server/test/app.test.ts (the pages were server-rendered before spec 012).
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render as rtlRender, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, test } from 'vitest';
import { EVIL, hostile, ID, status, unread } from './fixtures.ts';
import { Behavior, Links, Network, Security, Summary } from '../src/pages/tabs.tsx';
import { AgentLog } from '../src/pages/agent-log.tsx';
import type { PublicReport } from '../../agent/report-types.ts';

const Agent = ({ r }: { r: PublicReport }) => <AgentLog entries={r.log} />;

afterEach(cleanup);

// the sections live inside the router and the query cache of the app (the second opinion asks for both)
const Providers = ({ children }: { children: ReactNode }) => <QueryClientProvider client={new QueryClient()}><MemoryRouter>{children}</MemoryRouter></QueryClientProvider>;
const render = (ui: ReactNode) => rtlRender(ui, { wrapper: Providers });

const ALL = { summary: Summary, security: Security, network: Network, links: Links, behavior: Behavior, agent: Agent };

describe('every text that comes from outside stays text, on every section', () => {
  for (const [name, Tab] of Object.entries(ALL)) {
    test(name, () => {
      const { container } = render(<Tab r={hostile()} status={status()} />);
      expect(container.querySelectorAll('script, style, iframe, object, embed').length).toBe(0);
      for (const el of container.querySelectorAll('*')) {
        for (const a of el.getAttributeNames()) expect(a.startsWith('on'), `${el.tagName} ${a}`).toBe(false);
      }
      // the only addresses are ours: the screenshot of this very task, never one taken from the report
      for (const el of container.querySelectorAll('[href], [src], [srcset], [action]')) {
        for (const a of ['href', 'src', 'srcset', 'action']) {
          const v = el.getAttribute(a);
          if (v !== null) expect(v.startsWith(`/r/${ID}/screenshot.png?device=`) || v === `/r/${ID}/second-opinion.png`, `${el.tagName} ${a}=${v}`).toBe(true);
        }
      }
      expect(container.querySelectorAll('img:not([src^="/r/"])').length).toBe(0);
      expect(container.textContent).toContain(EVIL.slice(0, 30));
    });
  }
});

test('a wall is "could not check", never "no threat found"', () => {
  render(<Summary r={unread('bot_challenge', 'The site showed a bot-check page.')} status={status()} />);
  expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Could not check');
  expect(document.body.textContent).toMatch(/which an automated browser cannot pass/);
  expect(document.body.textContent).not.toMatch(/No threat found|Our confidence/);
});

test('the security section says what a form asks for', () => {
  render(<Security r={hostile({}, { forms: [{ action_host: 'shop.example', cross_origin: false, has_password: true, asks: ['password', 'card_number', 'card_security'] }] })} />);
  expect(document.body.textContent).toMatch(/Asks for: a password, a card number, the card security code/);
});

describe('the domain', () => {
  test('a new one: date, age and the mark', () => {
    render(<Security r={hostile({}, { domain: { name: 'shop.example', created: '2026-11-01T00:00:00.000Z', age_days: 4, registrar: '<i>Reg</i>' } })} />);
    const t = document.body.textContent!;
    expect(t).toMatch(/2026-11-01/);
    expect(t).toMatch(/4 days ago/);
    expect(screen.getByText('new')).toBeTruthy();
    expect(t).toContain('<i>Reg</i>');
    expect(document.querySelector('i')).toBeNull();
  });
  test('an old one is not marked', () => {
    render(<Security r={hostile({}, { domain: { name: 'decathlon.si', created: '2011-06-17T00:00:00.000Z', age_days: 5620, registrar: null } })} />);
    expect(document.body.textContent).toMatch(/15 years ago/);
    expect(screen.queryByText('new')).toBeNull();
  });
  test('an unknown one says so', () => {
    render(<Security r={hostile({}, { domain: null })} />);
    expect(document.body.textContent).toMatch(/age of the domain is not known/);
  });
});

test('the security section tells what a phone saw that a computer did not; a device that did not open names no site', () => {
  const devices = [
    { device: 'mobile' as const, nav_error: null, final_host: 'shop.example', title: '<b>Sign in</b>', forms: 1, has_password: true, action_hosts: ['evil.example'], differs: ['password_only_here' as const], image: true },
    { device: 'tablet' as const, nav_error: 'timeout', final_host: 'ghost.example', title: '', forms: 0, has_password: false, action_hosts: [], differs: [], image: false },
  ];
  render(<Security r={hostile({}, { devices })} />);
  const t = document.body.textContent!;
  expect(t).toMatch(/On a phone and a tablet/);
  expect(t).toMatch(/shows a password form to a phone or a tablet that a computer does not see/);
  expect(t).toMatch(/It asks for a password only here/);
  expect(t).toMatch(/The page did not open/);
  expect(t).not.toMatch(/ghost\.example/);
  expect(document.querySelector('b')).toBeNull();
  cleanup();
  render(<Security r={hostile({}, { devices: [] })} />);
  expect(document.body.textContent).not.toMatch(/On a phone and a tablet/);
});

test('the links section says plainly where links go, and when most lead nowhere', () => {
  render(<Links r={hostile({}, { links: Array.from({ length: 5 }, (_, i) => ({ text: `Help ${i}`, host: '', other_site: false, goes: 'nowhere' as const })) })} />);
  expect(screen.getAllByText('Nowhere (stays on the page)').length).toBe(5);
  expect(document.body.textContent).toMatch(/5 of 5 links lead nowhere/);
  cleanup();
  render(<Links r={hostile({}, { links: [{ text: 'a', host: '', other_site: false, goes: 'same' }, { text: 'b', host: 'other.example', other_site: true, goes: 'other' }, { text: 'c', host: '', other_site: false, goes: 'nowhere' }] })} />);
  const t = document.body.textContent!;
  expect(t).not.toMatch(/lead nowhere/);
  expect(t).toMatch(/Another page of this site/);
  expect(t).toMatch(/other\.example/);
});

test('the network section lists the servers with their country and network; the attribution only where the database was used', () => {
  const servers = [
    { ip: '172.64.149.123', country: 'US', asn: 13335, org: 'Cloudflare, Inc.', hosts: ['shop.example'], requests: 17 },
    { ip: '23.207.210.83', country: 'DE', asn: 20940, org: '<b>Akamai</b>', hosts: ['img.example'], requests: 21 },
  ];
  render(<Network r={hostile({}, { servers, servers_total: 2 })} />);
  const t = document.body.textContent!;
  for (const s of ['United States (US)', 'Germany (DE)', 'AS13335', '172.64.149.123', 'IP Geolocation by DB-IP', '<b>Akamai</b>']) expect(t).toContain(s);
  expect(document.querySelector('b')).toBeNull();
  cleanup();
  render(<Network r={hostile({}, { servers: [{ ip: '10.0.0.1', country: null, asn: null, org: null, hosts: [], requests: 1 }], servers_total: 1 })} />);
  expect(document.body.textContent).not.toMatch(/DB-IP/);
  cleanup();
  render(<Network r={hostile({}, { servers: [], servers_total: 0 })} />);
  expect(document.body.textContent).toMatch(/No server addresses were recorded/);
  expect(document.body.textContent).not.toMatch(/DB-IP/);
});

test('the screenshot can be switched by device only when there is more than one image', () => {
  render(<Summary r={hostile()} status={status()} />);
  expect(screen.queryByRole('group', { name: 'Screenshot for a device' })).toBeNull();
  expect(screen.getByRole('img', { name: /taken in the sandbox/ }).getAttribute('src')).toBe(`/r/${ID}/screenshot.png?device=desktop`);
  cleanup();
  render(<Summary r={hostile()} status={status({ shots: { desktop: true, tablet: true, mobile: true } })} />);
  fireEvent.click(screen.getByRole('button', { name: 'Phone' }));
  expect(screen.getByRole('img', { name: /taken in the sandbox/ }).getAttribute('src')).toBe(`/r/${ID}/screenshot.png?device=mobile`);
  expect(screen.getByRole('button', { name: 'Phone' }).getAttribute('aria-pressed')).toBe('true');
  cleanup();
  render(<Summary r={hostile()} status={status({ shots: { desktop: false, tablet: false, mobile: false } })} />);
  expect(screen.queryByRole('img', { name: /taken in the sandbox/ })).toBeNull();
  expect(document.body.textContent).toMatch(/No screenshot was taken/);
});

test('what others know: each source in words, a listing marked; a wall nobody knows anything bad about is said so', () => {
  const clean = { google: [], spamhaus: 'clean', virustotal: { malicious: 0, suspicious: 0, total: 90 }, urlscan: false };
  const walled = { ...unread('bot_challenge', 'A wall.'), reputation: clean, second_opinion: { ...hostile().second_opinion!, malicious: false, status: 200 } } as PublicReport;
  render(<Summary r={walled} status={status()} />);
  const card = screen.getByRole('region', { name: 'What others already know' });
  expect(card.textContent).toMatch(/not on Google’s lists/);
  expect(card.textContent).toMatch(/no engine flags the domain \(90 checked\)/);
  expect(document.body.textContent).toMatch(/nothing known speaks against it/);
  expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Nothing known against it');
  expect(document.body.textContent).toMatch(/we did not see the page ourselves/);
  cleanup();
  // Cloudflare could not see it either (403): nothing is said that was not seen
  render(<Summary r={{ ...walled, second_opinion: { ...walled.second_opinion!, status: 403 } }} status={status()} />);
  expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Could not check');
  cleanup();
  render(<Summary r={{ ...walled, second_opinion: { ...walled.second_opinion!, status: 403 } }} status={status()} />);
  expect(document.body.textContent).not.toMatch(/nothing known speaks against it/);
  cleanup();
  render(<Summary r={{ ...hostile(), reputation: { google: ['SOCIAL_ENGINEERING'], spamhaus: 'phish', virustotal: { malicious: 4, suspicious: 0, total: 90 }, urlscan: true } }} status={status()} />);
  const bad = screen.getByRole('region', { name: 'What others already know' });
  expect(bad.textContent).toMatch(/listed as social engineering/);
  expect(bad.textContent).toMatch(/listed for phishing/);
  expect(bad.textContent).toMatch(/4 of 90 engines flag the domain/);
  expect(bad.textContent).toMatch(/marked malicious/);
  expect(document.body.textContent).not.toMatch(/nothing known speaks against it/);
});
