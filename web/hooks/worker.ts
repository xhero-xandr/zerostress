// The thread that runs the hooks for guarded.ts. It keeps the task's state (sticky mode, summed weak signals); the
// main thread only sends events and waits, with a deadline.

import { parentPort } from 'node:worker_threads';
import { createHooks, scanText, warmUp } from './hooks.ts';

const hooks = createHooks();
const port = parentPort;
if (!port) throw new Error('worker.ts must run as a worker thread');

warmUp();
port.postMessage({ ready: true });
port.on('message', (m: { id: number; event?: unknown; scan?: { place: string; text: string } }) => {
  if (m.scan) {
    // a text of ours: scanned on its own, the task's state is not touched
    const r = scanText(m.scan.place, m.scan.text);
    port.postMessage({ id: m.id, scanned: { triggered: r.triggered, findings: r.findings } });
    return;
  }
  const result = hooks.inspect(m.event);
  port.postMessage({ id: m.id, result, state: hooks.state() });
});
