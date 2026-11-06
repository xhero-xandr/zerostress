// How the sections read, carried over from web/server/test/app.test.ts (the pages were server-rendered before spec 012).
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { EVIL, hostile, ID, status, unread } from '../test/fixtures.ts';
import { Behavior, Links, Network, Security, Summary } from './tabs.tsx';

afterEach(cleanup);

const ALL = { summary: Summary, security: Security, network: Network, links: Links, behavior: Behavior };

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
          if (v !== null) expect(v.startsWith(`/r/${ID}/screenshot.png?device=`), `${el.tagName} ${a}=${v}`).toBe(true);
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
  expect(screen.getByRole('img').getAttribute('src')).toBe(`/r/${ID}/screenshot.png?device=desktop`);
  cleanup();
  render(<Summary r={hostile()} status={status({ shots: { desktop: true, tablet: true, mobile: true } })} />);
  fireEvent.click(screen.getByRole('button', { name: 'Phone' }));
  expect(screen.getByRole('img').getAttribute('src')).toBe(`/r/${ID}/screenshot.png?device=mobile`);
  expect(screen.getByRole('button', { name: 'Phone' }).getAttribute('aria-pressed')).toBe('true');
  cleanup();
  render(<Summary r={hostile()} status={status({ shots: { desktop: false, tablet: false, mobile: false } })} />);
  expect(screen.queryByRole('img')).toBeNull();
  expect(document.body.textContent).toMatch(/No screenshot was taken/);
});
