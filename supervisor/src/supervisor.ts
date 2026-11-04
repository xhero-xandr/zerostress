import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Config } from './config.ts';
import { nullLogger, urlInfo } from './logger.ts';
import type { Logger } from './logger.ts';
import { SessionCommands, isOpenStatus } from './session.ts';
import type { ApproveResult, RejectResult, SubmitResult } from './session.ts';
import { SlotPool } from './slots.ts';
import { ResultFiles, Store } from './store.ts';
import { RunError, isTerminal } from './types.ts';
import type { Backend, FailReason, RunEvent, RunRecord, RunState, SessionLimits, VmHandle } from './types.ts';

export class QueueFullError extends Error {}
export class DrainingError extends Error {}
export class LowDiskError extends Error {}
export class SessionsDisabledError extends Error {}

/** The agent's own status line is a few dozen bytes; a longer line can never be one. */
const STATUS_LINE_MAX = 512;
/** Only short collector lines can be `session_ready` or `cmd_result`. */
const CONTROL_LINE_MAX = 4096;

export type NotFound = { ok: false; code: 'not_found'; error: string };

export interface Deps {
  config: Config;
  store: Store;
  results: ResultFiles;
  backend: Backend;
  log?: Logger;
  now?: () => number;
  freeGb?: () => number;
  imageSha256?: () => string | null;
  /** Interval of the stale-queue sweep; tests shorten it. */
  sweepMs?: number;
}

export interface RunView {
  run_id: string;
  state: RunState;
  reason: FailReason | null;
  position: number | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  agent_status: string | null;
  partial: boolean;
  events: number;
  expires_at: string;
  /** Present for interactive sessions. */
  session?: { idle_s: number; max_s: number };
  commands?: { total: number; awaiting_approval: number };
}

type Listener = (ev: RunEvent) => void;

interface Active {
  ctl: AbortController;
  done: Promise<void>;
}

const AGENT_STATUS_REASON: Record<string, FailReason> = {
  exited_nonzero: 'collector_failed',
  start_failed: 'collector_failed',
  timeout: 'timeout',
  oversize: 'oversize',
};

function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    p.catch(() => {});
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

function asRunError(e: unknown, fallback: FailReason): RunError {
  return e instanceof RunError ? e : new RunError(fallback, e instanceof Error ? e.message : String(e));
}

export class Supervisor {
  private config: Config;
  private store: Store;
  private results: ResultFiles;
  private backend: Backend;
  private log: Logger;
  private now: () => number;
  private freeGb: () => number;
  private imageSha256: () => string | null;
  private sweepMs: number;

  private pool: SlotPool;
  private queue: string[] = [];
  private active = new Map<string, Active>();
  /** Command state of sessions; kept after the run ends (everything voided) so the totals stay readable. */
  private sessions = new Map<string, SessionCommands>();
  private sessionRuns = 0;
  private listeners = new Map<string, Set<Listener>>();
  private seqs = new Map<string, number>();
  private draining = false;
  private timers: NodeJS.Timeout[] = [];

  constructor(deps: Deps) {
    this.config = deps.config;
    this.store = deps.store;
    this.results = deps.results;
    this.backend = deps.backend;
    this.log = deps.log ?? nullLogger;
    this.now = deps.now ?? Date.now;
    this.freeGb = deps.freeGb ?? (() => Number.POSITIVE_INFINITY);
    this.imageSha256 = deps.imageSha256 ?? (() => null);
    this.sweepMs = deps.sweepMs ?? 1000;
    this.pool = new SlotPool(this.config.concurrency);
  }

  // ---- lifecycle of the service ------------------------------------------------------------------

  /** Startup recovery (spec 006, 3.5), then begin accepting work. */
  async start(): Promise<void> {
    await this.backend.recoverHost();
    for (const rec of this.store.inFlight()) {
      this.voidDanglingCommands(rec.id);
      this.setState(rec, 'failed', { reason: 'supervisor_restart', finishedAt: this.now() });
    }
    for (const rec of this.store.queued()) this.queue.push(rec.id);
    // unref: housekeeping timers must never keep the process alive on their own
    this.timers.push(setInterval(() => this.sweepQueue(), this.sweepMs).unref());
    this.timers.push(setInterval(() => this.removeExpired(), 10 * 60 * 1000).unref());
    this.removeExpired();
    this.pump();
  }

