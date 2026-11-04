// A hooks thread that misbehaves on demand, for the tests of guarded.ts. Events with { mode } do what they say; the
// rest are handled by the real hooks.
import { writeFileSync } from 'node:fs';
import { parentPort } from 'node:worker_threads';
import { createHooks, warmUp } from '../../hooks.ts';

const hooks = createHooks();
const port = parentPort!;

warmUp();
port.postMessage({ ready: true });
port.on('message', (m: { id: number; event: { mode?: string } }) => {
  switch (m.event?.mode) {
    case 'hang':
      for (;;) { /* never returns */ }
    case 'spin': {
      // a runaway thread that leaves a trace while it lives: a killed thread leaves no new traces
      const path = (m.event as { path: string }).path;
      for (let i = 0; ; i++) if (i % 200_000 === 0) writeFileSync(path, String(Date.now()));
    }
    case 'throw':
      throw new Error('boom');
    case 'exit':
      process.exit(3);
    case 'oom': {
      const keep: unknown[] = [];
      for (;;) keep.push(new Array(1_000_000).fill('x'));
    }
    case 'silent':
      return; // never answers
    case 'wrong-id':
      port.postMessage({ id: m.id + 1000, result: { event: {}, findings: [] }, state: hooks.state() });
      return;
    default: {
      const result = hooks.inspect(m.event);
      port.postMessage({ id: m.id, result, state: hooks.state() });
    }
  }
});
