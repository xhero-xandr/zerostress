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
    if (url === '/api/demos') return new Response(JSON.stringify({ demos: [{ label: 'A harmless page', url: 'https://example.com/' }, { label: 'A file to approve', url: 'https://zerostress.space/demo/shared-file', deep: true }] }));
    return new Response(JSON.stringify({ id: ID, key: KEY }), { status: 202 });
  }));
  const router = createMemoryRouter([{ path: '/', element: <Home /> }, { path: '/r/:id', element: <p>report page</p> }], { initialEntries: [path] });
  render(<QueryClientProvider client={new QueryClient()}><RouterProvider router={router} /></QueryClientProvider>);
  return { sent, router };
}

const EMAIL = '<p>Your account is on hold. Secret order number 99812.</p><a href="https://paypa1-secure.test/login">www.paypal.com</a> <a href="https://help.example.org/">Help</a>';

const field = () => screen.getByLabelText(/Something suspicious/) as HTMLTextAreaElement;
const said = () => document.getElementById('what-said')?.textContent ?? '';

test('an email: understood as one, read in the browser; only the link picked is sent', async () => {
  const { sent, router } = show();
  fireEvent.change(field(), { target: { value: EMAIL } });
  expect(said()).toMatch(/Understood as: an email or a message: 2 links/);
  const items = within(screen.getByRole('list', { name: /links in this email/ })).getAllByRole('listitem');
  expect(items.map((li) => li.querySelector('.font-semibold')?.textContent)).toEqual(['paypa1-secure.test', 'help.example.org']);
  expect(items[0]!.textContent).toMatch(/shows “www\.paypal\.com”, but the link goes somewhere else/);
  expect(sent.filter((x) => x.url !== '/api/demos')).toEqual([]); // reading it sends nothing
  fireEvent.click(screen.getAllByRole('button', { name: 'Check this link' })[0]!);
  await waitFor(() => expect(router.state.location.pathname).toBe(`/r/${ID}`));
  const posts = sent.filter((x) => x.url === '/api/tasks');
  expect(posts.map((x) => JSON.parse(x.body).url)).toEqual(['https://paypa1-secure.test/login']);
  for (const x of sent) expect(x.body).not.toMatch(/Secret order|99812|help\.example/);
});

test('a link, bare or full, is understood as one and Enter checks it; words without a link are said so', async () => {
  const { sent, router } = show();
  fireEvent.change(field(), { target: { value: '  paypa1-secure.test/login  ' } });
  expect(said()).toMatch(/Understood as: a link/);
  expect(screen.getByRole('checkbox')).toBeTruthy();
  fireEvent.change(field(), { target: { value: 'please call me back tomorrow' } });
  expect(said()).toMatch(/text without a link/);
  expect(screen.queryByRole('button', { name: /^Check/ })).toBeNull();
  fireEvent.change(field(), { target: { value: 'https://paypa1-secure.test/login' } });
  fireEvent.keyDown(field(), { key: 'Enter' });
  await waitFor(() => expect(router.state.location.pathname).toBe(`/r/${ID}`));
  expect(sent.filter((x) => x.url === '/api/tasks').map((x) => JSON.parse(x.body))).toEqual([{ url: 'https://paypa1-secure.test/login', deep: false }]);
});

test('"/?u=" fills the field and starts nothing by itself', async () => {
  const { sent } = show('/?u=' + encodeURIComponent('https://example.com/a'));
  expect(field().value).toBe('https://example.com/a');
  await new Promise((r) => setTimeout(r, 20));
  expect(sent.filter((x) => x.url === '/api/tasks')).toEqual([]);
});

test('a dropped file is understood as one: only its fingerprint goes out; a dropped .eml is read as an email', async () => {
  const { sent } = show();
  const zone = field().parentElement!;
  const exe = new File([new TextEncoder().encode('MZ secret bytes')], 'Invoice.pdf.exe', { type: 'application/octet-stream' });
  fireEvent.drop(zone, { dataTransfer: { files: [exe] } });
  await waitFor(() => expect(said()).toMatch(/Understood as: a file/));
  expect(screen.getAllByText('Invoice.pdf.exe').length).toBeGreaterThan(0);
  expect(screen.getByRole('button', { name: /Open in a sandbox/ })).toBeTruthy();
  await waitFor(() => expect(sent.some((x) => x.url === '/api/file-hash')).toBe(true));
  for (const x of sent) expect(x.body).not.toMatch(/secret bytes/);
  expect(sent.some((x) => x.url === '/api/files')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
  const eml = new File([`From: a@shop.example\r\nSubject: x\r\nContent-Type: text/html\r\n\r\n${EMAIL}`], 'msg.eml', { type: 'message/rfc822' });
  fireEvent.drop(field().parentElement!, { dataTransfer: { files: [eml] } });
  await waitFor(() => expect(said()).toMatch(/an email \(its source\): 2 links/));
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

test('an example that needs the agent to act ticks the box for it; another one does not', async () => {
  show();
  const box = () => screen.getByRole('checkbox') as HTMLInputElement;
  fireEvent.click(await screen.findByRole('button', { name: 'A file to approve' }));
  expect(field().value).toBe('https://zerostress.space/demo/shared-file');
  expect(box().checked).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'A harmless page' }));
  expect(box().checked).toBe(false);
});

test('a whole email in one sandbox: one request with its links only, never the email', async () => {
  const { sent, router } = show();
  fireEvent.change(field(), { target: { value: EMAIL } });
  fireEvent.click(screen.getByRole('button', { name: 'Check all 2 links in one sandbox' }));
  await waitFor(() => expect(router.state.location.pathname).toBe(`/r/${ID}`));
  const posts = sent.filter((x) => x.url === '/api/email-checks');
  expect(posts.map((x) => JSON.parse(x.body))).toEqual([{ links: ['https://paypa1-secure.test/login', 'https://help.example.org/'] }]);
  expect(sent.filter((x) => x.url === '/api/tasks')).toEqual([]);
  for (const x of sent) expect(x.body).not.toMatch(/Secret order|99812/);
});
