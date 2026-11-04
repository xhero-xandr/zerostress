import { canonicalJson, sameDigest, sha256Hex, validateCommand } from './commands.ts';
import type { Risk } from './commands.ts';
import { RunError } from './types.ts';

/**
 * The command side of one interactive session (spec 006, 3.7-3.8): validation, one-at-a-time execution, hash-bound
 * one-time approvals for risky commands, and the session clock. It knows nothing about VMs or HTTP; the supervisor
 * wires `send`, `emit` and `abort`. Everything a guest says can only move a command from `sent` to `done`/`error`,
 * and only for the command that is in flight.
 */

export type CommandStatus =
  | 'accepted'
  | 'awaiting_approval'
  | 'approved'
  | 'sent'
  | 'done'
  | 'error'
  | 'rejected'
  | 'expired'
  | 'voided'
  | 'timeout';

const OPEN: ReadonlySet<CommandStatus> = new Set(['accepted', 'awaiting_approval', 'approved', 'sent']);
export const isOpenStatus = (s: string): boolean => OPEN.has(s as CommandStatus);

interface Entry {
  id: string;
  cmd: string;
  risk: Risk;
  canonical: string;
  sha256: string;
  status: CommandStatus;
  by: 'client' | 'supervisor';
  expiresAt: number | null;
  timer: NodeJS.Timeout | null;
}

export interface SessionOptions {
  idleMs: number;
  commandMax: number;
  commandTimeoutMs: number;
  approvalTtlMs: number;
  now: () => number;
  /** Writes one line to the guest. May throw. */
  send: (line: string) => void;
  /** Stores and publishes a `command` event (one JSON object per call). */
  emit: (data: Record<string, unknown>) => void;
  /** Ends the whole run with this reason. */
  abort: (e: RunError) => void;
}

export type SubmitResult =
  | { ok: true; command_id: string; status: CommandStatus; command_sha256: string }
  | { ok: false; code: 'not_session' | 'bad_command' | 'duplicate_id' | 'limit'; error: string };
export type ApproveResult =
  | { ok: true }
  | { ok: false; code: 'not_session' | 'not_found' | 'not_waiting' | 'hash_mismatch' | 'expired'; error: string };
export type RejectResult = { ok: true } | { ok: false; code: 'not_found' | 'too_late'; error: string };

type State = 'starting' | 'ready' | 'closing' | 'ended';

export class SessionCommands {
  private o: SessionOptions;
  private state: State = 'starting';
  private entries = new Map<string, Entry>();
  private queue: string[] = [];
  private inflight: Entry | null = null;
  private cmdTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private userTotal = 0;

  constructor(options: SessionOptions) {
    this.o = options;
  }

  get phase(): State {
    return this.state;
  }

  counts(): { total: number; awaiting_approval: number } {
    let awaiting = 0;
    for (const e of this.entries.values()) if (e.status === 'awaiting_approval') awaiting++;
    return { total: this.userTotal, awaiting_approval: awaiting };
  }

  /** The collector said `session_ready`. True only the first time. */
  markReady(): boolean {
    if (this.state !== 'starting') return false;
    this.state = 'ready';
    this.refreshIdle();
    return true;
  }

  submit(raw: unknown): SubmitResult {
    if (this.state !== 'ready') return { ok: false, code: 'not_session', error: 'the run is not in a session that accepts commands' };
    const v = validateCommand(raw);
    if (!v.ok) return { ok: false, code: 'bad_command', error: v.error };
    const c = v.command;
    if (this.entries.has(c.id)) return { ok: false, code: 'duplicate_id', error: 'a command with this id already exists in the run' };
    if (this.userTotal >= this.o.commandMax) return { ok: false, code: 'limit', error: 'too many commands in this run' };

    this.userTotal++;
    const e: Entry = { ...c, status: 'accepted', by: 'client', expiresAt: null, timer: null };
    this.entries.set(e.id, e);
    this.publish(e, { command: JSON.parse(e.canonical) as unknown });
    if (e.risk === 'risky') {
      e.status = 'awaiting_approval';
      e.expiresAt = this.o.now() + this.o.approvalTtlMs;
      e.timer = setTimeout(() => this.expire(e), this.o.approvalTtlMs);
      e.timer.unref();
      this.publish(e);
    } else {
      this.queue.push(e.id);
    }
    this.refreshIdle();
    this.drain();
    return { ok: true, command_id: e.id, status: e.status === 'sent' ? 'accepted' : e.status, command_sha256: e.sha256 };
  }

  approve(commandId: string, sha256: unknown): ApproveResult {
    if (this.state !== 'ready') return { ok: false, code: 'not_session', error: 'the run is not in a session that accepts approvals' };
    const e = this.entries.get(commandId);
    if (!e) return { ok: false, code: 'not_found', error: 'no such command' };
    if (e.status === 'expired') return { ok: false, code: 'expired', error: 'the approval period has passed' };
    if (e.status !== 'awaiting_approval') return { ok: false, code: 'not_waiting', error: `the command is not waiting for approval (${e.status})` };
    if (e.expiresAt !== null && this.o.now() >= e.expiresAt) {
      this.expire(e);
      return { ok: false, code: 'expired', error: 'the approval period has passed' };
    }
    // the digest must be that of the exact command received; a wrong one leaves the command waiting
    if (!sameDigest(sha256, e.sha256)) return { ok: false, code: 'hash_mismatch', error: 'command_sha256 does not match the command' };
    this.clearEntryTimer(e);
    e.status = 'approved';
    this.publish(e);
    this.queue.push(e.id); // behind everything already queued, not at the place it was received
    this.drain();
    return { ok: true };
  }