  /** Stop taking work, give running jobs a moment, then force them down. Queued runs stay in the database. */
  async shutdown(): Promise<void> {
    this.draining = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    const all = () => Promise.all([...this.active.values()].map((a) => a.done));
    const grace = new Promise<'grace'>((r) => setTimeout(() => r('grace'), this.config.shutdownGraceMs).unref());
    if ((await Promise.race([all().then(() => 'done' as const), grace])) === 'grace') {
      for (const a of this.active.values()) a.ctl.abort(new RunError('supervisor_restart'));
      await all();
    }
  }

  // ---- API used by the HTTP layer -----------------------------------------------------------------

  submit(url: string, session: SessionLimits | null = null): { run_id: string; state: RunState; position: number | null } {
    if (this.draining) throw new DrainingError('shutting down');
    if (this.freeGb() < this.config.minFreeGb) throw new LowDiskError('not enough free disk space');
    if (session && this.config.sessionSlots === 0) throw new SessionsDisabledError('sessions are disabled');
    if (this.queue.length >= this.config.queueMax) throw new QueueFullError('queue is full');

    const id = randomUUID();
    const created = this.now();
    this.store.insert(id, url, created, created + this.config.resultTtlMs, session);
    this.seqs.set(id, 0);
    const rec = this.store.get(id)!;
    this.queue.push(id);
    this.emit(id, 'state', this.stateData(rec));
    this.log('info', 'run accepted', { run_id: id, ...urlInfo(url) });
    this.pump();
    const now = this.store.get(id)!;
    return { run_id: id, state: now.state, position: this.positionOf(id) };
  }

  get(id: string): RunView | undefined {
    const rec = this.store.get(id);
    return rec ? this.view(rec) : undefined;
  }

  cancel(id: string): 'cancelled' | 'cancelling' | 'conflict' | 'not_found' {
    const rec = this.store.get(id);
    if (!rec) return 'not_found';
    if (isTerminal(rec.state)) return 'conflict';
    const qi = this.queue.indexOf(id);
    if (qi >= 0) {
      this.queue.splice(qi, 1);
      this.setState(rec, 'failed', { reason: 'cancelled', finishedAt: this.now() });
      this.announcePositions();
      return 'cancelled';
    }
    this.active.get(id)?.ctl.abort(new RunError('cancelled'));
    return 'cancelling';
  }

  /** Replay of stored events after `afterSeq`, then live ones. The caller ends the stream on a terminal state event. */
  subscribe(id: string, afterSeq: number, listener: Listener): { replay: RunEvent[]; unsubscribe: () => void } | undefined {
    const rec = this.store.get(id);
    if (!rec) return undefined;
    // reading and registering happen in the same tick and appends are synchronous: no event can slip between
    const replay = this.results.read(id, afterSeq);
    let set = this.listeners.get(id);
    if (!set) this.listeners.set(id, (set = new Set()));
    set.add(listener);
    return {
      replay,
      unsubscribe: () => {
        const s = this.listeners.get(id);
        s?.delete(listener);
        if (s && s.size === 0) this.listeners.delete(id);
      },
    };
  }

  health(): Record<string, unknown> {
    return {
      ok: true,
      version: '0.2.0',
      concurrency: this.config.concurrency,
      running: this.active.size,
      queued: this.queue.length,
      sessions: { running: this.sessionRuns, limit: this.config.sessionSlots },
      free_gb: Number.isFinite(this.freeGb()) ? Math.floor(this.freeGb()) : null,
      image_sha256: this.imageSha256(),
    };
  }

  // ---- session commands (spec 006, 3.8) -------------------------------------------------------------------

  private liveSession(id: string): SessionCommands | NotFound {
    if (!this.store.get(id)) return { ok: false, code: 'not_found', error: 'no such run' };
    // a run without a live session (one-shot, still starting, finished) answers like a session that is not accepting
    return this.sessions.get(id) ?? ({ ok: false, code: 'not_found', error: 'no such session' } as NotFound);
  }

  submitCommand(id: string, body: unknown): SubmitResult | NotFound {
    if (!this.store.get(id)) return { ok: false, code: 'not_found', error: 'no such run' };
    const s = this.sessions.get(id);
    if (!s) return { ok: false, code: 'not_session', error: 'the run is not a session' };
    return s.submit(body);
  }

  approveCommand(id: string, commandId: string, sha256: unknown): ApproveResult | NotFound {
    const s = this.liveSession(id);
    return s instanceof SessionCommands ? s.approve(commandId, sha256) : s;
  }

  rejectCommand(id: string, commandId: string): RejectResult | NotFound {
    const s = this.liveSession(id);
    return s instanceof SessionCommands ? s.reject(commandId) : s;
  }

  // ---- queue ---------------------------------------------------------------------------------------

