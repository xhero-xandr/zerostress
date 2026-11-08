import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { EXTENSION_ORIGINS } from '../src/extension.ts';
import { Panel } from '../src/pages/panel.tsx';
import { EVIL, hostile, status, unread } from './fixtures.ts';

const EXTENSION_ORIGIN = EXTENSION_ORIGINS[0];
const ID = '0123456789abcdef0123456789abcdef';
const KEY = 'k'.repeat(43);

class FakeSource {
  static last: FakeSource | null = null;
  static readonly CLOSED = 2;
  readyState = 1;
  onerror: (() => void) | null = null;
  private l: Record<string, Array<(e: MessageEvent) => void>> = {};
  constructor(readonly url: string) { FakeSource.last = this; }
  addEventListener(t: string, f: (e: MessageEvent) => void) { (this.l[t] ??= []).push(f); }
  close() { this.readyState = 2; }
  fire(t: string, data: unknown) { for (const f of this.l[t] ?? []) f(new MessageEvent(t, { data: JSON.stringify(data) })); }
}

let sent: Array<{ url: string; method: string; body: string; key: string | null }>;
beforeEach(() => {
  sent = [];
  vi.stubGlobal('EventSource', FakeSource);
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    sent.push({ url, method: init.method ?? 'GET', body: String(init.body ?? ''), key: new Headers(init.headers).get('x-task-key') });
    if (url === '/api/tasks') return new Response(JSON.stringify({ id: ID, key: KEY }), { status: 202 });
    if (url === '/api/files') return new Response(JSON.stringify({ id: ID, key: KEY, name: 'x', bytes: 1, sha256: 'a'.repeat(64) }), { status: 202 });
    if (url === '/api/file-hash') return new Response(JSON.stringify({ virustotal: { known: false, malicious: 0, suspicious: 0, total: 0, label: null, first_seen: null } }));
    if (url.endsWith('/pending')) return new Response(JSON.stringify({ pending: [{ command_id: 'c1', command_sha256: 'a'.repeat(64), label: 'Submit a form on the page' }] }));
    if (url.endsWith('/approvals')) return new Response(JSON.stringify({ message: 'ok' }), { status: 202 });
    if (url.endsWith('/report.json')) return new Response(JSON.stringify(hostile()));
    if (url.endsWith('/chat')) return new Response(JSON.stringify({ text: `Explained ${EVIL}`, source: 'model', note: null }));
    if (url === `/api/tasks/${ID}`) return new Response(JSON.stringify(status({ id: ID, shots: { desktop: true, tablet: false, mobile: true } })));
    return new Response('{}', { status: 404 });
  }));
  // jsdom has no modal dialogs
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) { this.removeAttribute('open'); };
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); FakeSource.last = null; });

const fromParent = (origin: string, data: unknown) => act(() => { window.dispatchEvent(new MessageEvent('message', { origin, source: window, data })); });

test('a link is taken only from our extension that frames the page', async () => {
  render(<Panel />);
  fromParent('https://evil.test', { type: 'zs-check', link: 'https://x.example/' });
  fromParent('chrome-extension://aaaabbbbccccddddeeeeffffgggghhhh', { type: 'zs-check', link: 'https://x.example/' });
  expect(sent.filter((x) => x.url === '/api/tasks')).toEqual([]);
  fromParent(EXTENSION_ORIGIN, { type: 'zs-check', link: 'https://paypa1-secure.test/login' });
  await waitFor(() => expect(sent.filter((x) => x.url === '/api/tasks').map((x) => JSON.parse(x.body).url)).toEqual(['https://paypa1-secure.test/login']));
});

test('a link from the extension is checked deeply when "let the agent act" was ticked after the panel opened', async () => {
  render(<Panel />);
  fireEvent.click(screen.getByRole('checkbox'));
  fromParent(EXTENSION_ORIGIN, { type: 'zs-check', link: 'https://shop.test/form' });
  await waitFor(() => expect(sent.filter((x) => x.url === '/api/tasks').map((x) => JSON.parse(x.body))).toEqual([{ url: 'https://shop.test/form', deep: true }]));
});

