import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { EXTENSION_ORIGIN } from '../src/extension.ts';
import { Panel } from '../src/pages/panel.tsx';
import { EVIL, hostile } from './fixtures.ts';

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
    if (url.endsWith('/pending')) return new Response(JSON.stringify({ pending: [{ command_id: 'c1', command_sha256: 'a'.repeat(64), label: 'Submit a form on the page' }] }));
    if (url.endsWith('/approvals')) return new Response(JSON.stringify({ message: 'ok' }), { status: 202 });
    if (url.endsWith('/report.json')) return new Response(JSON.stringify(hostile()));
    if (url.endsWith('/chat')) return new Response(JSON.stringify({ text: `Explained ${EVIL}`, source: 'model', note: null }));
    return new Response('{}', { status: 404 });
  }));
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
