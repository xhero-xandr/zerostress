// The agent's log: what really happened during a check, step by step, with times, so that a person (or a judge) can see
// the work and not only a progress label. Entries are our own codes with a few values of fixed shapes: numbers, short
// tokens of ours, host names, hashes, the model's id. No sentence of the page or of the model ever goes in: a host name is
// the only thing a page chooses, and it is shown as text. The client turns each code into a sentence.

export const LOG_CODES = [
  'submitted', // the supervisor took the run (position in the queue)
  'vm_state', // the run's state at the supervisor
  'vm_booting', // a microVM is booting: slot, vCPUs, memory, image
  'nav_requested', // the browser was sent to the address given
  'redirect', // the server sent the browser on (from, to, status)
  'scheduled', // the page itself scheduled a navigation (meta refresh, timer)
  'page', // a page was read (host); in a deep check also the pages the agent opened
  'forms', // forms on that page (how many, whether one asks for a password)
  'device', // the same address opened as a phone or a tablet
  'screenshot', // an image of what the browser saw was saved
  'download', // a download started (saved or not)
  'visit_done', // the visit as a whole: requests, other sites, blocked requests
  'hooks_fired', // the injection detectors found something (which rule is not told: the report never names them)
  'model_asked', // the model was asked (model, text or vision, step)
  'model_answered', // its answer (time, tokens, its verdict, the next action it proposed)
  'rules_only', // the model was not asked or not listened to (reason)
  'gate_allowed', // the gatekeeper let the proposed action through (action, risk)
  'gate_refused', // the gatekeeper refused it (action, reason)
  'command', // an action inside the sandbox (action, status)
  'approval_wait', // a risky action waits for the person who started the check
  'approval_done', // the person decided, or the time ran out (result)
  'stopped_by_hooks', // the agent took no action because the hooks fired while the model was thinking
  'verdict', // the final verdict (verdict, by)
  'hooks_summary', // how many inspections and findings
] as const;
export type LogCode = (typeof LOG_CODES)[number];

type Shape = 'host' | 'token' | 'int' | 'bool' | 'hex' | 'model';
const KEYS: Readonly<Record<string, Shape>> = {
  host: 'host', from: 'host', to: 'host',
  position: 'int', slot: 'int', vcpu: 'int', mem_mib: 'int', delay_s: 'int', status: 'int', count: 'int', requests: 'int',
  hosts: 'int', blocked: 'int', ms: 'int', tokens: 'int', step: 'int', inspected: 'int', findings: 'int',
  password: 'bool', saved: 'bool', by_session: 'bool',
  state: 'token', reason: 'token', mode: 'token', verdict: 'token', next: 'token', action: 'token', risk: 'token',
  device: 'token', result: 'token', by: 'token',
  // the guest image's hash: proof of the image that ran; our rule set's and prompt's hashes are never shown
  image: 'hex',
  model: 'model',
};
const SHAPE: Readonly<Record<Exclude<Shape, 'int' | 'bool'>, RegExp>> = {
  host: /^(?:[a-z0-9-]{1,63}\.)*[a-z0-9-]{1,63}\.?(?::\d{1,5})?$|^\[[0-9a-f:.]{2,45}\](?::\d{1,5})?$/,
  token: /^[a-z][a-z0-9_]{0,39}$/,
  hex: /^[0-9a-f]{8,64}$/,
  model: /^[A-Za-z0-9._:/-]{1,100}$/,
};

export type LogValue = string | number | boolean;
export interface LogEntry {
  /** milliseconds since the task started */
  t: number;
  code: LogCode;
  d: Record<string, LogValue>;
}

export const MAX_LOG = 200;
const CODES = new Set<string>(LOG_CODES);

/** One entry of the right shape, or null. Unknown keys and values of the wrong shape are dropped, never repaired. */
export function cleanEntry(x: unknown): LogEntry | null {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return null;
  const e = x as Record<string, unknown>;
  if (typeof e.code !== 'string' || !CODES.has(e.code)) return null;
  if (typeof e.t !== 'number' || !Number.isInteger(e.t) || e.t < 0 || e.t > 86_400_000) return null;
  const d: Record<string, LogValue> = {};
  const raw = typeof e.d === 'object' && e.d !== null && !Array.isArray(e.d) ? (e.d as Record<string, unknown>) : {};
  for (const [k, v] of Object.entries(raw)) {
    const shape = Object.hasOwn(KEYS, k) ? KEYS[k] : undefined;
    if (shape === 'int') { if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 1e9) d[k] = v; }
    else if (shape === 'bool') { if (typeof v === 'boolean') d[k] = v; }
    else if (shape && typeof v === 'string' && SHAPE[shape].test(v)) d[k] = v;
  }
  return { t: e.t, code: e.code as LogCode, d };
}

export function cleanLog(x: unknown): LogEntry[] {
  return (Array.isArray(x) ? x : []).slice(0, MAX_LOG).map(cleanEntry).filter((e): e is LogEntry => e !== null);
}

/** The log of one task: entries are cleaned as they are written, so nothing of the wrong shape is ever kept. */
export function createLog(now: () => number = Date.now) {
  const start = now();
  const entries: LogEntry[] = [];
  return {
    entries,
    add(code: LogCode, d: Record<string, unknown> = {}): LogEntry | null {
      if (entries.length >= MAX_LOG) return null;
      const e = cleanEntry({ t: Math.max(0, Math.round(now() - start)), code, d });
      if (e) entries.push(e);
      return e;
    },
  };
}
