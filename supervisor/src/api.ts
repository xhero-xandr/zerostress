import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Config } from './config.ts';
import { nullLogger } from './logger.ts';
import type { Logger } from './logger.ts';
import { RUN_ID_RE } from './store.ts';
import { DrainingError, LowDiskError, QueueFullError } from './supervisor.ts';
import type { Supervisor } from './supervisor.ts';
import { isTerminal } from './types.ts';
import type { RunEvent, RunState } from './types.ts';

const MAX_BODY = 64 * 1024;
const MAX_URL = 2048;

export type Validated = { ok: true; url: string } | { ok: false; error: string };

/** Shape check only. Which hosts are acceptable (SSRF) is the gatekeeper's job in the web layer; the host firewall backs it up. */
export function validateSubmit(body: unknown): Validated {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { ok: false, error: 'body must be a JSON object' };
  const o = body as Record<string, unknown>;
  for (const k of Object.keys(o)) if (k !== 'kind' && k !== 'url') return { ok: false, error: `unknown field: ${k.slice(0, 40)}` };
  if (o.kind !== 'url') return { ok: false, error: 'kind must be "url"' };
  if (typeof o.url !== 'string' || o.url.length === 0) return { ok: false, error: 'url must be a non-empty string' };
  if (o.url.length > MAX_URL) return { ok: false, error: `url is longer than ${MAX_URL} characters` };
  if (/[\u0000- \u007f]/.test(o.url)) return { ok: false, error: 'url must not contain spaces or control characters' };
  let parsed: URL;
  try {
    parsed = new URL(o.url);
  } catch {
    return { ok: false, error: 'url is not a valid absolute URL' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { ok: false, error: 'only http and https are allowed' };
  if (!parsed.hostname) return { ok: false, error: 'url has no host' };
  return { ok: true, url: o.url };
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<{ ok: true; text: string } | { ok: false; tooLarge: boolean }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (over) return; // keep draining so the client can read the 413 instead of a reset
      if (size > MAX_BODY) {
        over = true;
        chunks.length = 0;
        resolve({ ok: false, tooLarge: true });
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve({ ok: true, text: Buffer.concat(chunks).toString('utf8') }));
    req.on('error', () => resolve({ ok: false, tooLarge: false }));
  });
}

function sseFrame(ev: RunEvent): string {
  // a raw CR or LF inside data would end the SSE field; JSON lines never contain them, anything else is neutralised
  const data = ev.data.replace(/\r/g, '\\r').replace(/\n/g, '\\n');
  return `id: ${ev.seq}\nevent: ${ev.type}\ndata: ${data}\n\n`;
}

function isTerminalEvent(ev: RunEvent): boolean {
  if (ev.type !== 'state') return false;
  try {
    return isTerminal((JSON.parse(ev.data) as { state: RunState }).state);
  } catch {
    return false;
  }
}

export function createApi(sup: Supervisor, config: Config, log: Logger = nullLogger): http.Server {
  function events(req: IncomingMessage, res: ServerResponse, id: string): void {
    const raw = req.headers['last-event-id'];
    const after = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : 0;
    let ended = false;
    let keepalive: NodeJS.Timeout | undefined;
    let unsubscribe = () => {};
    const end = () => {
      if (ended) return;
      ended = true;
      if (keepalive) clearInterval(keepalive);
      unsubscribe();
      res.end();
    };

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const sub = sup.subscribe(id, after, (ev) => {
      if (ended) return;
      res.write(sseFrame(ev));
      if (isTerminalEvent(ev)) end();
    });
    if (!sub) {
      end();
      return;
    }
    unsubscribe = sub.unsubscribe;
    for (const ev of sub.replay) {
      res.write(sseFrame(ev));
      if (isTerminalEvent(ev)) {
        end();
        return;
      }
    }
    const view = sup.get(id);
    if (!view || isTerminal(view.state)) {
      end();
      return;
    }
    keepalive = setInterval(() => res.write(':keepalive\n\n'), config.keepaliveMs);
    res.on('close', end);
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://local');
    const parts = url.pathname.split('/').filter(Boolean);
    const method = req.method ?? 'GET';

    if (parts[0] !== 'v1') return send(res, 404, { error: 'not found' });

    if (parts[1] === 'health' && parts.length === 2) {
      if (method !== 'GET') return send(res, 405, { error: 'method not allowed' }, { allow: 'GET' });
      return send(res, 200, sup.health());
    }

    if (parts[1] === 'runs' && parts.length === 2) {
      if (method !== 'POST') return send(res, 405, { error: 'method not allowed' }, { allow: 'POST' });
      const body = await readBody(req);
      if (!body.ok) {
        return body.tooLarge
          ? send(res, 413, { error: 'request body too large' }, { connection: 'close' })
          : send(res, 400, { error: 'unreadable body' });
      }
      let json: unknown;
      try {
        json = JSON.parse(body.text);
      } catch {
        return send(res, 400, { error: 'body is not valid JSON' });
      }
      const v = validateSubmit(json);
      if (!v.ok) return send(res, 400, { error: v.error });
      try {
        return send(res, 202, sup.submit(v.url));
      } catch (e) {
        if (e instanceof QueueFullError) return send(res, 429, { error: 'queue is full' }, { 'retry-after': '10' });
        if (e instanceof DrainingError || e instanceof LowDiskError) return send(res, 503, { error: e.message }, { 'retry-after': '30' });
        throw e;
      }
    }

    if (parts[1] === 'runs' && parts[2] && RUN_ID_RE.test(parts[2])) {
      const id = parts[2];
      if (parts.length === 3) {
        if (method === 'GET') {
          const view = sup.get(id);
          return view ? send(res, 200, view) : send(res, 404, { error: 'not found' });
        }
        if (method === 'DELETE') {
          const r = sup.cancel(id);
          if (r === 'not_found') return send(res, 404, { error: 'not found' });
          if (r === 'conflict') return send(res, 409, { error: 'run is already finished' });
          return send(res, 202, { run_id: id, result: r });
        }
        return send(res, 405, { error: 'method not allowed' }, { allow: 'GET, DELETE' });
      }
      if (parts.length === 4 && parts[3] === 'events') {
        if (method !== 'GET') return send(res, 405, { error: 'method not allowed' }, { allow: 'GET' });
        if (!sup.get(id)) return send(res, 404, { error: 'not found' });
        return events(req, res, id);
      }
    }
    return send(res, 404, { error: 'not found' });
  }

  return http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      log('error', 'request failed', { detail: String(e).slice(0, 200) });
      if (!res.headersSent) send(res, 500, { error: 'internal error' });
      else res.end();
    });
  });
}
