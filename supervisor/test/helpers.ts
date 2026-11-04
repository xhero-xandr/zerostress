import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { createApi } from '../src/api.ts';
import { loadConfig } from '../src/config.ts';
import type { Config } from '../src/config.ts';
import type { Logger } from '../src/logger.ts';
import { Supervisor } from '../src/supervisor.ts';
import type { Deps } from '../src/supervisor.ts';
import { ResultFiles, Store } from '../src/store.ts';
import { RunError } from '../src/types.ts';
import type { Backend, RunEvent, StartOptions, VmHandle } from '../src/types.ts';

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function waitFor<T>(fn: () => T | undefined | false | null, ms = 3000, step = 5): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('waitFor timed out');
    await sleep(step);
  }
}

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'sup-'));
}

export function makeConfig(dir: string, over: Partial<Config> = {}): Config {
  return {
    ...loadConfig({ SUP_STATE_DIR: dir, SUP_IMAGE_DIR: join(dir, 'images'), SUP_SOCKET: join(dir, 'sup.sock') }),
    bootTimeoutMs: 150,
    hardTimeoutMs: 1000,
    queueWaitMs: 5000,
    shutdownGraceMs: 150,
    keepaliveMs: 50,
    ...over,
  };
}

// ---- fake host -----------------------------------------------------------------------------------

export interface Script {
  prepareDisk?: 'fail';
  netUp?: 'fail';
  start?: 'fail';
  ready?: 'timeout' | 'crash';
  lines?: string[];
  lineDelayMs?: number;
  hang?: boolean;
  /** The VM dies right before this line (index) is delivered. */
  crashAtLine?: number;
  /** Session scripts: called for every command line the supervisor sends. Default: answer with cmd_result, end the stream on close. */
  onCommand?: (cmd: Record<string, unknown>, vm: FakeVm) => void;
  /** Session scripts: never answer commands (the supervisor's command timeout must fire). */
  silent?: boolean;
  /** Session scripts: writing a command to the guest fails. */
  sendFails?: boolean;
  replyDelayMs?: number;
}

export const OK_STATUS = '{"type":"status","status":"ok","exit_code":0,"duration_ms":5}';
export const status = (s: string) => `{"type":"status","status":"${s}","duration_ms":5}`;
export const SESSION_READY = '{"type":"evidence","v":1,"kind":"session_ready"}';
export const cmdResult = (id: string, ok = true, error?: string) =>
  JSON.stringify({ type: 'evidence', v: 1, kind: 'cmd_result', id, ok, ...(error ? { error } : {}) });

export class FakeVm implements VmHandle {
  exited: Promise<void>;
  /** Lines the supervisor wrote after the job (session commands). */
  sent: string[] = [];
  private onLine: ((line: string) => void) | null = null;
  private endStream: (() => void) | null = null;
  private kill!: () => void;
  private dead = false;
  private script: Script;
  private backend: FakeBackend;
  job = '';

  constructor(backend: FakeBackend, script: Script) {
    this.backend = backend;
    this.script = script;
    this.exited = new Promise<void>((r) => (this.kill = () => {
      this.dead = true;
      r();
    }));
  }

  async waitReady(timeoutMs: number, signal: AbortSignal): Promise<void> {
    if (this.script.ready === 'crash') {
      this.kill();
      throw new RunError('fc_crashed', 'died during boot');
    }
    if (this.script.ready === 'timeout') {
      await new Promise<void>((r) => {
        const t = setTimeout(r, timeoutMs);
        signal.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true });
      });
      throw new RunError('boot_timeout', 'agent not ready');
    }
    await sleep(1);
  }

  /** Guest -> supervisor line, as if the collector had printed it. */
  push(line: string): void {
    this.onLine?.(line);
  }

  /** The collector exits: last line (default: ok status), then the connection closes. */
  finish(statusLine = OK_STATUS): void {
    this.push(statusLine);
    this.endStream?.();
  }

  send(line: string): void {
    if (this.script.sendFails) throw new Error('socket closed');
    if (!this.onLine || this.dead) throw new Error('no open agent connection');
    this.sent.push(line);
    const cmd = JSON.parse(line) as Record<string, unknown>;
    if (this.script.onCommand) return this.script.onCommand(cmd, this);
    if (this.script.silent) return;
    setTimeout(() => {
      if (this.dead) return;
      this.push(cmdResult(String(cmd.id)));
      if (cmd.cmd === 'close') this.finish();
    }, this.script.replyDelayMs ?? 2);
  }

  async runJob(job: string, onLine: (l: string) => void, signal: AbortSignal): Promise<void> {
    this.job = job;
    this.onLine = onLine;
    const lines = this.script.lines ?? [];
    for (let i = 0; i < lines.length; i++) {
      if (signal.aborted || this.dead) return;
      await sleep(this.script.lineDelayMs ?? 0);
      if (this.script.crashAtLine === i) {
        this.kill();
        return;
      }
      onLine(lines[i]!);
    }
    if (this.script.hang) {
      await new Promise<void>((r) => {
        this.endStream = r;
        signal.addEventListener('abort', () => r(), { once: true });
        void this.exited.then(r);
      });
    }
    this.onLine = null;
  }

  async stop(): Promise<void> {
    this.kill();
    this.backend.vms.delete(this);
  }

  console(): string {
    return '';
  }
}

