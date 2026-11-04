import { createHash } from 'node:crypto';
import { LIMITS } from './limits.mjs';

// Kinds that are always let through, even when the output budget is spent: they are small and carry the outcome.
const ESSENTIAL = new Set(['error', 'summary', 'session_ready', 'cmd_result']);

/**
 * NDJSON writer for evidence events. Lines are written strictly in call order and wait for the pipe to drain
 * (a collector that outruns the agent would grow in memory and take the VM down, spec 004, 8c). A byte budget keeps
 * the run below the agent's output limit; what does not fit is counted, never silently lost.
 */
export function createEmitter(stream, { now = Date.now, budget = LIMITS.outputBudgetBytes } = {}) {
  const started = now();
  const counts = Object.create(null);
  const dropped = Object.create(null);
  let used = 0;
  let chain = Promise.resolve();

  function write(line) {
    return new Promise((resolve, reject) => {
      stream.write(line, (err) => (err ? reject(err) : resolve()));
    });
  }

  function emit(kind, fields = {}) {
    const record = { type: 'evidence', v: 1, kind, t: now() - started, ...fields };
    const line = JSON.stringify(record) + '\n';
    const bytes = Buffer.byteLength(line);
    if (!ESSENTIAL.has(kind) && used + bytes > budget) {
      dropped[kind] = (dropped[kind] ?? 0) + 1;
      return chain;
    }
    used += bytes;
    counts[kind] = (counts[kind] ?? 0) + 1;
    chain = chain.then(() => write(line));
    return chain;
  }

  return {
    emit,
    /** Resolves when every line emitted so far has been handed to the pipe. */
    flush: () => chain,
    elapsed: () => now() - started,
    counts: () => ({ ...counts }),
    dropped: () => ({ ...dropped }),
    bytesUsed: () => used,
  };
}

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
