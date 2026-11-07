// The web layer's routes (spec 007). The app is built from its parts (the task runner, the supervisor calls, the store and the
// limiter are passed in), so a test can drive it without a supervisor.

import { cleanEntry, MAX_LOG } from '../agent/agent-log.ts';
import type { UrlScanClient } from '../agent/urlscan.ts';
import { scanText } from '../hooks/index.ts';
import { getConnInfo } from '@hono/node-server/conninfo';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { publicReport, type PublicReport } from '../agent/report.ts';
import { chatNote, cleanAnswer, MAX_QUESTION, type ChatInput, type ChatReason, type ChatReply, type Turn } from '../agent/chat.ts';
import type { Progress, TaskInput, TaskResult } from '../agent/runner.ts';
import { SupervisorError } from '../agent/supervisor.ts';
import { checkAddress } from './gate.ts';
import { clientBucket, type Limiter } from './limits.ts';
import type { Stage, Store, Task } from './store.ts';
import { errorText, T, type Demo } from './text.ts';

export interface AppDeps {
  run(input: TaskInput, onProgress: (p: Progress) => void): Promise<TaskResult>;
  fetchShot(runId: string, name: string): Promise<Buffer>;
  approve(runId: string, commandId: string, sha256: string): Promise<void>;
  /** a person's "no" to one risky command: only that command is dropped, the run closes normally */
  reject(runId: string, commandId: string): Promise<void>;
  /** the talk about a finished report (Explain and questions); without it the endpoint is absent */
  chat?: { reply(report: PublicReport, input: ChatInput): Promise<ChatReply> };
  store: Store;
  limiter: Limiter;
  demos: readonly Demo[];
  /** how a deep check (a live session) is asked for at the supervisor */
  session: { idle_s: number; max_s: number };
  /** the address of the person asking; the default reads the connection and, behind our own proxy, the proxy's header */
  clientIp?: (c: Context) => string;
  /** the built client (spec 012): index.html and assets/; the default is build/client at the project root (spec 010) */
  clientDir?: string;
  /** Cloudflare's URL Scanner for a second opinion on a page we could not read; without it the endpoint is absent */
  urlscan?: Pick<UrlScanClient, 'opinion'>;
}

// The client sends everything with fetch, it has no forms, so form-action can be 'none' (spec 007, 3.5).
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
/** Our browser extension (its id is fixed by the public key in web/extension/public/manifest.json): the only page that
 * may frame anything of ours, and only /panel, the agent it shows in the browser's side panel. */
export const EXTENSION_ORIGIN = 'chrome-extension://eanjmnmjjbbcpgnhdifdpmednecllbbc';
const PANEL_CSP = CSP.replace("frame-ancestors 'none'", `frame-ancestors ${EXTENSION_ORIGIN}`);
export const MAX_BODY = 4096;
const SHOT_MAX = 4 * 1024 * 1024;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Only the kinds of file the build makes; the names are hashed by the build, so they can be cached for good. */
const ASSET_TYPES: Readonly<Record<string, string>> = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const ASSET_NAME = /^[A-Za-z0-9_-]{1,80}\.(js|css)$/;
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

const STAGE_AT: Readonly<Record<Stage, number>> = { queued: 0, starting: 0, opening: 1, analysing: 2, done: 3, failed: 3 };

function stageOf(state: string): Stage | null {
  switch (state) {
    case 'queued': return 'queued';
    case 'preparing': case 'booting': return 'starting';
    case 'running': case 'session': return 'opening';
    case 'destroying': case 'done': return 'analysing';
    default: return null;
  }
}

function defaultClientIp(c: Context): string {
  let peer = '0.0.0.0';
  try { peer = getConnInfo(c).remote.address ?? peer; } catch { /* not a socket (a test) */ }
  // only our own proxy, on this machine, may say who the person is, and it sets X-Real-IP itself from an address it has
  // checked (deploy/zerostress-web.Caddyfile); a header that came from the outside is never read
  if (LOOPBACK.has(peer)) {
    const h = c.req.header('x-real-ip');
    if (h && h.length < 64 && /^[0-9a-fA-F:.]+$/.test(h)) return h;
  }
  return peer;
}

