// Hooks with a hard deadline (spec 009, 6). JavaScript cannot interrupt its own synchronous code, so a pattern that
// runs away on a hostile string would hold the whole web layer. Here the inspection runs in a worker thread: if it
// is late, dies or runs out of memory, the thread is killed and the event is withheld, the finding is recorded and the
// task goes to rules-only for good. A new thread serves the next event; what the old one had summed up is not needed
// any more, because the task has already fired.

import { Worker } from 'node:worker_threads';
import { makeFinding, makeState, withholdEvent, type HookState, type Inspected } from './hooks.ts';
import type { Finding } from './scan.ts';

export interface GuardedOptions {
  /** hard limit for one event, counted from the moment the thread is ready; default 2000 ms */
  timeoutMs?: number;
  /** limit for starting a thread; default 10000 ms */
  bootMs?: number;
  /** events larger than this (JSON) are withheld without being sent; default 4 MiB */
  maxEventBytes?: number;
  /** memory of the thread; default 256 MiB */
  maxMemoryMb?: number;
  /** tests substitute a misbehaving thread; production uses worker.ts */
  workerUrl?: URL;
}

export interface GuardedHooks {
  inspect(event: unknown): Promise<Inspected>;
  state(): HookState;
  /** stops the thread; the object must not be used afterwards */
  close(): Promise<void>;
}

const MAX_FINDINGS = 500;

export function createGuardedHooks(opts: GuardedOptions = {}): GuardedHooks {
  const timeoutMs = opts.timeoutMs ?? 2000;
  const bootMs = opts.bootMs ?? 10_000;
  const maxEventBytes = opts.maxEventBytes ?? 4 * 1024 * 1024;
  const maxMemoryMb = opts.maxMemoryMb ?? 256;
  const url = opts.workerUrl ?? new URL('./worker.ts', import.meta.url);

  interface Slot { w: Worker; ready: Promise<boolean> }
  let slot: Slot | null = null;
  let seq = 0;
  let closed = false;
  // what the worker last reported, and what only this side knows (timeouts, crashes, oversize events)
  let last: HookState = makeState(false, []);
  let forced = false;
  const forcedFindings: Finding[] = [];

  const force = (rule: string, place: string): Finding[] => {
    forced = true;
    const f = makeFinding(rule, place);
    if (forcedFindings.length < MAX_FINDINGS) forcedFindings.push(f);
    return [f];
  };

  // The thread says { ready: true } once it can take events, so its start-up time is not charged to the first event.
  const spawn = (): Slot => {
    const w = new Worker(url, { resourceLimits: { maxOldGenerationSizeMb: maxMemoryMb, maxYoungGenerationSizeMb: 32 } });
    w.unref();
    const ready = new Promise<boolean>((resolve) => {
      const done = (ok: boolean) => {
        clearTimeout(timer);
        w.off('message', onMsg);
        w.off('error', onFail);
        w.off('exit', onFail);
        resolve(ok);
      };
      const onMsg = (m: { ready?: boolean }) => { if (m && m.ready === true) done(true); };
      const onFail = () => done(false);
      const timer = setTimeout(() => done(false), bootMs);
      w.on('message', onMsg);
      w.once('error', onFail);
      w.once('exit', onFail);
    });
    return { w, ready };
  };

  async function run(event: unknown): Promise<Inspected> {
    const s = (slot ??= spawn());
    if (!(await s.ready)) {
      if (slot === s) slot = null;
      void s.w.terminate();
      return { event: withholdEvent(event), findings: force('hook_boot', 'event') };
    }
    const w = s.w;
    return new Promise((resolve) => {
      const id = ++seq;
      let done = false;
      const finish = (r: Inspected, kill: boolean) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        w.off('message', onMessage);
        w.off('error', onError);
        w.off('exit', onExit);
        if (kill) {
          if (slot?.w === w) slot = closed ? null : spawn(); // the replacement starts at once, so the next event finds it ready
          void w.terminate();
        }
        resolve(r);
      };
      const fail = (rule: string) => finish({ event: withholdEvent(event), findings: force(rule, 'event') }, true);
      const onMessage = (m: { id: number; result: Inspected; state: HookState }) => {
        if (m.id !== id) return;
        last = m.state;
        finish(m.result, false);
      };
      const onError = () => fail('hook_crash');
      const onExit = () => fail('hook_crash');
      const timer = setTimeout(() => fail('hook_timeout'), timeoutMs);
      w.on('message', onMessage);
      w.on('error', onError);
      w.on('exit', onExit);
      try {
        w.postMessage({ id, event });
      } catch {
        fail('hook_error'); // not cloneable: it cannot be inspected, so it does not go on
      }
    });
  }

  // The thread starts now, not with the first event: a task spends seconds booting its machine, and the thread boots
  // and warms up meanwhile.
  slot = spawn();

  // one event at a time: the thread is sequential anyway, and the state it keeps depends on the order
  let queue: Promise<unknown> = Promise.resolve();

  return {
    inspect(event) {
      if (closed) return Promise.resolve({ event: withholdEvent(event), findings: force('hook_closed', 'event') });
      let size = 0;
      try {
        size = JSON.stringify(event)?.length ?? 0;
      } catch {
        size = Infinity;
      }
      if (size > maxEventBytes) return Promise.resolve({ event: withholdEvent(event), findings: force('oversize', 'event') });
      const next = queue.then(() => run(event));
      queue = next.catch(() => undefined);
      return next;
    },
    state() {
      const findings = [...last.findings, ...forcedFindings].slice(0, MAX_FINDINGS);
      return makeState(last.triggered || forced, findings);
    },
    async close() {
      closed = true;
      const s = slot;
      slot = null;
      if (s) await s.w.terminate();
    },
  };
}