  private positionOf(id: string): number | null {
    const i = this.queue.indexOf(id);
    return i >= 0 ? i + 1 : null;
  }

  private announcePositions(): void {
    this.queue.forEach((id) => {
      const rec = this.store.get(id);
      if (rec) this.emit(id, 'state', this.stateData(rec));
    });
  }

  private pump(): void {
    if (this.draining) return;
    let moved = false;
    while (this.queue.length > 0) {
      const slot = this.pool.acquire();
      if (slot === null) break;
      // FIFO, except that a session waits for a free session slot while plain runs pass it
      const qi = this.queue.findIndex((queued) => this.eligible(queued));
      if (qi < 0) {
        this.pool.release(slot);
        break;
      }
      const id = this.queue.splice(qi, 1)[0]!;
      moved = true;
      const rec = this.store.get(id);
      if (!rec || rec.state !== 'queued') {
        this.pool.release(slot);
        continue;
      }
      if (this.now() - rec.createdAt > this.config.queueWaitMs) {
        this.pool.release(slot);
        this.setState(rec, 'failed', { reason: 'queue_timeout', finishedAt: this.now() });
        continue;
      }
      const ctl = new AbortController();
      if (rec.session) this.sessionRuns++;
      const done = this.execute(rec, slot, ctl);
      this.active.set(id, { ctl, done });
    }
    if (moved) this.announcePositions();
  }

  private eligible(id: string): boolean {
    const rec = this.store.get(id);
    if (!rec || rec.state !== 'queued') return true; // dropped by the caller
    return !rec.session || this.sessionRuns < this.config.sessionSlots;
  }

  private sweepQueue(): void {
    const stale = this.queue.filter((id) => {
      const rec = this.store.get(id);
      return rec && this.now() - rec.createdAt > this.config.queueWaitMs;
    });
    if (stale.length === 0) return;
    for (const id of stale) {
      this.queue.splice(this.queue.indexOf(id), 1);
      const rec = this.store.get(id)!;
      this.setState(rec, 'failed', { reason: 'queue_timeout', finishedAt: this.now() });
    }
    this.announcePositions();
  }

  private removeExpired(): void {
    for (const id of this.store.expired(this.now())) {
      this.results.delete(id);
      this.store.delete(id);
      this.seqs.delete(id);
      this.sessions.delete(id);
    }
  }

  // ---- one run -------------------------------------------------------------------------------------