export class FakeBackend implements Backend {
  scriptFor: (runId: string) => Script;
  calls: string[] = [];
  slotsUp = new Set<number>();
  dirs = new Set<string>();
  vms = new Set<FakeVm>();
  vmByRun = new Map<string, FakeVm>();
  maxVms = 0;
  started: string[] = [];
  lastJob = '';
  recovered = 0;

  constructor(scriptFor: (runId: string) => Script) {
    this.scriptFor = scriptFor;
  }

  async prepareDisk(runDir: string): Promise<void> {
    this.calls.push('prepareDisk');
    if (this.scriptFor(basename(runDir)).prepareDisk === 'fail') throw new Error('copy failed');
    this.dirs.add(runDir);
  }

  async netUp(slot: number, runId: string): Promise<void> {
    this.calls.push('netUp');
    if (this.slotsUp.has(slot)) throw new Error(`slot ${slot} is already in use`);
    this.slotsUp.add(slot);
    if (this.scriptFor(runId).netUp === 'fail') throw new Error('zsnet failed');
  }

  async netDown(slot: number): Promise<void> {
    this.calls.push('netDown');
    this.slotsUp.delete(slot);
  }

  async start(opts: StartOptions): Promise<VmHandle> {
    this.calls.push('start');
    const script = this.scriptFor(opts.runId);
    if (script.start === 'fail') throw new RunError('fc_api', 'PUT /boot-source returned 400');
    const vm = new FakeVm(this, script);
    this.vms.add(vm);
    this.vmByRun.set(opts.runId, vm);
    this.maxVms = Math.max(this.maxVms, this.vms.size);
    this.started.push(opts.runId);
    const origRun = vm.runJob.bind(vm);
    vm.runJob = async (job, onLine, signal) => {
      this.lastJob = job;
      return origRun(job, onLine, signal);
    };
    return vm;
  }

  async removeRunDir(runDir: string): Promise<void> {
    this.calls.push('removeRunDir');
    this.dirs.delete(runDir);
  }

  async recoverHost(): Promise<void> {
    this.recovered++;
  }

  /** Nothing may be left behind once the supervisor is idle. */
  assertClean(): void {
    if (this.slotsUp.size || this.dirs.size || this.vms.size) {
      throw new Error(`leak: slots=${[...this.slotsUp]} dirs=${[...this.dirs]} vms=${this.vms.size}`);
    }
  }
}

export interface Harness {
  sup: Supervisor;
  store: Store;
  results: ResultFiles;
  backend: FakeBackend;
  config: Config;
  dir: string;
  logs: string[];
}

export function harness(scripts: Record<string, Script>, over: Partial<Config> = {}, extra: Partial<Deps> = {}, dir = tempDir()): Harness {
  const config = makeConfig(dir, over);
  const store = new Store(join(dir, 'supervisor.db'));
  const results = new ResultFiles(config.resultsDir);
  const backend = new FakeBackend((id) => {
    const url = store.get(id)?.url ?? '';
    const path = url ? new URL(url).pathname : '';
    return scripts[path] ?? scripts['*'] ?? {};
  });
  const logs: string[] = [];
  const log: Logger = (level, msg, fields) => logs.push(JSON.stringify({ level, msg, ...fields }));
  const sup = new Supervisor({ config, store, results, backend, log, sweepMs: 20, ...extra });
  return { sup, store, results, backend, config, dir, logs };
}

export const URL_OF = (path: string) => `https://example.test${path}`;

/** Starts the supervisor and an HTTP server on a loopback port; always tears both down, even when an assertion fails. */
export async function withApi(h: Harness, fn: (base: string) => Promise<void>): Promise<void> {
  await h.sup.start();
  const server = createApi(h.sup, h.config);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    await h.sup.shutdown();
    server.closeAllConnections();
    server.close();
  }
}

export async function sse(url: string, headers: Record<string, string> = {}): Promise<{ id: number; event: string; data: string }[]> {
  const res = await fetch(url, { headers });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
  const text = await res.text(); // the server ends the stream on a terminal state
  return text
    .split('\n\n')
    .filter((f) => f.startsWith('id:'))
    .map((f) => {
      const m = /^id: (\d+)\nevent: (\w+)\ndata: (.*)$/s.exec(f)!;
      return { id: Number(m[1]), event: m[2]!, data: m[3]! };
    });
}

export async function finished(h: Harness, id: string, ms = 3000) {
  return waitFor(() => {
    const v = h.sup.get(id);
    return v && (v.state === 'done' || v.state === 'failed') ? v : undefined;
  }, ms);
}

export function eventsOf(h: Harness, id: string): RunEvent[] {
  return h.results.read(id);
}

export function statesOf(h: Harness, id: string): string[] {
  return eventsOf(h, id)
    .filter((e) => e.type === 'state')
    .map((e) => (JSON.parse(e.data) as { state: string }).state);
}
