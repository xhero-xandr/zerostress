// The client of the supervisor (spec 006, 5). The supervisor listens on a Unix socket whose file permissions are the
// only access control (006, 4): this is the one process of the web layer that may talk to it. Everything that comes
// back is read strictly and with limits, because the events carry what a hostile page wrote.

import { request, type IncomingMessage } from 'node:http';

export type Target = { socketPath: string } | { baseUrl: string };

export class SupervisorError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface SseEvent {
  /** the sequence number the supervisor gave it (Last-Event-ID) */
  seq: number;
  type: string;
  data: string;
}

export interface SubmitResult {
  run_id: string;
  state: string;
  position: number | null;
  session?: boolean;
}

export interface CommandReceipt {
  command_id: string;
  status: string;
  command_sha256: string;
}

export interface ClientOptions {
  requestTimeoutMs?: number;
}

export const MAX_FRAME_BYTES = 2 * 1024 * 1024;
const MAX_JSON_BYTES = 256 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ARTIFACT = /^[0-9a-f]{16}\.(?:png|bin)$/;

/** Splits a stream of bytes into SSE frames. Strict about size; comments and unknown fields are ignored. */
export class SseParser {
  private buf = '';
  private frame: { id?: string; event?: string; data: string[] } = { data: [] };
  private size = 0;

  push(chunk: string): SseEvent[] {
    this.buf += chunk;
    const out: SseEvent[] = [];
    let at: number;
    while ((at = this.buf.search(/\r\n|\n|\r/)) >= 0) {
      const line = this.buf.slice(0, at);
      const eol = this.buf.startsWith('\r\n', at) ? 2 : 1;
      if (eol === 1 && this.buf[at] === '\r' && at + 1 === this.buf.length) break; // a CR at the very end may be half of CRLF
      this.buf = this.buf.slice(at + eol);
      const ev = this.line(line);
      if (ev) out.push(ev);
    }
    if (this.buf.length > MAX_FRAME_BYTES) throw new SupervisorError(0, 'frame_too_large', 'an event line is longer than the limit');
    return out;
  }

  private line(line: string): SseEvent | null {
    this.size += line.length + 1;
    if (this.size > MAX_FRAME_BYTES) throw new SupervisorError(0, 'frame_too_large', 'an event is larger than the limit');
    if (line === '') {
      const f = this.frame;
      this.frame = { data: [] };
      this.size = 0;
      if (f.data.length === 0 && f.event === undefined) return null;
      const seq = f.id !== undefined && /^\d{1,12}$/.test(f.id) ? Number(f.id) : -1;
      return { seq, type: f.event ?? 'message', data: f.data.join('\n') };
    }
    if (line.startsWith(':')) return null; // a keepalive comment
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'id') this.frame.id = value;
    else if (field === 'event') this.frame.event = value;
    else if (field === 'data') this.frame.data.push(value);
    return null;
  }
}

export interface SupervisorClient {
  submit(url: string, session?: { idle_s?: number; max_s?: number }): Promise<SubmitResult>;
  get(runId: string): Promise<Record<string, unknown>>;
  command(runId: string, line: string): Promise<CommandReceipt>;
  cancel(runId: string): Promise<void>;
  /** a person's decision on a risky command: the supervisor checks the hash and the time again */
  approve(runId: string, commandId: string, sha256: string): Promise<void>;
  /** a person's "no" to one risky command; the run goes on without it */
  reject(runId: string, commandId: string): Promise<void>;
  artifact(runId: string, name: string, maxBytes: number): Promise<Buffer>;
  /** the events of a run after `afterSeq`, until the stream ends; the caller reconnects while the run is not finished */
  events(runId: string, afterSeq: number, signal?: AbortSignal): AsyncGenerator<SseEvent>;
}