  /** Never throws: every outcome ends in a terminal state, and resources are released in `finally`. */
  private async execute(rec: RunRecord, slot: number, ctl: AbortController): Promise<void> {
    const id = rec.id;
    const sig = ctl.signal;
    const runDir = join(this.config.runsDir, id);
    let vmP: Promise<VmHandle> | null = null;
    let netTouched = false;
    let destroying = false;
    let vmDead = false;
    let held = null as string | null;
    let evidence = 0;
    let evidenceBytes = 0;
    let outcome: { state: 'done' | 'failed'; reason: FailReason | null; agentStatus: string | null } = {
      state: 'failed',
      reason: 'internal',
      agentStatus: null,
    };
    // A session lives for its own time, and the supervisor keeps a ceiling of its own that does not depend on the collector.
    const hardMs = rec.session ? this.config.bootTimeoutMs + rec.session.maxMs + this.config.sessionGraceMs : this.config.hardTimeoutMs;
    const hard = setTimeout(() => ctl.abort(new RunError('timeout', 'hard timeout')), hardMs);
    let vmForCommands: VmHandle | null = null;
    const sess = rec.session
      ? new SessionCommands({
          idleMs: rec.session.idleMs,
          commandMax: this.config.commandMax,
          commandTimeoutMs: this.config.commandTimeoutMs,
          approvalTtlMs: this.config.approvalTtlMs,
          now: this.now,
          send: (line) => {
            if (!vmForCommands) throw new Error('no VM');
            vmForCommands.send(line);
          },
          emit: (data) => {
            // the log gets ids, type, status and hash, never parameters (they may carry typed-in values)
            this.log('info', 'command', { run_id: id, command_id: data.command_id, cmd: data.cmd, status: data.status, command_sha256: data.command_sha256 });
            this.emit(id, 'command', JSON.stringify(data));
          },
          abort: (e) => ctl.abort(e),
        })
      : null;
    if (sess) this.sessions.set(id, sess);

    const flushHeld = () => {
      if (held !== null) {
        this.emit(id, 'evidence', held);
        evidence++;
        held = null;
      }
    };

    /**
     * Collector lines that drive the session. They are evidence like any other (already published); here they only
     * move the command state, and only in the shapes the collector produces (spec 005, 3.5).
     */
    const controlLine = (line: string) => {
      if (!sess || line.length > CONTROL_LINE_MAX) return;
      if (!line.includes('"session_ready"') && !line.includes('"cmd_result"')) return;
      let o: { type?: unknown; kind?: unknown; id?: unknown; ok?: unknown; error?: unknown };
      try {
        o = JSON.parse(line) as typeof o;
      } catch {
        return;
      }
      if (typeof o !== 'object' || o === null || o.type !== 'evidence') return;
      if (o.kind === 'session_ready') {
        if (sess.markReady()) this.setState(this.store.get(id) ?? rec, 'session', {});
      } else if (o.kind === 'cmd_result' && typeof o.id === 'string' && typeof o.ok === 'boolean') {
        // the error code comes from the guest: only a short lowercase token is passed on
        sess.onResult(o.id, o.ok, typeof o.error === 'string' && /^[a-z0-9_]{1,40}$/.test(o.error) ? o.error : undefined);
      }
    };

    try {
      this.setState(rec, 'preparing', { slot, startedAt: this.now() });

      await raceAbort(this.backend.prepareDisk(runDir).catch((e) => Promise.reject(asRunError(e, 'disk_copy'))), sig);

      netTouched = true;
      await raceAbort(this.backend.netUp(slot, id).catch((e) => Promise.reject(asRunError(e, 'net_setup'))), sig);

      this.setState(rec, 'booting', {});
      vmP = this.backend.start({ runId: id, runDir, slot, vcpu: this.config.vcpu, memMib: this.config.memMib });
      vmP.catch(() => {});
      const vm = await raceAbort<VmHandle>(vmP.catch((e) => Promise.reject(asRunError(e, 'fc_api'))), sig);
      void vm.exited.then(() => {
        vmDead = true;
        // while we are shutting down, a dying VM is our own doing (or systemd's), not a crash
        if (!destroying) ctl.abort(this.draining ? new RunError('supervisor_restart') : new RunError('fc_crashed', 'firecracker exited'));
      });
      await raceAbort(vm.waitReady(this.config.bootTimeoutMs, sig), sig);
      vmForCommands = vm;

      this.setState(rec, 'running', {});
      // The guest gets only the total time. Idle time belongs to the supervisor (it alone knows when a human is
      // deciding about a risky command), which sends a normal close when the session has been idle for too long.
      const job = JSON.stringify({
        schema: 1,
        run_id: id,
        kind: 'url',
        url: rec.url,
        ...(rec.session ? { session: { max_s: Math.max(1, Math.ceil(rec.session.maxMs / 1000)) } } : {}),
      });
      await raceAbort(
        vm.runJob(
          job,
          (line) => {
            evidenceBytes += Buffer.byteLength(line) + 1;
            if (evidenceBytes > this.config.maxEvidenceBytes) {
              ctl.abort(new RunError('oversize', 'evidence cap exceeded'));
              return;
            }
            flushHeld();
            // Only a line that looks like a status line is held back, until the next line shows whether it was the
            // last one. Everything else is published at once, so a session's evidence is live, not one line late.
            if (line.length <= STATUS_LINE_MAX && parseStatus(line) !== null) {
              held = line;
              return;
            }
            this.emit(id, 'evidence', line);
            evidence++;
            controlLine(line);
          },
          sig,
        ),
        sig,
      );

      // only the LAST line decides: a "status" line forged by the collector earlier in the stream is plain evidence
      const status = parseStatus(held);
      if (status) {
        this.emit(id, 'status', held!);
        held = null;
      } else {
        flushHeld();
      }
      if (!status) {
        // the stream ended without a status: either the VM died (its exit may be a moment behind) or the agent misbehaved
        if (!vmDead) await Promise.race([vm.exited, new Promise((r) => setTimeout(r, 300))]);
        outcome = { state: 'failed', reason: vmDead ? 'fc_crashed' : 'agent_error', agentStatus: null };
      } else if (status === 'ok') {
        outcome = { state: 'done', reason: null, agentStatus: status };
      } else {
        outcome = { state: 'failed', reason: AGENT_STATUS_REASON[status] ?? 'agent_error', agentStatus: status };
      }
    } catch (e) {
      const err = sig.aborted ? asRunError(sig.reason, 'internal') : asRunError(e, 'internal');
      outcome = { state: 'failed', reason: err.reason, agentStatus: null };
      this.log(err.reason === 'internal' ? 'error' : 'warn', 'run failed', { run_id: id, reason: err.reason, detail: err.message.slice(0, 200) });
      flushHeld();
    } finally {
      clearTimeout(hard);
      destroying = true;
      sess?.end(); // open commands are voided and published before the run leaves the session
      this.setState(this.store.get(id) ?? rec, 'destroying', {});
      try {
        if (vmP) await (await vmP.catch(() => null))?.stop();
      } catch (e) {
        this.log('error', 'stop failed', { run_id: id, detail: String(e).slice(0, 200) });
      }
      if (netTouched) {
        try {
          await this.backend.netDown(slot, id);
        } catch (e) {
          this.log('error', 'netDown failed', { run_id: id, slot, detail: String(e).slice(0, 200) });
        }
      }
      try {
        await this.backend.removeRunDir(runDir);
      } catch (e) {
        this.log('error', 'removeRunDir failed', { run_id: id, detail: String(e).slice(0, 200) });
      }
      this.pool.release(slot);
      if (rec.session) this.sessionRuns--;
      this.active.delete(id);
      this.setState(this.store.get(id) ?? rec, outcome.state, {
        reason: outcome.reason,
        agentStatus: outcome.agentStatus,
        partial: outcome.state === 'failed' && evidence > 0,
        finishedAt: this.now(),
        events: this.seqs.get(id) ?? 0,
      });
      this.log('info', 'run finished', { run_id: id, state: outcome.state, reason: outcome.reason });
      this.pump();
    }
  }

