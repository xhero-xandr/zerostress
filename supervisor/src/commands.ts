import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Session commands (spec 005, 3.3; spec 006, 3.8). The supervisor accepts only this fixed set with checked
 * parameters. What it sends to the guest is the canonical form, so the SHA-256 an approval is bound to is the
 * SHA-256 of exactly the bytes that reach the collector.
 */

export type Risk = 'safe' | 'risky';

export const COMMAND_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** `e7`, or `f1e3` for an element inside an iframe (Playwright aria refs). */
export const REF_RE = /^(?:f\d{1,4})?e\d{1,9}$/;
export const MAX_COMMAND_BYTES = 4096;
const MAX_VALUE_FIELDS = 20;
const MAX_VALUE_CHARS = 100;

type FieldCheck = (v: unknown) => string | null;

const integer = (min: number, max: number): FieldCheck => (v) =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? null : `must be an integer from ${min} to ${max}`;
const bool: FieldCheck = (v) => (typeof v === 'boolean' ? null : 'must be true or false');
const ref: FieldCheck = (v) => (typeof v === 'string' && REF_RE.test(v) ? null : 'must be an element reference like e7');
const formValues: FieldCheck = (v) => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return 'must be an object';
  const entries = Object.entries(v as Record<string, unknown>);
  if (entries.length > MAX_VALUE_FIELDS) return `must have at most ${MAX_VALUE_FIELDS} fields`;
  for (const [k, val] of entries) {
    if (!REF_RE.test(k)) return 'keys must be element references';
    if (typeof val !== 'string' || val.length > MAX_VALUE_CHARS) return `values must be strings of at most ${MAX_VALUE_CHARS} characters`;
    if (/[\u0000-\u001f\u007f-\u009f]/.test(val)) return 'values must not contain control characters';
  }
  return null;
};

interface Spec {
  risk: Risk;
  required: Record<string, FieldCheck>;
  optional: Record<string, FieldCheck>;
}

const snap = integer(0, 1_000_000_000);

export const COMMANDS: Record<string, Spec> = {
  snapshot: { risk: 'safe', required: {}, optional: {} },
  scroll: { risk: 'safe', required: { dy: integer(-5000, 5000) }, optional: {} },
  wait: { risk: 'safe', required: { ms: integer(0, 5000) }, optional: {} },
  screenshot: { risk: 'safe', required: {}, optional: { full: bool } },
  open_link: { risk: 'safe', required: { snap, ref }, optional: {} },
  back: { risk: 'safe', required: {}, optional: {} },
  close: { risk: 'safe', required: {}, optional: {} },
  download: { risk: 'risky', required: { snap, ref }, optional: {} },
  submit_form: { risk: 'risky', required: { snap, form: ref, values: formValues }, optional: {} },
};

export interface ValidCommand {
  id: string;
  cmd: string;
  risk: Risk;
  /** The exact line sent to the guest. */
  canonical: string;
  sha256: string;
}

export type CommandCheck = { ok: true; command: ValidCommand } | { ok: false; error: string };

/** Sorted keys at every level, no whitespace, JSON strings, integers only (validation guarantees that). */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number') {
    if (!Number.isInteger(v)) throw new Error('canonical form allows integers only');
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(',')}}`;
  }
  throw new Error('value cannot be written in canonical form');
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function validateCommand(raw: unknown): CommandCheck {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, error: 'command must be a JSON object' };
  const o = raw as Record<string, unknown>;
  if (typeof o.cmd !== 'string' || !Object.hasOwn(COMMANDS, o.cmd)) return { ok: false, error: 'unknown command type' };
  const spec = COMMANDS[o.cmd]!;
  if (typeof o.id !== 'string' || !COMMAND_ID_RE.test(o.id)) return { ok: false, error: 'id must match [A-Za-z0-9_-]{1,64}' };
  for (const k of Object.keys(o)) {
    if (k !== 'cmd' && k !== 'id' && !Object.hasOwn(spec.required, k) && !Object.hasOwn(spec.optional, k)) {
      return { ok: false, error: `unknown field: ${k.slice(0, 40)}` };
    }
  }
  for (const [k, check] of Object.entries(spec.required)) {
    if (!Object.hasOwn(o, k)) return { ok: false, error: `missing field: ${k}` };
    const problem = check(o[k]);
    if (problem) return { ok: false, error: `${k} ${problem}` };
  }
  for (const [k, check] of Object.entries(spec.optional)) {
    if (!Object.hasOwn(o, k)) continue;
    const problem = check(o[k]);
    if (problem) return { ok: false, error: `${k} ${problem}` };
  }
  const canonical = canonicalJson(o);
  if (Buffer.byteLength(canonical) > MAX_COMMAND_BYTES) return { ok: false, error: `command is longer than ${MAX_COMMAND_BYTES} bytes` };
  return { ok: true, command: { id: o.id, cmd: o.cmd, risk: spec.risk, canonical, sha256: sha256Hex(canonical) } };
}

/** Constant-time comparison of two hex digests. */
export function sameDigest(a: unknown, b: string): boolean {
  if (typeof a !== 'string' || a.length !== b.length || !/^[0-9a-f]+$/.test(a)) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}
