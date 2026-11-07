import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, expect, test, vi } from 'vitest';
import { SecondOpinion } from '../src/pages/second-opinion.tsx';
import { EVIL, ID, unread } from './fixtures.ts';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const KEY = 'k'.repeat(43);
const OPINION = { source: 'submitted', scan_id: '11111111-2222-4333-8444-555555555555', scanned_at: '2026-11-07T12:00:00.000Z', final_host: 'www.decathlon.si', status: 200, title: `Decathlon ${EVIL}`, title_withheld: false, malicious: false, screenshot: true };
const show = (hash: string) => render(
  <QueryClientProvider client={new QueryClient()}><MemoryRouter initialEntries={[`/r/${ID}${hash}`]}><SecondOpinion r={{ ...unread('bot_challenge', 'A wall.'), second_opinion: null }} id={ID} /></MemoryRouter></QueryClientProvider>,
);

test('without the owner key there is no button, only a word on who can ask', () => {
  show('');
  expect(screen.queryByRole('button')).toBeNull();
  expect(document.body.textContent).toMatch(/person who started this check/);
});

test('the owner asks; a new public scan waits for an explicit yes; the answer is shown as text', async () => {
  const calls: Array<{ url: string; body: string; key: string | null }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, body: String(init.body), key: new Headers(init.headers).get('x-task-key') });
    const yes = String(init.body).includes('publish');
    return new Response(JSON.stringify(yes ? { second_opinion: OPINION } : { code: 'needs_consent', message: 'Say yes.' }), { status: yes ? 200 : 409 });
  }));
  show(`#k=${KEY}`);
  fireEvent.click(screen.getByRole('button', { name: /Ask Cloudflare/ }));
  await screen.findByRole('alertdialog');
  expect(calls).toEqual([{ url: `/api/tasks/${ID}/second-opinion`, body: '{}', key: KEY }]);
  fireEvent.click(screen.getByRole('button', { name: /Yes, publish/ }));
  await waitFor(() => expect(document.body.textContent).toMatch(/A new public scan we sent/));
  expect(calls[1]!.body).toBe('{"publish":true}');
  expect(document.body.textContent).toContain(`Decathlon ${EVIL}`);
  expect(document.querySelectorAll('script').length).toBe(0);
  expect(screen.getByRole('img').getAttribute('src')).toBe(`/r/${ID}/second-opinion.png`);
});

test('"no" asks nothing more', async () => {
  const f = vi.fn(async () => new Response(JSON.stringify({ code: 'needs_consent', message: 'Say yes.' }), { status: 409 }));
  vi.stubGlobal('fetch', f);
  show(`#k=${KEY}`);
  fireEvent.click(screen.getByRole('button', { name: /Ask Cloudflare/ }));
  await screen.findByRole('alertdialog');
  fireEvent.click(screen.getByRole('button', { name: /No, leave it/ }));
  expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(f).toHaveBeenCalledTimes(1);
});
