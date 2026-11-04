// The real hooks thread without the warm-up: the control for the test of what the warm-up buys.
import { parentPort } from 'node:worker_threads';
import { createHooks } from '../../hooks.ts';

const hooks = createHooks();
const port = parentPort!;
port.postMessage({ ready: true });
port.on('message', (m: { id: number; event: unknown }) => {
  const result = hooks.inspect(m.event);
  port.postMessage({ id: m.id, result, state: hooks.state() });
});