  // ---- state and events ----------------------------------------------------------------------------

  private setState(rec: RunRecord, state: RunState, patch: Partial<RunRecord>): void {
    this.store.update(rec.id, { ...patch, state });
    this.emit(rec.id, 'state', this.stateData(this.store.get(rec.id)!));
  }

  private stateData(rec: RunRecord): string {
    const data: Record<string, unknown> = { state: rec.state };
    if (rec.reason) data.reason = rec.reason;
    const pos = this.positionOf(rec.id);
    if (rec.state === 'queued' && pos !== null) data.position = pos;
    if (rec.agentStatus) data.agent_status = rec.agentStatus;
    if (rec.partial) data.partial = true;
    return JSON.stringify(data);
  }

  private emit(id: string, type: RunEvent['type'], data: string): void {
    let seq = this.seqs.get(id);
    if (seq === undefined) seq = this.results.lastSeq(id);
    seq += 1;
    this.seqs.set(id, seq);
    const ev: RunEvent = { seq, type, data };
    this.results.append(id, ev);
    const set = this.listeners.get(id);
    if (set) for (const l of [...set]) l(ev);
  }

  private view(rec: RunRecord): RunView {
    const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
    return {
      run_id: rec.id,
      state: rec.state,
      reason: rec.reason,
      position: rec.state === 'queued' ? this.positionOf(rec.id) : null,
      created_at: new Date(rec.createdAt).toISOString(),
      started_at: iso(rec.startedAt),
      finished_at: iso(rec.finishedAt),
      agent_status: rec.agentStatus,
      partial: rec.partial,
      events: this.seqs.get(rec.id) ?? rec.events,
      expires_at: new Date(rec.expiresAt).toISOString(),
      ...(rec.session
        ? {
            session: { idle_s: Math.round(rec.session.idleMs / 1000), max_s: Math.round(rec.session.maxMs / 1000) },
            ...(this.sessions.has(rec.id) ? { commands: this.sessions.get(rec.id)!.counts() } : {}),
          }
        : {}),
    };
  }

  /** After a restart the commands of a dead session can no longer run: say so in its event log. */
  private voidDanglingCommands(id: string): void {
    const last = new Map<string, Record<string, unknown>>();
    for (const ev of this.results.read(id)) {
      if (ev.type !== 'command') continue;
      try {
        const d = JSON.parse(ev.data) as Record<string, unknown>;
        if (typeof d.command_id === 'string') last.set(d.command_id, d);
      } catch {
        /* a damaged line carries nothing to void */
      }
    }
    for (const d of last.values()) {
      if (!isOpenStatus(String(d.status))) continue;
      this.emit(id, 'command', JSON.stringify({ command_id: d.command_id, cmd: d.cmd, status: 'voided', risk: d.risk, command_sha256: d.command_sha256 }));
    }
  }
}

function parseStatus(line: string | null): string | null {
  if (line === null) return null;
  try {
    const o = JSON.parse(line) as { type?: unknown; status?: unknown };
    return o && o.type === 'status' && typeof o.status === 'string' ? o.status : null;
  } catch {
    return null;
  }
}