test('the agent tells its steps, asks before a risky action, then gives and explains the verdict', async () => {
  render(<Panel />);
  fireEvent.change(screen.getByLabelText('Message to the agent'), { target: { value: 'https://paypa1-secure.test/login' } });
  fireEvent.click(screen.getByRole('button', { name: 'Check' }));
  await waitFor(() => expect(FakeSource.last?.url).toBe(`/api/tasks/${ID}/events`));
  act(() => FakeSource.last!.fire('log', { t: 900, code: 'vm_booting', d: { slot: 0, vcpu: 2, mem_mib: 1024, image: '7e016b2b2375' } }));
  expect(document.body.textContent).toMatch(/Booting a fresh Firecracker microVM: 2 vCPUs, 1024 MiB/);
  act(() => FakeSource.last!.fire('approval', { waiting: true }));
  const dialog = await screen.findByRole('alertdialog');
  expect(dialog.textContent).toMatch(/Submit a form on the page/);
  fireEvent.click(screen.getByRole('button', { name: 'Allow' }));
  await waitFor(() => expect(document.body.textContent).toMatch(/Allowed\. I am carrying it out/));
  const decision = sent.find((x) => x.url.endsWith('/approvals'))!;
  expect(decision.key).toBe(KEY);
  expect(JSON.parse(decision.body)).toEqual({ command_id: 'c1', command_sha256: 'a'.repeat(64), allow: true });
  act(() => FakeSource.last!.fire('final', {}));
  await waitFor(() => expect(document.body.textContent).toContain(`Explained ${EVIL}`));
  expect(document.body.textContent).toMatch(/Verdict: Dangerous/);
  expect(document.querySelectorAll('script, iframe').length).toBe(0);
  expect(screen.getByRole('link', { name: 'Open the full report' }).getAttribute('href')).toBe(`/r/${ID}#k=${KEY}`);
});

test('a question asked while the agent is still explaining waits its turn instead of being refused', async () => {
  let inFlight = 0;
  let overlapped = false;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    if (url === '/api/tasks') return new Response(JSON.stringify({ id: ID, key: KEY }), { status: 202 });
    if (url.endsWith('/report.json')) return new Response(JSON.stringify(hostile()));
    if (url.endsWith('/chat')) {
      if (++inFlight > 1) overlapped = true;
      await new Promise((r) => setTimeout(r, 30));
      inFlight--;
      return new Response(JSON.stringify({ text: JSON.parse(String(init.body)).kind === 'explain' ? 'The explanation.' : 'The answer.', source: 'model', note: null }));
    }
    return new Response('{}', { status: 404 });
  }));
  render(<Panel />);
  fireEvent.change(screen.getByLabelText('Message to the agent'), { target: { value: 'https://x.example/' } });
  fireEvent.click(screen.getByRole('button', { name: 'Check' }));
  await waitFor(() => expect(FakeSource.last).not.toBeNull());
  act(() => FakeSource.last!.fire('final', {}));
  await screen.findByText(/^Verdict:/);
  fireEvent.change(screen.getByLabelText('Message to the agent'), { target: { value: 'Does it ask for a password?' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await screen.findByText('The answer.');
  await screen.findByText('The explanation.');
  expect(overlapped).toBe(false);
});

test('a wall: the panel waits for Cloudflare on its own, nobody presses anything; its answer and verdict are told', async () => {
  let asked = false;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/tasks') return new Response(JSON.stringify({ id: ID, key: KEY }), { status: 202 });
    if (url.endsWith('/report.json')) return new Response(JSON.stringify(asked ? hostile() : { ...unread('bot_challenge', 'A bot check'), second_opinion: null, second_opinion_state: 'asking' }));
    if (url.endsWith('/second-opinion')) {
      asked = true;
      return new Response(JSON.stringify({ second_opinion: { source: 'submitted', scan_id: '11111111-2222-4333-8444-555555555555', scanned_at: '2026-11-07T12:00:00.000Z', final_host: 'shop.test', status: 403, title: '', title_withheld: false, malicious: true, screenshot: false } }));
    }
    if (url.endsWith('/chat')) return new Response(JSON.stringify({ text: 'Explained', source: 'rules', note: null }));
    return new Response('{}', { status: 404 });
  }));
  render(<Panel />);
  fireEvent.change(screen.getByLabelText('Message to the agent'), { target: { value: 'https://shop.test/' } });
  fireEvent.click(screen.getByRole('button', { name: 'Check' }));
  await waitFor(() => expect(FakeSource.last?.url).toBe(`/api/tasks/${ID}/events`));
  act(() => FakeSource.last!.fire('final', {}));
  await waitFor(() => expect(document.body.textContent).toContain('Cloudflare’s scanner scanned it now: shop.test answered HTTP 403, flagged as malicious'));
  expect(asked).toBe(true);
  expect(screen.queryByRole('button', { name: /Ask Cloudflare/ })).toBeNull();
});

