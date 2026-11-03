export type RunState = 'queued' | 'preparing' | 'booting' | 'running' | 'destroying' | 'done' | 'failed';

export type FailReason =
  | 'queue_timeout'
  | 'cancelled'
  | 'net_setup'
  | 'disk_copy'
  | 'fc_api'
  | 'fc_crashed'
  | 'boot_timeout'
  | 'timeout'
  | 'oversize'
  | 'collector_failed'
  | 'agent_error'
  | 'supervisor_restart'
  | 'internal';

export function isTerminal(state: RunState): boolean {
  return state === 'done' || state === 'failed';
}

export class RunError extends Error {
  reason: FailReason;
  constructor(reason: FailReason, message?: string) {
    super(message ?? reason);
    this.name = 'RunError';
    this.reason = reason;
  }
}

export interface RunRecord {
  id: string;
  url: string;
  state: RunState;
  reason: FailReason | null;
  slot: number | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  agentStatus: string | null;
  partial: boolean;
  events: number;
  expiresAt: number;
}

/** A stored event. `data` is a single-line string: JSON for state/status, the raw guest line for evidence. */
export interface RunEvent {
  seq: number;
  type: 'state' | 'evidence' | 'status';
  data: string;
}

export interface StartOptions {
  runId: string;
  runDir: string;
  slot: number;
  vcpu: number;
  memMib: number;
}

/** One running microVM. All methods are safe to call after the VM has died. */
export interface VmHandle {
  /** Resolves when the guest agent accepts connections; rejects with boot_timeout or fc_crashed. */
  waitReady(timeoutMs: number, signal: AbortSignal): Promise<void>;
  /** Sends the job line and streams guest lines until the connection closes. Never half-closes. */
  runJob(job: string, onLine: (line: string) => void, signal: AbortSignal): Promise<void>;
  /** Resolves when the Firecracker process is gone, for any reason. */
  readonly exited: Promise<void>;
  /** SIGTERM, then SIGKILL after a short grace; resolves when the process is gone. */
  stop(): Promise<void>;
  /** Last bytes of the VM console (diagnostics only, untrusted). */
  console(): string;
}

/** Everything the supervisor core needs from the host. The real one is backend.ts, tests use a fake. */
export interface Backend {
  prepareDisk(runDir: string): Promise<void>;
  netUp(slot: number, runId: string): Promise<void>;
  /** Idempotent. Called for every slot that netUp was attempted on, whatever happened since. */
  netDown(slot: number, runId: string): Promise<void>;
  start(opts: StartOptions): Promise<VmHandle>;
  removeRunDir(runDir: string): Promise<void>;
  /** Startup recovery: kill stray Firecracker processes, zsnet down for all slots, remove leftover run dirs. */
  recoverHost(): Promise<void>;
}