export function createSupervisorClient(target: Target, opts: ClientOptions = {}): SupervisorClient {
  const timeout = opts.requestTimeoutMs ?? 15_000;
  const where = 'socketPath' in target ? { socketPath: target.socketPath } : (() => { const u = new URL(target.baseUrl); return { host: u.hostname, port: Number(u.port) || 80 }; })();

  function http(method: string, path: string, body: string | null, headers: Record<string, string> = {}, signal?: AbortSignal): Promise<IncomingMessage> {
    return new Promise((resolve, reject) => {
      const req = request({ ...where, method, path, headers: { ...(body !== null ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) } : {}), ...headers }, agent: false, signal }, resolve);
      req.on('error', reject);
      if (body !== null) req.write(body);
      req.end();
    });
  }

  async function readBody(res: IncomingMessage, limit: number): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let n = 0;
    for await (const c of res) {
      n += (c as Buffer).length;
      if (n > limit) {
        res.destroy();
        throw new SupervisorError(res.statusCode ?? 0, 'body_too_large', 'a response is larger than the limit');
      }
      chunks.push(c as Buffer);
    }
    return Buffer.concat(chunks);
  }

  async function json(method: string, path: string, body: unknown = null): Promise<{ status: number; value: any }> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeout);
    try {
      const res = await http(method, path, body === null ? null : JSON.stringify(body), {}, ac.signal);
      const raw = await readBody(res, MAX_JSON_BYTES);
      let value: any = null;
      try {
        value = raw.length ? JSON.parse(raw.toString('utf8')) : null;
      } catch {
        throw new SupervisorError(res.statusCode ?? 0, 'bad_response', 'the supervisor sent something that is not JSON');
      }
      return { status: res.statusCode ?? 0, value };
    } catch (e) {
      if (e instanceof SupervisorError) throw e;
      throw new SupervisorError(0, ac.signal.aborted ? 'timeout' : 'unreachable', `the supervisor did not answer: ${(e as Error).name}`);
    } finally {
      clearTimeout(timer);
    }
  }

  const fail = (status: number, value: any): never => {
    const code = typeof value?.code === 'string' && /^[a-z_]{1,40}$/.test(value.code) ? value.code : 'error';
    throw new SupervisorError(status, code, `the supervisor refused (${status}${code === 'error' ? '' : ` ${code}`})`);
  };
  const checkId = (id: string) => {
    if (!UUID.test(id)) throw new SupervisorError(0, 'bad_id', 'not a run id');
  };

  return {
    async submit(url, session) {
      const { status, value } = await json('POST', '/v1/runs', { kind: 'url', url, ...(session ? { session } : {}) });
      if (status !== 202) fail(status, value);
      if (typeof value?.run_id !== 'string' || !UUID.test(value.run_id) || typeof value.state !== 'string') throw new SupervisorError(status, 'bad_response', 'the answer to a submission is malformed');
      return { run_id: value.run_id, state: value.state, position: typeof value.position === 'number' ? value.position : null, ...(value.session === true ? { session: true } : {}) };
    },
    async get(runId) {
      checkId(runId);
      const { status, value } = await json('GET', `/v1/runs/${runId}`);
      if (status !== 200) fail(status, value);
      return value;
    },
    async command(runId, line) {
      checkId(runId);
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new SupervisorError(0, 'bad_command', 'a command must be JSON');
      }
      const { status, value } = await json('POST', `/v1/runs/${runId}/commands`, parsed);
      if (status !== 202) fail(status, value);
      if (typeof value?.command_id !== 'string' || typeof value.status !== 'string' || typeof value.command_sha256 !== 'string') throw new SupervisorError(status, 'bad_response', 'the receipt of a command is malformed');
      return { command_id: value.command_id, status: value.status, command_sha256: value.command_sha256 };
    },
    async approve(runId, commandId, sha256) {
      checkId(runId);
      if (typeof commandId !== 'string' || !/^[A-Za-z0-9_.:-]{1,64}$/.test(commandId) || typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) throw new SupervisorError(0, 'bad_approval', 'not a command id and hash');
      const { status, value } = await json('POST', `/v1/runs/${runId}/approvals`, { command_id: commandId, command_sha256: sha256 });
      if (status !== 202) fail(status, value);
    },
    async reject(runId, commandId) {
      checkId(runId);
      // the id goes into the path: only the supervisor's own id characters, so nothing like ".." can get there
      if (typeof commandId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(commandId)) throw new SupervisorError(0, 'bad_approval', 'not a command id');
      const { status, value } = await json('DELETE', `/v1/runs/${runId}/commands/${commandId}`);
      if (status !== 202) fail(status, value);
    },
    async cancel(runId) {
      checkId(runId);
      const { status, value } = await json('DELETE', `/v1/runs/${runId}`);
      if (status !== 202 && status !== 409) fail(status, value);
    },
    async artifact(runId, name, maxBytes) {
      checkId(runId);
      if (!ARTIFACT.test(name)) throw new SupervisorError(0, 'bad_name', 'not an artifact name');
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeout * 2);
      try {
        const res = await http('GET', `/v1/runs/${runId}/artifacts/${name}`, null, {}, ac.signal);
        if (res.statusCode !== 200) {
          res.resume();
          fail(res.statusCode ?? 0, null);
        }
        return await readBody(res, maxBytes);
      } finally {
        clearTimeout(timer);
      }
    },
    async *events(runId, afterSeq, signal) {
      checkId(runId);
      const res = await http('GET', `/v1/runs/${runId}/events`, null, { accept: 'text/event-stream', ...(afterSeq > 0 ? { 'last-event-id': String(afterSeq) } : {}) }, signal);
      if (res.statusCode !== 200) {
        const raw = await readBody(res, 4096).catch(() => Buffer.alloc(0));
        let v: unknown = null;
        try { v = JSON.parse(raw.toString('utf8')); } catch { /* not JSON */ }
        fail(res.statusCode ?? 0, v);
      }
      res.setEncoding('utf8');
      const parser = new SseParser();
      try {
        for await (const chunk of res) for (const ev of parser.push(chunk as string)) yield ev;
      } finally {
        res.destroy();
      }
    },
  };
}
