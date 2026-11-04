import { DatabaseSync } from 'node:sqlite';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { FailReason, RunEvent, RunRecord, RunState, SessionLimits } from './types.ts';

export const RUN_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function assertRunId(id: string): void {
  if (!RUN_ID_RE.test(id)) throw new Error('invalid run id');
}

interface Row {
  id: string;
  url: string;
  state: RunState;
  reason: FailReason | null;
  slot: number | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  agentStatus: string | null;
  partial: number;
  events: number;
  expiresAt: number;
  sessionIdleMs: number | null;
  sessionMaxMs: number | null;
}

const COLUMNS = `id, url, state, reason, slot, created_at AS createdAt, started_at AS startedAt,
  finished_at AS finishedAt, agent_status AS agentStatus, partial, events, expires_at AS expiresAt,
  session_idle_ms AS sessionIdleMs, session_max_ms AS sessionMaxMs`;

const PATCHABLE: Record<string, string> = {
  state: 'state',
  reason: 'reason',
  slot: 'slot',
  startedAt: 'started_at',
  finishedAt: 'finished_at',
  agentStatus: 'agent_status',
  partial: 'partial',
  events: 'events',
};

export type RunPatch = Partial<Pick<RunRecord, 'state' | 'reason' | 'slot' | 'startedAt' | 'finishedAt' | 'agentStatus' | 'partial' | 'events'>>;

function toRecord(r: Row): RunRecord {
  const { sessionIdleMs, sessionMaxMs, ...rest } = r;
  const session = sessionIdleMs !== null && sessionMaxMs !== null ? { idleMs: sessionIdleMs, maxMs: sessionMaxMs } : null;
  return { ...rest, partial: r.partial === 1, session };
}

export class Store {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        url TEXT NOT NULL,
        state TEXT NOT NULL,
        reason TEXT,
        slot INTEGER,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        finished_at INTEGER,
        agent_status TEXT,
        partial INTEGER NOT NULL DEFAULT 0,
        events INTEGER NOT NULL DEFAULT 0,
        expires_at INTEGER NOT NULL,
        schema_version INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS runs_state ON runs (state, created_at);
      CREATE INDEX IF NOT EXISTS runs_expires ON runs (expires_at);
    `);
    // databases created before sessions existed lack the limit columns
    const have = new Set((this.db.prepare('PRAGMA table_info(runs)').all() as unknown as { name: string }[]).map((c) => c.name));
    for (const col of ['session_idle_ms', 'session_max_ms']) {
      if (!have.has(col)) this.db.exec(`ALTER TABLE runs ADD COLUMN ${col} INTEGER`);
    }
  }

  insert(id: string, url: string, createdAt: number, expiresAt: number, session: SessionLimits | null = null): void {
    this.db
      .prepare('INSERT INTO runs (id, url, state, created_at, expires_at, session_idle_ms, session_max_ms) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, url, 'queued', createdAt, expiresAt, session?.idleMs ?? null, session?.maxMs ?? null);
  }

  get(id: string): RunRecord | undefined {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM runs WHERE id = ?`).get(id) as Row | undefined;
    return row ? toRecord(row) : undefined;
  }

  update(id: string, patch: RunPatch): void {
    const sets: string[] = [];
    const values: (string | number | null)[] = [];
    for (const [key, value] of Object.entries(patch)) {
      const col = PATCHABLE[key];
      if (!col) throw new Error(`unknown column ${key}`);
      sets.push(`${col} = ?`);
      values.push(typeof value === 'boolean' ? (value ? 1 : 0) : ((value as string | number | null | undefined) ?? null));
    }
    if (sets.length === 0) return;
    this.db.prepare(`UPDATE runs SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
  }

  /** Queued runs in arrival order. */
  queued(): RunRecord[] {
    const rows = this.db.prepare(`SELECT ${COLUMNS} FROM runs WHERE state = 'queued' ORDER BY created_at, rowid`).all() as unknown as Row[];
    return rows.map(toRecord);
  }

  /** Runs that were in flight when the process died. */
  inFlight(): RunRecord[] {
    const rows = this.db
      .prepare(`SELECT ${COLUMNS} FROM runs WHERE state IN ('preparing', 'booting', 'running', 'session', 'destroying') ORDER BY created_at`)
      .all() as unknown as Row[];
    return rows.map(toRecord);
  }

  expired(now: number): string[] {
    const rows = this.db.prepare("SELECT id FROM runs WHERE expires_at <= ? AND state IN ('done', 'failed')").all(now) as unknown as { id: string }[];
    return rows.map((r) => r.id);
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM runs WHERE id = ?').run(id);
  }

  close(): void {
    this.db.close();
  }
}

/** Per-run event log: one JSON envelope per line. Evidence lines are stored as opaque strings, never parsed here. */
export class ResultFiles {
  private dir: string;

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  private path(id: string): string {
    assertRunId(id);
    return join(this.dir, `${id}.ndjson`);
  }

  append(id: string, ev: RunEvent): void {
    appendFileSync(this.path(id), JSON.stringify(ev) + '\n', { mode: 0o600 });
  }

  read(id: string, afterSeq = 0): RunEvent[] {
    const p = this.path(id);
    if (!existsSync(p)) return [];
    const out: RunEvent[] = [];
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      if (!line) continue;
      const ev = JSON.parse(line) as RunEvent;
      if (ev.seq > afterSeq) out.push(ev);
    }
    return out;
  }

  lastSeq(id: string): number {
    const evs = this.read(id);
    return evs.length ? evs[evs.length - 1]!.seq : 0;
  }

  delete(id: string): void {
    rmSync(this.path(id), { force: true });
  }
}