test('a wall that Cloudflare had already answered about when the report was read: its answer is told at once, nothing is asked', async () => {
  const urls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    urls.push(url);
    if (url === '/api/tasks') return new Response(JSON.stringify({ id: ID, key: KEY }), { status: 202 });
    if (url.endsWith('/report.json')) return new Response(JSON.stringify({ ...unread('bot_challenge', 'A bot check'), second_opinion: { source: 'found', scan_id: '11111111-2222-4333-8444-555555555555', scanned_at: '2026-11-07T12:00:00.000Z', final_host: 'shop.test', status: 200, title: '', title_withheld: false, malicious: false, screenshot: false }, second_opinion_state: null }));
    if (url.endsWith('/chat')) return new Response(JSON.stringify({ text: 'Explained', source: 'rules', note: null }));
    return new Response('{}', { status: 404 });
  }));
  render(<Panel />);
  fireEvent.change(screen.getByLabelText('Message to the agent'), { target: { value: 'shop.test' } });
  fireEvent.click(screen.getByRole('button', { name: 'Check' }));
  await waitFor(() => expect(FakeSource.last?.url).toBe(`/api/tasks/${ID}/events`));
  act(() => FakeSource.last!.fire('final', {}));
  await waitFor(() => expect(document.body.textContent).toContain('Cloudflare’s scanner had scanned it recently: shop.test answered HTTP 200, not flagged'));
  expect(urls.some((u) => u.endsWith('/second-opinion'))).toBe(false);
});

async function checked() {
  render(<Panel />);
  fireEvent.change(screen.getByLabelText('Message to the agent'), { target: { value: 'https://paypa1-secure.test/login' } });
  fireEvent.click(screen.getByRole('button', { name: 'Check' }));
  await waitFor(() => expect(FakeSource.last?.url).toBe(`/api/tasks/${ID}/events`));
  act(() => FakeSource.last!.fire('final', {}));
  await waitFor(() => expect(document.body.textContent).toContain(`Explained ${EVIL}`));
}

test('under the verdict: the main facts, the screenshots (opened over the panel) and the report as JSON', async () => {
  await checked();
  expect(document.body.textContent).toMatch(/Final site/);
  const json = screen.getByRole('link', { name: 'Download the report (JSON)' });
  expect(json.getAttribute('href')).toBe(`/r/${ID}/report.json`);
  expect(json.hasAttribute('download')).toBe(true);
  const open = screen.getAllByRole('button', { name: /open larger/ });
  expect(open).toHaveLength(2);
  fireEvent.click(open[1]!);
  const shown = document.querySelectorAll('dialog[open]');
  expect(shown).toHaveLength(1);
  expect(shown[0]!.querySelector('img')!.getAttribute('src')).toBe(`/r/${ID}/screenshot.png?device=mobile`);
  expect(document.querySelectorAll('a[href*="screenshot.png"]:not([target="_blank"])')).toHaveLength(0);
});

test('an email pasted after a check is read here: its links are offered, nothing is sent, and it is not taken for a question', async () => {
  await checked();
  const before = sent.length;
  const mail = 'From: Bank <no-reply@bank.example>\nSubject: Verify now\n\nDear customer, please verify your account:\n<a href="https://paypa1-verify.test/x">https://www.paypal.com/</a>\nThanks';
  fireEvent.change(screen.getByLabelText('Message to the agent'), { target: { value: mail } });
  fireEvent.click(screen.getByRole('button', { name: /^(Check|Send)$/ }));
  await waitFor(() => expect(document.body.textContent).toMatch(/I found 1 link in it/));
  // only the sender's domain is looked up: never the address, never the email
  await waitFor(() => expect(sent.slice(before).map((x) => [x.url, x.body])).toEqual([['/api/sender', JSON.stringify({ domain: 'bank.example' })]]));
  expect(document.body.textContent).not.toContain('Dear customer');
  expect(document.body.textContent).toMatch(/The email shows “https:\/\/www.paypal.com\/”, but the link goes somewhere else/);
  fireEvent.click(screen.getByRole('button', { name: 'Check this link' }));
  await waitFor(() => expect(sent.filter((x) => x.url === '/api/tasks').map((x) => JSON.parse(x.body).url)).toEqual(['https://paypa1-secure.test/login', 'https://paypa1-verify.test/x']));
});

test('the source of an email ("Show original"), sent with Enter: its sender checks, warnings and hidden links are shown here, and nothing is sent', async () => {
  await checked();
  const before = sent.length;
  const html = Buffer.from('<a href="https://login-phish.test/a">https://www.paypal.com/</a>').toString('base64');
  const src = ['Authentication-Results: mx.google.com; dkim=fail; spf=fail; dmarc=fail header.from=paypal.com', 'From: PayPal <service@paypal.com>', 'Reply-To: x@elsewhere.test', 'Subject: Account on hold',
    'MIME-Version: 1.0', 'Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: base64', '', html].join('\r\n');
  const box = screen.getByLabelText('Message to the agent');
  expect(box.tagName).toBe('TEXTAREA');
  fireEvent.change(box, { target: { value: src } });
  fireEvent.keyDown(box, { key: 'Enter' });
  await waitFor(() => expect(screen.getByRole('region', { name: 'What the email itself shows' })).toBeTruthy());
  const card = screen.getByRole('region', { name: 'What the email itself shows' });
  expect(card.textContent).toMatch(/SPF fail · DKIM fail · DMARC fail/);
  expect(card.textContent).toMatch(/could not confirm that this email comes from the address it shows/);
  expect(card.textContent).toMatch(/Replies go to x@elsewhere\.test/);
  expect(document.body.textContent).toMatch(/I found 1 link in it/);
  expect(document.body.textContent).toContain('https://login-phish.test/a');
  // only the sender's domain is looked up: never the address, never the email
  await waitFor(() => expect(sent.slice(before).map((x) => [x.url, x.body])).toEqual([['/api/sender', JSON.stringify({ domain: 'paypal.com' })]]));
});