const json = (c: Context, status: 200 | 202 | 400 | 403 | 404 | 409 | 413 | 415 | 429 | 500 | 503, body: unknown, headers: Record<string, string> = {}): Response =>
  c.json(body as object, status, { 'cache-control': 'no-store', ...headers });

const fail = (c: Context, status: 400 | 403 | 404 | 413 | 415 | 429 | 500 | 503, code: string, headers: Record<string, string> = {}): Response =>
  json(c, status, { code, message: errorText(code) }, headers);

/** The name of the image for a device, only if it is one of this run's saved images (the supervisor's names are 16 hex digits). */
function shotName(result: TaskResult, device: 'desktop' | 'mobile' | 'tablet'): string | null {
  const png = result.artifacts.filter((a) => a.mime === 'image/png' && /^[A-Za-z0-9._-]{1,60}$/.test(a.name)).map((a) => a.name);
  const named = result.shots?.[device] ?? null;
  if (named !== null) return png.includes(named) ? named : null;
  return device === 'desktop' && !result.shots ? (png.at(-1) ?? null) : null; // results stored before the devices existed
}

/** The body as text, read up to `max` bytes; null if it is longer (the rest is never read). */
async function readCapped(c: Context, max: number): Promise<string | null> {
  const stream = c.req.raw.body;
  if (!stream) return '';
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** A JSON object from a POST: the same page as the sender, the right type, a small body. Anything else is a plain refusal. */
async function readJsonBody(c: Context): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; res: Response }> {
  const origin = c.req.header('origin');
  if (origin !== undefined) {
    let ok = false;
    try { ok = new URL(origin).host === c.req.header('host'); } catch { /* not an origin */ }
    if (!ok) return { ok: false, res: fail(c, 403, 'forbidden') };
  }
  if (!(c.req.header('content-type') ?? '').toLowerCase().startsWith('application/json')) return { ok: false, res: fail(c, 415, 'bad_request') };
  const declared = Number(c.req.header('content-length') ?? 0);
  if (declared > MAX_BODY) return { ok: false, res: fail(c, 413, 'bad_request') };
  // a body sent in chunks has no length to check first: it is read only up to the limit and then cut off
  const text = await readCapped(c, MAX_BODY);
  if (text === null) return { ok: false, res: fail(c, 413, 'bad_request') };
  let body: unknown;
  try { body = JSON.parse(text); } catch { return { ok: false, res: fail(c, 400, 'bad_request') }; }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { ok: false, res: fail(c, 400, 'bad_request') };
  return { ok: true, body: body as Record<string, unknown> };
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  // the client is read once at start: index.html and the files of assets/ whose names have the build's shape
  const clientDir = deps.clientDir ?? fileURLToPath(new URL('../../build/client/', import.meta.url));
  const indexHtml = readFileSync(join(clientDir, 'index.html'), 'utf8');
  const assets = new Map<string, Buffer>();
  for (const name of readdirSync(join(clientDir, 'assets'))) if (ASSET_NAME.test(name)) assets.set(name, readFileSync(join(clientDir, 'assets', name)));
  const page = (c: Context, status: 200 | 404 = 200) => c.html(indexHtml, status, { 'cache-control': 'no-store' });
  const ip = (c: Context): string => clientBucket((deps.clientIp ?? defaultClientIp)(c));

  app.use('*', async (c, next) => {
    await next();
    // a response may carry a stricter policy of its own (the screenshot is served with `sandbox`)
    if (!c.res.headers.has('content-security-policy')) c.header('content-security-policy', CSP);
    c.header('x-content-type-options', 'nosniff');
    c.header('referrer-policy', 'no-referrer');
    c.header('cross-origin-opener-policy', 'same-origin');
    c.header('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    c.res.headers.delete('x-powered-by');
  });

  app.get('/healthz', (c) => c.text('ok', 200, { 'cache-control': 'no-store' }));

  app.get('/assets/:file', (c) => {
    const name = c.req.param('file');
    const body = ASSET_NAME.test(name) ? assets.get(name) : undefined;
    if (!body) return c.text('not found', 404);
    return new Response(new Uint8Array(body), { headers: { 'content-type': ASSET_TYPES[name.slice(name.lastIndexOf('.'))]!, 'cache-control': 'public, max-age=31536000, immutable' } });
  });

  // the pages are the client's; the server only hands out its index for the addresses it knows
  app.get('/', (c) => page(c));
  app.get('/panel', (c) => { c.header('content-security-policy', PANEL_CSP); return page(c); });
  app.get('/api/demos', (c) => json(c, 200, { demos: deps.demos }));

  // ---- start a check ----
  app.post('/api/tasks', async (c) => {
    const read = await readJsonBody(c);
    if (!read.ok) return read.res;
    const body = read.body;
    const keys = Object.keys(body);
    if (keys.some((k) => k !== 'url' && k !== 'deep')) return fail(c, 400, 'bad_request');
    const { url, deep } = body as { url?: unknown; deep?: unknown };
    if (deep !== undefined && typeof deep !== 'boolean') return fail(c, 400, 'bad_request');

    const gate = checkAddress(url);
    if (!gate.ok) return fail(c, 400, gate.reason);

    const slot = deps.limiter.start(ip(c));
    if (!slot.ok) return fail(c, slot.reason === 'daily_cap' ? 503 : 429, slot.reason, { 'retry-after': String(slot.retryAfterS) });

    const { task, key } = deps.store.create(gate.url, deep === true);
    try {
      await begin(task, deep === true, slot.release);
    } catch (e) {
      // the supervisor never took it: nothing ran, so it costs the person and the service nothing
      slot.cancel();
      deps.store.drop(task.id);
      if (e instanceof SupervisorError && e.code === 'queue_full') return fail(c, 503, 'busy', { 'retry-after': '30' });
      return fail(c, 503, 'supervisor_unavailable');
    }
    return json(c, 202, { id: task.id, key });
  });

  /** Start the run and return once the supervisor has taken it (or refused it). The rest happens in the background. */
  function begin(task: Task, deep: boolean, release: () => void): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let taken = false;
      const setStage = (stage: Stage, position: number | null) => {
        task.stage = stage;
        task.position = position;
        deps.store.emit(task, 'stage', { stage, at: STAGE_AT[stage], label: stage === 'queued' ? T.queued(position) : T.stageNow[stage] });
      };
      const onProgress = (p: Progress) => {
        if (!taken) { taken = true; resolve(); }
        if (p.kind === 'log') {
          // the agent's log as it happens: cleaned again here, so only entries of the right shape reach the page
          const entry = cleanEntry(p.entry);
          if (entry) deps.store.emit(task, 'log', entry);
          return;
        }
        if (p.kind === 'approval') {
          task.runId = p.run_id;
          task.pending.push({ command_id: p.command_id, cmd: p.cmd, sha256: p.sha256 });
          deps.store.emit(task, 'approval', { waiting: true });
          return;
        }
        if (p.kind === 'decided') {
          task.pending = task.pending.filter((x) => x.command_id !== p.command_id);
          deps.store.emit(task, 'approval', { waiting: task.pending.length > 0 });
          return;
        }
        if (p.kind !== 'state') return;
        const s = stageOf(p.state);
        if (s && s !== task.stage || (s === 'queued' && p.position !== task.position)) setStage(s!, p.position);
      };
      deps.run({ url: task.url, ...(deep ? { session: deps.session } : {}) }, onProgress).then((result) => {
        task.pending = [];
        task.result = result;
        task.runId = result.run_id;
        task.stage = result.state === 'done' ? 'done' : 'failed';
        deps.store.save(task);
        deps.store.emit(task, 'final', {});
      }).catch((e) => {
        task.pending = [];
        if (!taken) { taken = true; reject(e); return; }
        task.stage = 'failed';
        deps.store.emit(task, 'final', {});
      }).finally(release);
    });
  }

  // ---- a task: its state for the client, and the client's page for its addresses ----
  // Public, like the report: the id is the capability to read, the key (never here) the capability to decide.
  app.get('/api/tasks/:id', (c) => {
    const task = deps.store.get(c.req.param('id'));
    if (!task) return fail(c, 404, 'not_found');
    const r = task.result;
    return json(c, 200, {
      id: task.id,
      stage: task.stage,
      label: task.pending.length > 0 ? T.waitingForOwner : task.stage === 'queued' ? T.queued(task.position) : T.stageNow[task.stage],
      at: STAGE_AT[task.stage],
      position: task.position,
      host: hostOf(task.url),
      has_report: r !== null,
      awaiting: task.pending.length > 0,
      checked_at: task.createdAt,
      shots: { desktop: !!r && shotName(r, 'desktop') !== null, tablet: !!r && shotName(r, 'tablet') !== null, mobile: !!r && shotName(r, 'mobile') !== null },
    });
  });

  const SECTIONS = new Set(['security', 'network', 'links', 'behavior', 'agent']);
  const taskPage = (c: Context, section: string | null) =>
    deps.store.get(c.req.param('id') ?? '') && (section === null || SECTIONS.has(section)) ? page(c) : page(c, 404);
  app.get('/r/:id', (c) => taskPage(c, null));
  app.get('/r/:id/report.json', (c) => {
    const task = deps.store.get(c.req.param('id'));
    if (!task?.result) return c.text('not found', 404);
    return c.body(JSON.stringify(publicReport(task.result), null, 2), 200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-disposition': 'attachment' });
  });
  app.get('/r/:id/screenshot.png', async (c) => {
    const task = deps.store.get(c.req.param('id'));
    const asked = c.req.query('device');
    const name = task?.result ? shotName(task.result, asked === 'mobile' || asked === 'tablet' ? asked : 'desktop') : null;
    if (!task?.result || name === null) return c.text('not found', 404);
    try {
      const png = await deps.fetchShot(task.result.run_id, name);
      if (png.length > SHOT_MAX || png.length < 16 || !png.subarray(0, 8).equals(PNG)) return c.text('not found', 404);
      return new Response(new Uint8Array(png), { headers: { 'content-type': 'image/png', 'cache-control': 'private, max-age=3600', 'content-security-policy': 'sandbox', 'content-disposition': 'inline' } });
    } catch {
      return c.text('not found', 404);
    }
  });

  // the section pages come after the fixed names (screenshot.png, report.json) so a name is never taken for a section
  app.get('/r/:id/second-opinion.png', (c) => {
    const task = deps.store.get(c.req.param('id'));
    const png = task?.result?.second_opinion?.screenshot ? deps.store.readImage(task, 'second-opinion') : null;
    if (!png || png.length > SHOT_MAX || png.length < 16 || !png.subarray(0, 8).equals(PNG)) return c.text('not found', 404);
    return new Response(new Uint8Array(png), { headers: { 'content-type': 'image/png', 'cache-control': 'private, max-age=3600', 'content-security-policy': 'sandbox', 'content-disposition': 'inline' } });
  });

  app.get('/r/:id/:tab', (c) => taskPage(c, c.req.param('tab')));

  // ---- Explain and questions about a finished report ----
  // The model only talks: it reads the public report and says something; nothing it says changes the report or starts
  // anything. The explanation is asked once per report and kept; questions are limited per person, per report and by the
  // daily budget of the model. Report ids are public by design, so these limits, not secrecy, are what holds the cost down.
  const explained = new Map<string, ChatReply>();
  const talks = new Map<string, Turn[]>();
  const KEEP_FOR_EVER = new Set<ChatReason | null>([null, 'hooks_fired', 'page_not_read', 'no_model']);
  app.post('/api/reports/:id/chat', async (c) => {
    if (!deps.chat) return fail(c, 404, 'bad_request');
    const read = await readJsonBody(c);
    if (!read.ok) return read.res;
    const { kind, message, ...rest } = read.body;
    if (Object.keys(rest).length || (kind !== 'explain' && kind !== 'ask')) return fail(c, 400, 'bad_request');
    let question = '';
    if (kind === 'ask') {
      if (typeof message !== 'string') return fail(c, 400, 'bad_request');
      question = cleanAnswer(message);
      if (question === '' || question.length > MAX_QUESTION) return fail(c, 400, 'bad_question');
    } else if (message !== undefined) return fail(c, 400, 'bad_request');

    const task = deps.store.get(c.req.param('id') ?? '');
    if (!task?.result || task.stage !== 'done') return fail(c, 404, 'bad_request');
    const done = (r: ChatReply) => json(c, 200, { text: r.text, source: r.source, note: r.reason ? chatNote(r.reason) : null });

    if (kind === 'explain') {
      const kept = explained.get(task.id);
      if (kept) return done(kept);
    }
    const who = ip(c);
    const slot = deps.limiter.chat(who, task.id, kind === 'ask');
    if (!slot.ok) return fail(c, 429, slot.reason, slot.retryAfterS > 0 ? { 'retry-after': String(slot.retryAfterS) } : {});
    try {
      const tkey = `${task.id}|${who}`;
      const history = talks.get(tkey) ?? [];
      const reply = await deps.chat.reply(publicReport(task.result), kind === 'explain' ? { kind: 'explain' } : { kind: 'ask', message: question, history });
      if (kind === 'explain') {
        if (KEEP_FOR_EVER.has(reply.reason)) { if (explained.size > 500) explained.clear(); explained.set(task.id, reply); }
      } else if (reply.source === 'model') {
        if (talks.size > 500) talks.clear();
        talks.set(tkey, [...history, { q: question, a: reply.text }].slice(-4));
      }
      return done(reply);
    } catch {
      return fail(c, 500, 'server');
    } finally {
      slot.release();
    }
  });

  // ---- progress ----
  app.get('/api/tasks/:id/events', (c) => {
    const task = deps.store.get(c.req.param('id'));
    if (!task) return fail(c, 404, 'bad_request');
    const close = deps.limiter.openStream(ip(c));
    if (!close) return fail(c, 429, 'too_many_active', { 'retry-after': '10' });
    const last = Number(c.req.header('last-event-id') ?? 0);
    return streamSSE(c, async (stream) => {
      let ended = false;
      let wake: () => void = () => {};
      const send = (e: { seq: number; type: string; data: string }) => stream.writeSSE({ id: String(e.seq), event: e.type, data: e.data });
      const onEvent = (e: { seq: number; type: string; data: string }) => { void send(e); if (e.type === 'final') { ended = true; wake(); } };
      stream.onAbort(() => { ended = true; wake(); });
      try {
        for (const e of task.events) if (e.seq > (Number.isFinite(last) ? last : 0)) { await send(e); if (e.type === 'final') return; }
        if (task.result || task.stage === 'failed') { await stream.writeSSE({ event: 'final', data: '{}' }); return; }
        task.listeners.add(onEvent);
        const timer = setInterval(() => { void stream.write(': keepalive\n\n'); }, 15_000);
        try { while (!ended) await new Promise<void>((r) => { wake = r; }); } finally { clearInterval(timer); }
      } finally {
        task.listeners.delete(onEvent);
        close();
      }
    });
  });

  // ---- the owner's decisions ----
  const owned = (c: Context): Task | Response => {
    const task = deps.store.get(c.req.param('id') ?? '');
    if (!task) return fail(c, 404, 'bad_request');
    if (!deps.store.keyOk(task, c.req.header('x-task-key'))) {
      if (!deps.limiter.badKey(ip(c))) return fail(c, 429, 'forbidden', { 'retry-after': '60' });
      return fail(c, 403, 'forbidden');
    }
    return task;
  };

  // ---- a second opinion from Cloudflare's URL Scanner, on a page the sandbox could not read ----
  const asking = new Set<string>();
  // a scan we sent that was still running when the answer was due: the next ask polls it instead of sending another
  const submitted = new Map<string, string>();
  app.post('/api/tasks/:id/second-opinion', async (c) => {
    if (!deps.urlscan) return fail(c, 404, 'not_found');
    const t = owned(c);
    if (t instanceof Response) return t;
    const read = await readJsonBody(c);
    if (!read.ok) return read.res;
    if (Object.keys(read.body).some((k) => k !== 'publish') || (read.body.publish !== undefined && typeof read.body.publish !== 'boolean')) return fail(c, 400, 'bad_request');
    if (!t.result || t.stage !== 'done') return fail(c, 404, 'not_found');
    if (t.result.second_opinion) return json(c, 200, { second_opinion: publicReport(t.result).second_opinion });
    // only for a page we could not read: a verdict of our own needs no one else's
    if (publicReport(t.result).verdict !== 'unknown') return fail(c, 400, 'bad_request');
    if (asking.has(t.id)) return fail(c, 429, 'chat_busy');
    asking.add(t.id);
    try {
      const publish = read.body.publish === true;
      const at = () => Math.min(86_400_000, Math.max(0, Date.now() - t.createdAt));
      const out = await deps.urlscan.opinion(t.result.url, publish, submitted.get(t.id));
      if (!out.ok) {
        if (out.reason === 'needs_consent') return json(c, 409, { code: 'needs_consent', message: errorText('needs_consent') });
        if (out.reason === 'pending') {
          if (out.submitted) submitted.set(t.id, out.submitted);
          return json(c, 503, { code: 'scan_pending', message: errorText('scan_pending') }, { 'retry-after': '30' });
        }
        if (out.reason === 'refused') return json(c, 400, { code: 'scan_refused', message: errorText('scan_refused') });
        if (out.reason === 'quota') return json(c, 503, { code: 'scan_quota', message: errorText('scan_quota') });
        return fail(c, 503, 'supervisor_unavailable');
      }
      submitted.delete(t.id);
      // the title was written by the page: it goes through the hooks like any text of a page
      const withheld = out.opinion.title !== '' && scanText('second_opinion', out.opinion.title).triggered;
      if (out.screenshot) deps.store.saveImage(t, 'second-opinion', out.screenshot);
      t.result.second_opinion = { ...out.opinion, title: withheld ? '' : out.opinion.title, title_withheld: withheld, screenshot: out.screenshot !== null };
      t.result.log ??= []; // a report kept from before the log existed
      for (const entry of [
        cleanEntry({ t: at(), code: 'second_opinion_asked', d: { publish } }),
        cleanEntry({ t: at(), code: 'second_opinion', d: { source: out.opinion.source, ...(out.opinion.status !== null ? { status: out.opinion.status } : {}), ...(out.opinion.malicious !== null ? { malicious: out.opinion.malicious } : {}), host: (() => { try { return new URL(out.opinion.final_url).host; } catch { return ''; } })() } }),
      ]) if (entry && t.result.log.length < MAX_LOG) t.result.log.push(entry);
      deps.store.save(t);
      return json(c, 200, { second_opinion: publicReport(t.result).second_opinion });
    } finally {
      asking.delete(t.id);
    }
  });

  app.get('/api/tasks/:id/pending', (c) => {
    const t = owned(c);
    if (t instanceof Response) return t;
    const pending = t.pending.map((p) => ({ command_id: p.command_id, command_sha256: p.sha256, label: T.actions[p.cmd] ?? T.actionOther }));
    return json(c, 200, { pending });
  });

  app.post('/api/tasks/:id/approvals', async (c) => {
    const t = owned(c);
    if (t instanceof Response) return t;
    const read = await readJsonBody(c);
    if (!read.ok) return read.res;
    if (Object.keys(read.body).some((k) => k !== 'command_id' && k !== 'command_sha256' && k !== 'allow')) return fail(c, 400, 'bad_request');
    const b = read.body as { command_id?: unknown; command_sha256?: unknown; allow?: unknown };
    // only what is waiting now, in a live run: a decision on a finished run has nothing left to act on
    const listed = t.pending.find((p) => p.command_id === b?.command_id && p.sha256 === b?.command_sha256);
    if (!listed || !t.runId || typeof b.allow !== 'boolean') return fail(c, 400, 'bad_request');
    try {
      if (b.allow) await deps.approve(t.runId, listed.command_id, listed.sha256);
      else await deps.reject(t.runId, listed.command_id);
    } catch (e) {
      if (e instanceof SupervisorError && (e.status === 409 || e.status === 410)) return json(c, 400, { code: 'expired', message: T.expired });
      return fail(c, 503, 'supervisor_unavailable');
    }
    return json(c, 202, { message: b.allow ? T.approved : T.denied });
  });

  // an unknown address gets the client with a 404 (it shows "not found"); an unknown API path a plain JSON 404
  app.notFound((c) => (c.req.path.startsWith('/api/') ? fail(c, 404, 'not_found') : page(c, 404)));
  app.onError((_e, c) => (c.req.path.startsWith('/api/') ? fail(c, 500, 'server') : c.text('server error', 500)));
  return app;
}

function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return ''; }
}
