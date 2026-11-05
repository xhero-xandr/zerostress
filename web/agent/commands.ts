// The form of a session command (spec 005, 3.3 and 006, 3.8). The supervisor checks it first, the collector second, this
// is the third copy: the agent builds a command only from what it has checked itself. The rules are the same on
// purpose; agent/test/commands.test.ts runs the supervisor's fixture (supervisor/testdata/canonical.json) through
// this file.

export type Risk = 'safe' | 'risky';

const ID = /^[A-Za-z0-9_-]{1,64}$/;
export const REF = /^(?:f\d{1,4})?e\d{1,9}$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

type Check = (v: unknown) => boolean;
const int = (min: number, max: number): Check => (v) => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
const bool: Check = (v) => typeof v === 'boolean';
const ref: Check = (v) => typeof v === 'string' && REF.test(v);
const values: Check = (v) => {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const keys = Object.keys(v);
  if (keys.length > 20) return false;
  const o = v as Record<string, unknown>;
  return keys.every((k) => REF.test(k) && typeof o[k] === 'string' && (o[k] as string).length <= 100 && !CONTROL.test(o[k] as string));
};

interface Spec {
  risk: Risk;
  required: Array<[string, Check]>;
  optional: Array<[string, Check]>;
}

const snap: [string, Check] = ['snap', int(0, 1_000_000_000)];
export const COMMANDS: Readonly<Record<string, Spec>> = Object.freeze({
  snapshot: { risk: 'safe', required: [], optional: [] },
  scroll: { risk: 'safe', required: [['dy', int(-5000, 5000)]], optional: [] },
  wait: { risk: 'safe', required: [['ms', int(0, 5000)]], optional: [] },
  screenshot: { risk: 'safe', required: [], optional: [['full', bool]] },
  open_link: { risk: 'safe', required: [snap, ['ref', ref]], optional: [] },
  back: { risk: 'safe', required: [], optional: [] },
  close: { risk: 'safe', required: [], optional: [] },
  download: { risk: 'risky', required: [snap, ['ref', ref]], optional: [] },
  submit_form: { risk: 'risky', required: [snap, ['form', ref], ['values', values]], optional: [] },
});

export type Validated =
  | { ok: true; command: Record<string, unknown>; risk: Risk }
  | { ok: false; error: 'bad_command' | 'unknown_command'; id?: string };

const validId = (id: unknown): string | undefined => (typeof id === 'string' && ID.test(id) ? id : undefined);

/** Checks one command line exactly as the supervisor does. */
export function validateCommand(line: unknown): Validated {
  if (typeof line !== 'string' || Buffer.byteLength(line) > 4096) return { ok: false, error: 'bad_command' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { ok: false, error: 'bad_command' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, error: 'bad_command' };
  const o = parsed as Record<string, unknown>;
  const spec = typeof o.cmd === 'string' && Object.hasOwn(COMMANDS, o.cmd) ? COMMANDS[o.cmd] : undefined;
  if (!spec) return { ok: false, error: 'unknown_command', id: validId(o.id) };
  const id = validId(o.id);
  if (!id) return { ok: false, error: 'bad_command' };
  const allowed = new Set(['cmd', 'id', ...spec.required.map(([k]) => k), ...spec.optional.map(([k]) => k)]);
  if (Object.keys(o).some((k) => !allowed.has(k))) return { ok: false, error: 'bad_command', id };
  for (const [k, check] of spec.required) if (!Object.hasOwn(o, k) || !check(o[k])) return { ok: false, error: 'bad_command', id };
  for (const [k, check] of spec.optional) if (Object.hasOwn(o, k) && !check(o[k])) return { ok: false, error: 'bad_command', id };
  return { ok: true, command: o, risk: spec.risk };
}
