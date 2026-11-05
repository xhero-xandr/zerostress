// A hooks thread that leaves a mark when it starts, for the test that the thread starts without waiting for an event.
import { appendFileSync } from 'node:fs';
import { parentPort } from 'node:worker_threads';
import { createHooks } from '../../hooks.ts';

appendFileSync(process.env.ZS_MARKER!, 'started\n');
const hooks = createHooks();
const port = parentPort!;
port.postMessage({ ready: true });
port.on('message', (m: { id: number; event: unknown }) => {
  port.postMessage({ id: m.id, result: hooks.inspect(m.event), state: hooks.state() });
});
