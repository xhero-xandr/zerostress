// A stand-in for the supervisor: the same HTTP interface (spec 006, 5) on a local port, with a log of events the test
// fills in and a record of everything the agent asked of it. The real supervisor is exercised on the server.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export const RUN_ID = '11111111-1111-4111-8111-111111111111';

export interface Receipt { status?: number; body?: unknown; delayMs?: number }

export interface FakeSup {
  url: string;
  submits: any[];
  commands: any[];
  /** approvals the agent passed on: [command_id, sha256] */
  approvals: string[][];
  /** what to do once a command is approved */
  onApprove: (commandId: string, sup: FakeSup) => void;
  cancelled: number;
  /** what the fake reports as the host's processor measure of the VM (the run's view); none by default */
  vmCpu: Record<string, unknown> | null;
  eventRequests: Array<{ lastEventId: string | undefined }>;
  artifactRequests: string[];
  /** pushes one event to everybody who listens (and keeps it for those who come later) */
  emit(type: string, data: unknown): void;
  state(state: string, extra?: Record<string, unknown>): void;
  evidence(obj: unknown): void;
  /** the stream ends (the run is over); ends the open responses */
  end(): void;
  /** the connections are cut without a word, as if the network failed; the log stays */
  drop(): void;
  artifacts: Map<string, Buffer>;
  /** what to do with a command that arrives: push events, return a receipt */
  onCommand: (cmd: any, sup: FakeSup) => Receipt | void;
  /** how a submission is answered; default 202 */
  onSubmit: (body: any) => Receipt | void;
  close(): Promise<void>;
}

export async function startFakeSup(): Promise<FakeSup> {
  const log: Array<{ seq: number; type: string; data: string }> = [];
  const open = new Set<ServerResponse>();
  let ended = false;
  const sup: FakeSup = {
    url: '', submits: [], commands: [], approvals: [], onApprove: () => undefined, cancelled: 0, vmCpu: null, eventRequests: [], artifactRequests: [], artifacts: new Map(),
    emit(type, data) {
      const ev = { seq: log.length + 1, type, data: typeof data === 'string' ? data : JSON.stringify(data) };
      log.push(ev);
      for (const r of open) r.write(frame(ev));
    },
    state(state, extra = {}) { sup.emit('state', { state, ...extra }); },
    evidence(obj) { sup.emit('evidence', typeof obj === 'string' ? obj : JSON.stringify(obj)); },
    end() { ended = true; for (const r of open) r.end(); open.clear(); },
    drop() { for (const r of open) r.destroy(); open.clear(); },
    onCommand: () => undefined,
    onSubmit: () => undefined,
    close: async () => {},
  };
  const frame = (e: { seq: number; type: string; data: string }) => `id: ${e.seq}\nevent: ${e.type}\ndata: ${e.data.replace(/\r/g, '\\r').replace(/\n/g, '\\n')}\n\n`;

  const body = (req: IncomingMessage) => new Promise<string>((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
  const send = (res: ServerResponse, status: number, value: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(value));
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const raw = await body(req);
    if (req.method === 'POST' && url.pathname === '/v1/runs') {
      const parsed = JSON.parse(raw);
      sup.submits.push(parsed);
      const r = sup.onSubmit(parsed);
      if (r) return send(res, r.status ?? 202, r.body ?? {});
      return send(res, 202, { run_id: RUN_ID, state: 'queued', position: 0, ...(parsed.session ? { session: true } : {}) });
    }
    if (req.method === 'GET' && url.pathname === `/v1/runs/${RUN_ID}/events`) {
      const last = req.headers['last-event-id'];
      sup.eventRequests.push({ lastEventId: Array.isArray(last) ? last[0] : last });
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const after = last ? Number(last) : 0;
      for (const e of log) if (e.seq > after) res.write(frame(e));
      if (ended) return void res.end();
      open.add(res);
      res.on('close', () => open.delete(res));
      return;
    }
    if (req.method === 'POST' && url.pathname === `/v1/runs/${RUN_ID}/commands`) {
      const cmd = JSON.parse(raw);
      sup.commands.push(cmd);
      const r = sup.onCommand(cmd, sup);
      if (r?.delayMs) await new Promise((x) => setTimeout(x, r.delayMs));
      if (r) return send(res, r.status ?? 202, r.body ?? {});
      return send(res, 202, { command_id: cmd.id, status: 'accepted', command_sha256: 'a'.repeat(64) });
    }
    if (req.method === 'POST' && url.pathname === `/v1/runs/${RUN_ID}/approvals`) {
      const a = JSON.parse(raw);
      sup.approvals.push([a.command_id, a.command_sha256]);
      setTimeout(() => sup.onApprove(a.command_id, sup), 10);
      return send(res, 202, { command_id: a.command_id, status: 'approved' });
    }
    if (req.method === 'DELETE' && url.pathname === `/v1/runs/${RUN_ID}`) {
      sup.cancelled++;
      return send(res, 202, { run_id: RUN_ID, result: 'cancelled' });
    }
    const art = /^\/v1\/runs\/[0-9a-f-]+\/artifacts\/([0-9a-f]{16}\.(?:png|bin))$/.exec(url.pathname);
    if (req.method === 'GET' && art) {
      sup.artifactRequests.push(art[1]!);
      const bytes = sup.artifacts.get(art[1]!);
      if (!bytes) return send(res, 404, { error: 'not found' });
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': bytes.length });
      return void res.end(bytes);
    }
    if (req.method === 'GET' && url.pathname === `/v1/runs/${RUN_ID}`) return send(res, 200, { run_id: RUN_ID, state: 'running', ...(sup.vmCpu ? { vm_cpu: sup.vmCpu } : {}) });
    send(res, 404, { error: 'not found' });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  sup.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  sup.close = () => new Promise<void>((r) => { for (const x of open) x.destroy(); server.closeAllConnections(); server.close(() => r()); });
  return sup;
}