test('a bare address typed after a check ("google.com") is a new check, not a question', async () => {
  await checked();
  fireEvent.change(screen.getByLabelText('Message to the agent'), { target: { value: 'google.com' } });
  fireEvent.click(screen.getByRole('button', { name: /^(Check|Send)$/ }));
  await waitFor(() => expect(sent.filter((x) => x.url === '/api/tasks').map((x) => JSON.parse(x.body).url).at(-1)).toBe('https://google.com/'));
  expect(sent.some((x) => x.url.includes('/chat') && x.body.includes('google.com'))).toBe(false);
});

test('a link into one\'s own mailbox is explained, not checked', async () => {
  render(<Panel />);
  fromParent(EXTENSION_ORIGIN, { type: 'zs-check', link: 'https://mail.google.com/mail/u/0/#inbox/FMfcgz' });
  await waitFor(() => expect(document.body.textContent).toMatch(/your own Gmail inbox/));
  expect(sent.filter((x) => x.url === '/api/tasks')).toEqual([]);
});

test('a question typed while the check is still running is kept and answered after the explanation', async () => {
  render(<Panel />);
  fireEvent.change(screen.getByLabelText('Message to the agent'), { target: { value: 'https://paypa1-secure.test/login' } });
  fireEvent.click(screen.getByRole('button', { name: 'Check' }));
  await waitFor(() => expect(FakeSource.last?.url).toBe(`/api/tasks/${ID}/events`));
  fireEvent.change(screen.getByLabelText('Message to the agent'), { target: { value: 'Who made this page?' } });
  fireEvent.click(screen.getByRole('button', { name: /^(Check|Send)$/ }));
  expect(document.body.textContent).toContain('Who made this page?');
  expect(document.body.textContent).toMatch(/I will answer this as soon as the verdict is in/);
  expect(sent.filter((x) => x.url.endsWith('/chat'))).toEqual([]);
  act(() => FakeSource.last!.fire('final', {}));
  await waitFor(() => expect(sent.filter((x) => x.url.endsWith('/chat')).map((x) => JSON.parse(x.body))).toEqual([{ kind: 'explain' }, { kind: 'ask', message: 'Who made this page?' }]));
});

test('a second link while a check is running is told to wait, not silently dropped', async () => {
  render(<Panel />);
  fireEvent.change(screen.getByLabelText('Message to the agent'), { target: { value: 'https://paypa1-secure.test/login' } });
  fireEvent.click(screen.getByRole('button', { name: 'Check' }));
  await waitFor(() => expect(FakeSource.last?.url).toBe(`/api/tasks/${ID}/events`));
  fireEvent.change(screen.getByLabelText('Message to the agent'), { target: { value: 'https://other.test/' } });
  fireEvent.click(screen.getByRole('button', { name: /^(Check|Send)$/ }));
  expect(document.body.textContent).toMatch(/One check at a time/);
  expect(sent.filter((x) => x.url === '/api/tasks')).toHaveLength(1);
});

test('a file dropped on the panel: read there, only its fingerprint goes out; opened, it is followed in the panel', async () => {
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { MemoryRouter } = await import('react-router');
  render(<QueryClientProvider client={new QueryClient()}><MemoryRouter><Panel /></MemoryRouter></QueryClientProvider>);
  const form = screen.getByLabelText('Message to the agent').closest('form')!;
  const doc = new File([new TextEncoder().encode('PK secret content')], 'Invoice.docm', { type: 'application/octet-stream' });
  fireEvent.drop(form, { dataTransfer: { files: [doc] } });
  await screen.findByText(/only its fingerprint goes out/);
  await waitFor(() => expect(sent.some((x) => x.url === '/api/file-hash')).toBe(true));
  expect(sent.some((x) => x.url === '/api/files')).toBe(false);
  for (const x of sent) expect(x.body).not.toMatch(/secret content/);
  fireEvent.click(screen.getByRole('button', { name: /Open in a sandbox/ }));
  await waitFor(() => expect(sent.some((x) => x.url === '/api/files' && x.method === 'POST')).toBe(true));
  expect(screen.getByText(/Open “Invoice.docm” in a sandbox/)).toBeTruthy();
  await waitFor(() => expect(FakeSource.last?.url).toBe(`/api/tasks/${ID}/events`));
});
