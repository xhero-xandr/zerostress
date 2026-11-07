// The tasks the service knows about (spec 007, 3.2, 3.7): in memory while they run, on disk once they are finished, for a
// day. A task has a public id (it opens the report) and a secret key (it lets its owner decide and cancel). Only the hash
// of the key is kept.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TaskResult } from '../agent/runner.ts';

export type Stage = 'queued' | 'starting' | 'opening' | 'analysing' | 'done' | 'failed';

export interface TaskEvent {
  seq: number;
  type: 'stage' | 'approval' | 'final' | 'log';
  data: string;
}

export interface Task {
  id: string;
  keyHash: string;
  createdAt: number;
  /** the address after the gate; shown only as text */
  url: string;
  stage: Stage;
  position: number | null;
  /** the supervisor's run, for the screenshot and the decisions */
  runId: string | null;
  deep: boolean;
  result: TaskResult | null;
  /** risky commands waiting for the owner while the run is live; empty once the run has ended */
  pending: Array<{ command_id: string; cmd: string; sha256: string }>;
  events: TaskEvent[];
  listeners: Set<(e: TaskEvent) => void>;
  cancel: (() => void) | null;
}

export interface Store {
  create(url: string, deep: boolean): { task: Task; key: string };
  get(id: string): Task | undefined;
  /** forget a task that never started */
  drop(id: string): void;
  keyOk(task: Task, key: unknown): boolean;
  emit(task: Task, type: TaskEvent['type'], data: unknown): void;
  save(task: Task): void;
  sweep(): number;
}

const ID = /^[0-9a-f]{32}$/;
const hashKey = (k: string) => createHash('sha256').update(k).digest('hex');

export function createStore(dir: string | null, ttlMs = 24 * 3_600_000, now: () => number = Date.now): Store {
  const tasks = new Map<string, Task>();
  if (dir) mkdirSync(dir, { recursive: true, mode: 0o700 });

  const fresh = (id: string, keyHash: string, url: string, deep: boolean): Task => ({
    id, keyHash, createdAt: now(), url, stage: 'queued', position: null, runId: null, deep, result: null, pending: [], events: [], listeners: new Set(), cancel: null,
  });

  // finished tasks survive a restart
  if (dir) {
    for (const name of readdirSync(dir)) {
      if (!/^[0-9a-f]{32}\.json$/.test(name)) continue;
      try {
        const raw = JSON.parse(readFileSync(join(dir, name), 'utf8')) as Partial<Task>;
        if (typeof raw.id !== 'string' || !ID.test(raw.id) || typeof raw.keyHash !== 'string' || typeof raw.url !== 'string' || typeof raw.createdAt !== 'number' || !raw.result) continue;
        if (now() - raw.createdAt > ttlMs) { rmSync(join(dir, name), { force: true }); continue; }
        const t = fresh(raw.id, raw.keyHash, raw.url, raw.deep === true);
        t.createdAt = raw.createdAt;
        t.stage = raw.stage === 'failed' ? 'failed' : 'done';
        t.runId = typeof raw.runId === 'string' ? raw.runId : null;
        t.result = raw.result;
        tasks.set(t.id, t);
      } catch { /* a damaged file is skipped */ }
    }
  }

  return {
    create(url, deep) {
      const id = randomBytes(16).toString('hex');
      const key = randomBytes(32).toString('base64url');
      const task = fresh(id, hashKey(key), url, deep);
      tasks.set(id, task);
      return { task, key };
    },
    get: (id) => (ID.test(id) ? tasks.get(id) : undefined),
    drop: (id) => { tasks.delete(id); },
    keyOk(task, key) {
      if (typeof key !== 'string' || key.length < 20 || key.length > 100) return false;
      return timingSafeEqual(Buffer.from(hashKey(key)), Buffer.from(task.keyHash));
    },
    emit(task, type, data) {
      const e: TaskEvent = { seq: task.events.length + 1, type, data: JSON.stringify(data) };
      task.events.push(e);
      for (const l of task.listeners) {
        try { l(e); } catch { /* a closed stream */ }
      }
    },
    save(task) {
      if (!dir || !task.result) return;
      const { id, keyHash, createdAt, url, stage, runId, deep, result } = task;
      const tmp = join(dir, `${id}.tmp`);
      writeFileSync(tmp, JSON.stringify({ id, keyHash, createdAt, url, stage, runId, deep, result }), { mode: 0o600 });
      renameSync(tmp, join(dir, `${id}.json`));
    },
    sweep() {
      let n = 0;
      for (const [id, t] of tasks) {
        if (now() - t.createdAt <= ttlMs) continue;
        tasks.delete(id);
        n++;
        if (dir) rmSync(join(dir, `${id}.json`), { force: true });
      }
      if (dir) {
        for (const name of readdirSync(dir)) {
          if (name.endsWith('.tmp') && now() - statSync(join(dir, name)).mtimeMs > ttlMs) rmSync(join(dir, name), { force: true });
        }
      }
      return n;
    },
  };
}
