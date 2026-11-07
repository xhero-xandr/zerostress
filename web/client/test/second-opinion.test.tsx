import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, expect, test, vi } from 'vitest';
import { SecondOpinion } from '../src/pages/second-opinion.tsx';
import { EVIL, ID, unread } from './fixtures.ts';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const KEY = 'k'.repeat(43);
const OPINION = { source: 'submitted', scan_id: '11111111-2222-4333-8444-555555555555', scanned_at: '2026-11-07T12:00:00.000Z', final_host: 'www.decathlon.si', status: 200, title: `Decathlon ${EVIL}`, title_withheld: false, malicious: false, screenshot: true };
const show = (hash: string, state: 'asking' | 'failed' = 'failed') => render(
  <QueryClientProvider client={new QueryClient()}><MemoryRouter initialEntries={[`/r/${ID}${hash}`]}><SecondOpinion r={{ ...unread('bot_challenge', 'A wall.'), second_opinion: null, second_opinion_state: state }} id={ID} /></MemoryRouter></QueryClientProvider>,
);

test('while the server asks Cloudflare on its own, the page says so and offers nothing to press', () => {
  show(`#k=${KEY}`, 'asking');
  expect(screen.queryByRole('button')).toBeNull();
  expect(screen.getByRole('status').textContent).toMatch(/Asking Cloudflare/);
  expect(document.body.textContent).toMatch(/unlisted, seen only by us/);
});

test('after a failure, without the owner key there is no button, only a word on who can ask', () => {
  show('');
  expect(screen.queryByRole('button')).toBeNull();
  expect(document.body.textContent).toMatch(/could not answer this time/);
  expect(document.body.textContent).toMatch(/person who started this check/);
});

test('after a failure the owner asks again, with nothing to consent to; the answer is shown as text', async () => {
  const calls: Array<{ url: string; body: string; key: string | null }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, body: String(init.body), key: new Headers(init.headers).get('x-task-key') });
    return new Response(JSON.stringify({ second_opinion: OPINION }), { status: 200 });
  }));
  show(`#k=${KEY}`);
  fireEvent.click(screen.getByRole('button', { name: /Ask Cloudflare again/ }));
  await waitFor(() => expect(document.body.textContent).toMatch(/A new scan we sent to Cloudflare .* \(unlisted/));
  expect(calls).toEqual([{ url: `/api/tasks/${ID}/second-opinion`, body: '{}', key: KEY }]);
  expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(document.body.textContent).toContain(`Decathlon ${EVIL}`);
  expect(document.querySelectorAll('script').length).toBe(0);
  expect(screen.getByRole('img').getAttribute('src')).toBe(`/r/${ID}/second-opinion.png`);
});