  reject(commandId: string): RejectResult {
    const e = this.entries.get(commandId);
    if (!e) return { ok: false, code: 'not_found', error: 'no such command' };
    if (e.status !== 'awaiting_approval' && e.status !== 'accepted' && e.status !== 'approved') {
      return { ok: false, code: 'too_late', error: `the command can no longer be rejected (${e.status})` };
    }
    this.clearEntryTimer(e);
    const qi = this.queue.indexOf(e.id);
    if (qi >= 0) this.queue.splice(qi, 1);
    e.status = 'rejected';
    this.publish(e);
    this.refreshIdle();
    return { ok: true };
  }

  /** A `cmd_result` line from the guest. Only the command in flight can be answered; anything else is ignored. */
  onResult(commandId: string, ok: boolean, errorCode?: string): boolean {
    const e = this.inflight;
    if (this.state === 'ended' || !e || e.id !== commandId) return false;
    this.clearCmdTimer();
    this.inflight = null;
    e.status = ok ? 'done' : 'error';
    this.publish(e, ok ? {} : { error: errorCode ?? 'unknown' });
    this.drain();
    this.refreshIdle();
    return true;
  }

  /** The session is over (the collector exited or the run is being torn down): nothing can be sent any more. */
  end(): void {
    if (this.state === 'ended') return;
    this.state = 'ended';
    this.clearCmdTimer();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    for (const e of this.entries.values()) {
      this.clearEntryTimer(e);
      if (!OPEN.has(e.status)) continue;
      // a close that was sent has done its job once the collector is gone
      e.status = e.cmd === 'close' && e.status === 'sent' ? 'done' : 'voided';
      this.publish(e);
    }
    this.queue = [];
    this.inflight = null;
  }

  // ---- internals ---------------------------------------------------------------------------------------

  private publish(e: Entry, extra: Record<string, unknown> = {}): void {
    this.o.emit({
      command_id: e.id,
      cmd: e.cmd,
      status: e.status,
      risk: e.risk,
      command_sha256: e.sha256,
      ...(e.by === 'supervisor' ? { by: 'supervisor' } : {}),
      ...extra,
    });
  }

  private clearEntryTimer(e: Entry): void {
    if (e.timer) clearTimeout(e.timer);
    e.timer = null;
  }

  private clearCmdTimer(): void {
    if (this.cmdTimer) clearTimeout(this.cmdTimer);
    this.cmdTimer = null;
  }

  private expire(e: Entry): void {
    if (e.status !== 'awaiting_approval' || this.state === 'ended') return;
    this.clearEntryTimer(e);
    e.status = 'expired';
    this.publish(e);
    this.refreshIdle();
  }

  /** Sends the next queued command if none is in flight. One at a time, in order. */
  private drain(): void {
    if (this.state !== 'ready' || this.inflight) return;
    let e: Entry | undefined;
    while (this.queue.length > 0) {
      const next = this.entries.get(this.queue.shift()!);
      if (next && (next.status === 'accepted' || next.status === 'approved')) {
        e = next;
        break;
      }
    }
    if (!e) return;
    e.status = 'sent';
    this.inflight = e;
    if (e.cmd === 'close') this.state = 'closing';
    this.publish(e);
    this.clearIdle();
    this.cmdTimer = setTimeout(() => {
      if (this.inflight !== e) return;
      e.status = 'timeout';
      this.publish(e);
      this.inflight = null;
      this.o.abort(new RunError('timeout', 'the collector did not answer a command in time'));
    }, this.o.commandTimeoutMs);
    this.cmdTimer.unref();
    try {
      this.o.send(e.canonical);
    } catch (err) {
      this.clearCmdTimer();
      this.o.abort(new RunError('agent_error', `command could not be sent: ${err instanceof Error ? err.message : String(err)}`));
    }
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  /**
   * The idle clock runs only while nothing is queued, in flight or waiting for a human: time spent waiting for an
   * approval is not idle time (the total time limit still applies).
   */
  private refreshIdle(): void {
    this.clearIdle();
    if (this.state !== 'ready' || this.inflight || this.queue.length > 0) return;
    for (const e of this.entries.values()) if (e.status === 'awaiting_approval') return;
    this.idleTimer = setTimeout(() => this.idleExpired(), this.o.idleMs);
    this.idleTimer.unref();
  }

  /** Idle limit reached: the supervisor closes the session itself, with a normal close command. */
  private idleExpired(): void {
    this.idleTimer = null;
    if (this.state !== 'ready') return;
    let id = 'idle-close';
    while (this.entries.has(id)) id += '_';
    const canonical = canonicalJson({ cmd: 'close', id });
    const e: Entry = { id, cmd: 'close', risk: 'safe', canonical, sha256: sha256Hex(canonical), status: 'accepted', by: 'supervisor', expiresAt: null, timer: null };
    this.entries.set(id, e);
    this.publish(e);
    this.queue.push(id);
    this.drain();
  }
}
