import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Config } from './config.ts';
import { nullLogger, urlInfo } from './logger.ts';
import type { Logger } from './logger.ts';
import { SlotPool } from './slots.ts';
import { ResultFiles, Store } from './store.ts';
import { RunError, isTerminal } from './types.ts';
import type { Backend, FailReason, RunEvent, RunRecord, RunState, VmHandle } from './types.ts';

export class QueueFullError extends Error {}
export class DrainingError extends Error {}
export class LowDiskError extends Error {}

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

  submit(url: string): { run_id: string; state: RunState; position: number | null } {
    if (this.draining) throw new DrainingError('shutting down');
    if (this.freeGb() < this.config.minFreeGb) throw new LowDiskError('not enough free disk space');
    if (this.queue.length >= this.config.queueMax) throw new QueueFullError('queue is full');

    const id = randomUUID();
    const created = this.now();
    this.store.insert(id, url, created, created + this.config.resultTtlMs);
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
      version: '0.1.0',
      concurrency: this.config.concurrency,
      running: this.active.size,
      queued: this.queue.length,
      free_gb: Number.isFinite(this.freeGb()) ? Math.floor(this.freeGb()) : null,
      image_sha256: this.imageSha256(),
    };
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
      const id = this.queue.shift()!;
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
      const done = this.execute(rec, slot, ctl);
      this.active.set(id, { ctl, done });
    }
    if (moved) this.announcePositions();
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
    const hard = setTimeout(() => ctl.abort(new RunError('timeout', 'hard timeout')), this.config.hardTimeoutMs);

    const flushHeld = () => {
      if (held !== null) {
        this.emit(id, 'evidence', held);
        evidence++;
        held = null;
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

      this.setState(rec, 'running', {});
      const job = JSON.stringify({ schema: 1, run_id: id, kind: 'url', url: rec.url });
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
            held = line;
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
    };
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
