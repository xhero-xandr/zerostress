import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, expect, test, vi } from 'vitest';
import { FileCard, FileRow, sha256Hex, vtText } from '../src/file-check.tsx';
import { EVIL, hostile } from './fixtures.ts';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const ID = '0123456789abcdef0123456789abcdef';
const KEY = 'k'.repeat(43);
const EMPTY_SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

function show(data: Uint8Array | null, vt: unknown = { known: true, malicious: 41, suspicious: 0, total: 70, label: 'trojan.x', first_seen: null }) {
  const sent: Array<{ url: string; body: unknown; headers: Headers }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    sent.push({ url, body: init.body, headers: new Headers(init.headers) });
    if (url === '/api/file-hash') return new Response(JSON.stringify({ virustotal: vt }));
    return new Response(JSON.stringify({ id: ID, key: KEY, name: 'x', bytes: 1, sha256: 'a'.repeat(64) }), { status: 202 });
  }));
  const router = createMemoryRouter([{ path: '/', element: <ul><FileRow name="Invoice.pdf.exe" mime="application/pdf" data={data} /></ul> }, { path: '/r/:id', element: <p>report page</p> }]);
  render(<QueryClientProvider client={new QueryClient()}><RouterProvider router={router} /></QueryClientProvider>);
  return { sent, router };
}

test('the hash is made here, and only the hash is sent until the person asks for the sandbox', async () => {
  const data = new TextEncoder().encode('MZ secret content of the file');
  const { sent, router } = show(data);
  await screen.findByText(/41 of 70 antivirus engines on VirusTotal flag this file \(trojan\.x\)/);
  expect(sent).toHaveLength(1);
  expect(sent[0]!.url).toBe('/api/file-hash');
  expect(JSON.parse(String(sent[0]!.body))).toEqual({ sha256: await sha256Hex(data) });
  expect(String(sent[0]!.body)).not.toMatch(/secret|Invoice/);
  fireEvent.click(screen.getByRole('button', { name: /Open in a sandbox/ }));
  await waitFor(() => expect(router.state.location.pathname).toBe(`/r/${ID}`));
  expect(router.state.location.hash).toBe(`#k=${KEY}`);
  const up = sent[1]!;
  expect(up.url).toBe('/api/files');
  expect(up.body).toBe(data);
  expect(up.headers.get('x-file-name')).toBe('Invoice.pdf.exe');
});

test('a file too large to check, or one whose content was not pasted, cannot be sent', async () => {
  show(new Uint8Array(10 * 1024 * 1024 + 1));
  expect((await screen.findByRole('button', { name: /Too large/ })).hasAttribute('disabled')).toBe(true);
  cleanup();
  const { sent } = show(null);
  expect(screen.queryByRole('button')).toBeNull();
  expect(screen.getByText(/Its content is not in what was pasted/)).toBeTruthy();
  expect(sent).toHaveLength(0);
});

test('the SHA-256 is the standard one', async () => {
  expect(await sha256Hex(new Uint8Array())).toBe(EMPTY_SHA);
});

test('what VirusTotal\'s answer means: unknown is not clean, and flagged is serious from three engines on', () => {
  expect(vtText(null).level).toBe('info');
  expect(vtText({ known: false, malicious: 0, suspicious: 0, total: 0, label: null, first_seen: null }).text).toMatch(/never seen/);
  expect(vtText({ known: true, malicious: 0, suspicious: 0, total: 70, label: null, first_seen: null }).level).toBe('low');
  expect(vtText({ known: true, malicious: 2, suspicious: 0, total: 70, label: null, first_seen: null }).level).toBe('medium');
  expect(vtText({ known: true, malicious: 3, suspicious: 0, total: 70, label: null, first_seen: null }).level).toBe('high');
});

test('the file in its report: what was found, the names inside, its addresses as text only; hostile names stay text', () => {
  const r = hostile({ file: { name: `statement${EVIL}.html`, bytes: 2048, sha256: 'c'.repeat(64), type: 'html', read: true, findings: ['html_password_form', 'something_new'], links: [`https://evil.example/${EVIL}`], entries: [`a${EVIL}.exe`], viewed: true, virustotal: { known: false, malicious: 0, suspicious: 0, total: 0, label: null, first_seen: null } } });
  const { container } = render(<FileCard r={r} />);
  expect(screen.getByText(/asks for a password/)).toBeTruthy();
  expect(screen.getByText('something_new')).toBeTruthy();
  expect(screen.getByText(/also opened there as a page/)).toBeTruthy();
  expect(screen.getByText(/never seen this file/)).toBeTruthy();
  expect(container.querySelector('a')).toBeNull();
  expect(container.querySelector('img, script')).toBeNull();
  expect(container.textContent).toContain(`statement${EVIL}.html`);
});

test('a file that never reached the sandbox says so, and lists no findings', () => {
  render(<FileCard r={hostile({ file: { name: 'a.pdf', bytes: 1, sha256: 'c'.repeat(64), type: null, read: false, findings: [], links: [], entries: [], viewed: false, virustotal: null } })} />);
  expect(screen.getByText(/could not be fetched into the sandbox/)).toBeTruthy();
  expect(screen.queryByText(/What was found inside it/)).toBeNull();
});
