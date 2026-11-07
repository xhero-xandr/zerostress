import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, expect, test, vi } from 'vitest';
import { RELEASE } from '../src/version.ts';
import { Home } from '../src/pages/home.tsx';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const ID = '0123456789abcdef0123456789abcdef';
const KEY = 'k'.repeat(43);

function show(path = '/') {
  const sent: Array<{ url: string; body: string }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    sent.push({ url, body: String(init.body ?? '') });
    if (url === '/api/demos') return new Response(JSON.stringify({ demos: [] }));
    return new Response(JSON.stringify({ id: ID, key: KEY }), { status: 202 });
  }));
  const router = createMemoryRouter([{ path: '/', element: <Home /> }, { path: '/r/:id', element: <p>report page</p> }], { initialEntries: [path] });
  render(<QueryClientProvider client={new QueryClient()}><RouterProvider router={router} /></QueryClientProvider>);
  return { sent, router };
}

const EMAIL = '<p>Your account is on hold. Secret order number 99812.</p><a href="https://paypa1-secure.test/login">www.paypal.com</a> <a href="https://help.example.org/">Help</a>';

test('an email: the links are found in the browser, and only the one picked is sent', async () => {
  const { sent, router } = show();
  fireEvent.click(screen.getByRole('tab', { name: 'An email' }));
  fireEvent.change(screen.getByLabelText(/Paste the email/), { target: { value: EMAIL } });
  fireEvent.click(screen.getByRole('button', { name: 'Find the links' }));
  const items = within(screen.getByRole('list', { name: /links in this email/ })).getAllByRole('listitem');
  expect(items.map((li) => li.querySelector('.font-semibold')?.textContent)).toEqual(['paypa1-secure.test', 'help.example.org']);
  expect(items[0]!.textContent).toMatch(/shows “www\.paypal\.com”, but the link goes somewhere else/);
  fireEvent.click(screen.getAllByRole('button', { name: 'Check this link' })[0]!);
  await waitFor(() => expect(router.state.location.pathname).toBe(`/r/${ID}`));
  const posts = sent.filter((x) => x.url === '/api/tasks');
  expect(posts.map((x) => JSON.parse(x.body).url)).toEqual(['https://paypa1-secure.test/login']);
  for (const x of sent) expect(x.body).not.toMatch(/Secret order|99812|help\.example/);
});

test('"/?u=" fills the field and starts nothing by itself', async () => {
  const { sent } = show('/?u=' + encodeURIComponent('https://example.com/a'));
  expect((screen.getByLabelText('Link to check') as HTMLInputElement).value).toBe('https://example.com/a');
  await new Promise((r) => setTimeout(r, 20));
  expect(sent.filter((x) => x.url === '/api/tasks')).toEqual([]);
});

test('the home page says how to get the browser agent, with the latest release', () => {
  show();
  const link = screen.getByRole('link', { name: /Download the extension/ });
  // the extension of this site's own release, never "latest"
  expect(link.getAttribute('href')).toMatch(/^https:\/\/github\.com\/xhero-xandr\/zerostress\/releases\/download\/v(\d+\.\d+\.\d+)\/zerostress-extension-\1\.zip$/);
  expect(link.getAttribute('href')).toContain(`/v${RELEASE}/`);
  expect(document.body.innerHTML).not.toContain('/releases/latest');
  expect(document.body.textContent).toMatch(/Load unpacked/);
  expect(document.body.textContent).toContain('chrome://extensions');
  expect(screen.getByRole('link', { name: 'Extension' }).getAttribute('href')).toBe('#extension');
});
