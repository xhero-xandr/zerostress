// The task page against a fake server: the stream may be refused, an address may not exist, a decision may fail.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { T } from '../src/text.ts';
import { hostile, ID, status } from './fixtures.ts';
import { Approval } from '../src/pages/approval.tsx';
import { Task } from '../src/pages/task.tsx';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); sessionStorage.clear(); });

const json = (body: unknown, code = 200) => Promise.resolve(new Response(JSON.stringify(body), { status: code, headers: { 'content-type': 'application/json' } }));

/** An EventSource that the browser closed at once, as it does when the server answers 429. */
class RefusedStream {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  readyState = RefusedStream.CONNECTING;
  onerror: (() => void) | null = null;
  constructor() { setTimeout(() => { this.readyState = RefusedStream.CLOSED; this.onerror?.(); }, 10); }
  addEventListener() {}
  close() { this.readyState = RefusedStream.CLOSED; }
}

function show(path: string, element = <Task />) {
  const router = createMemoryRouter([{ path: '/r/:id/:tab?', element }, { path: '/', element: <p>home</p> }], { initialEntries: [path] });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><RouterProvider router={router} /></QueryClientProvider>);
}

describe('the progress page', () => {
  test('a refused stream falls back to asking the status again', async () => {
    let calls = 0;
    vi.stubGlobal('EventSource', RefusedStream);
    vi.stubGlobal('fetch', (url: string) => {
      if (url !== `/api/tasks/${ID}`) return json({}, 404);
      calls += 1;
      return json(status(calls === 1
        ? { stage: 'opening', label: 'Loading example.com', at: 1, has_report: false }
        : { stage: 'analysing', label: 'Reading what the page did', at: 2, has_report: false }));
    });
    show(`/r/${ID}`);
    expect(await screen.findByText('Loading example.com')).toBeTruthy();
    expect(await screen.findByText('Reading what the page did', undefined, { timeout: 4000 })).toBeTruthy();
  });
});

/** An EventSource that stays open and lets the test send it events. */
class LiveStream {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static last: LiveStream | null = null;
  readyState = LiveStream.OPEN;
  onerror: (() => void) | null = null;
  private handlers = new Map<string, (e: MessageEvent<string>) => void>();
  constructor() { LiveStream.last = this; }
  addEventListener(type: string, h: (e: MessageEvent<string>) => void) { this.handlers.set(type, h); }
  send(type: string, data: unknown) { this.handlers.get(type)?.(new MessageEvent(type, { data: JSON.stringify(data) })); }
  close() { this.readyState = LiveStream.CLOSED; }
}

describe('the decision during a live check', () => {
  const running = { stage: 'opening' as const, label: 'Loading example.com', at: 1, has_report: false };
  const pending = { pending: [{ command_id: 'a1', command_sha256: 'b'.repeat(64), label: 'Download a file from the page' }] };

  test('when the agent starts waiting, the owner gets the buttons on the progress page', async () => {
    let awaiting = false;
    vi.stubGlobal('EventSource', LiveStream);
    vi.stubGlobal('fetch', (url: string) => (url === `/api/tasks/${ID}`
      ? json(status(awaiting ? { ...running, awaiting, label: 'Waiting for your decision' } : running))
      : url.endsWith('/pending') ? json(pending) : json({}, 404)));
    show(`/r/${ID}#k=${'k'.repeat(32)}`);
    expect(await screen.findByText('Loading example.com')).toBeTruthy();
    expect(screen.queryByRole('button', { name: T.allow })).toBeNull();
    awaiting = true;
    LiveStream.last!.send('approval', { waiting: true });
    expect(await screen.findByRole('button', { name: T.allow })).toBeTruthy();
    expect(screen.getByText('Download a file from the page')).toBeTruthy();
    expect(screen.getByText('Waiting for your decision')).toBeTruthy();
  });

  test('someone without the key sees that the owner decides, and no buttons', async () => {
    vi.stubGlobal('EventSource', LiveStream);
    vi.stubGlobal('fetch', (url: string) => (url === `/api/tasks/${ID}` ? json(status({ ...running, awaiting: true })) : json(pending)));
    show(`/r/${ID}`);
    expect(await screen.findByText(T.approvalOnlyOwner)).toBeTruthy();
    expect(screen.queryByRole('button', { name: T.allow })).toBeNull();
  });
});

describe('addresses', () => {
  test('/r/:id/summary is not an address, as on the server', async () => {
    vi.stubGlobal('fetch', (url: string) => (url === `/api/tasks/${ID}` ? json(status()) : url === `/api/reports/${ID}` ? json(hostile()) : json({}, 404)));
    show(`/r/${ID}/summary`);
    expect(await screen.findByText(T.notFoundTitle)).toBeTruthy();
  });
});

describe("the owner's decision", () => {
  test('a decision that failed gives the buttons back', async () => {
    vi.stubGlobal('fetch', (url: string) => (url.endsWith('/pending')
      ? json({ pending: [{ command_id: 'c1', command_sha256: 'a'.repeat(64), label: 'Download invoice.pdf' }] })
      : json({ code: 'server', message: 'try later' }, 503)));
    show(`/r/${ID}#k=${'k'.repeat(32)}`, <Approval id={ID} />);
    const allow = await screen.findByRole('button', { name: T.allow });
    fireEvent.click(allow);
    expect(await screen.findByText('try later')).toBeTruthy();
    await waitFor(() => expect((allow as HTMLButtonElement).disabled).toBe(false));
  });
});

describe("the owner's key", () => {
  test('leaves the address at once and stays with the tab: a copied address carries no right to decide', async () => {
    sessionStorage.clear();
    vi.stubGlobal('fetch', () => json({ pending: [{ command_id: 'c1', command_sha256: 'a'.repeat(64), label: 'Download invoice.pdf' }] }));
    const key = 'k'.repeat(32);
    const router = createMemoryRouter([{ path: '/r/:id/:tab?', element: <Approval id={ID} /> }], { initialEntries: [`/r/${ID}#k=${key}`] });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><RouterProvider router={router} /></QueryClientProvider>);
    expect(await screen.findByRole('button', { name: T.allow })).toBeTruthy();
    await waitFor(() => expect(router.state.location.hash).toBe(''));
    expect(router.state.location.pathname).toBe(`/r/${ID}`);
    expect(sessionStorage.getItem(`zs-task-key:${ID}`)).toBe(key);

    // the same tab opens the report again without the fragment: still the owner
    cleanup();
    const again = createMemoryRouter([{ path: '/r/:id/:tab?', element: <Approval id={ID} /> }], { initialEntries: [`/r/${ID}`] });
    render(<QueryClientProvider client={new QueryClient()}><RouterProvider router={again} /></QueryClientProvider>);
    expect(await screen.findByRole('button', { name: T.allow })).toBeTruthy();
  });

  test('a tab that cannot keep it leaves it in the address, so the owner does not lose it', async () => {
    vi.stubGlobal('fetch', () => json({ pending: [{ command_id: 'c1', command_sha256: 'a'.repeat(64), label: 'Download invoice.pdf' }] }));
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('storage off'); });
    try {
      const router = createMemoryRouter([{ path: '/r/:id/:tab?', element: <Approval id={ID} /> }], { initialEntries: [`/r/${ID}#k=${'q'.repeat(32)}`] });
      render(<QueryClientProvider client={new QueryClient()}><RouterProvider router={router} /></QueryClientProvider>);
      expect(await screen.findByRole('button', { name: T.allow })).toBeTruthy();
      expect(router.state.location.hash).toBe(`#k=${'q'.repeat(32)}`);
    } finally {
      setItem.mockRestore();
    }
  });
});
