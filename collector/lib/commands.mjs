// Second check of the session commands (the supervisor is the first one, spec 005 3.3 and 006 3.8). The rules are the
// same on purpose; collector/test/commands.test.mjs runs the supervisor's fixture through this file.

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const REF = /^(?:f\d{1,4})?e\d{1,9}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

const int = (min, max) => (v) => Number.isInteger(v) && v >= min && v <= max;
const bool = (v) => typeof v === 'boolean';
const ref = (v) => typeof v === 'string' && REF.test(v);
const values = (v) => {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const keys = Object.keys(v);
  if (keys.length > 20) return false;
  return keys.every((k) => REF.test(k) && typeof v[k] === 'string' && v[k].length <= 100 && !CONTROL.test(v[k]));
};

const snap = ['snap', int(0, 1_000_000_000)];
export const COMMANDS = Object.freeze({
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

/** Returns { ok: true, command } or { ok: false, error } where error is a short lowercase token. */
export function validateCommand(line) {
  if (typeof line !== 'string' || Buffer.byteLength(line) > 4096) return { ok: false, error: 'bad_command' };
  let o;
  try {
    o = JSON.parse(line);
  } catch {
    return { ok: false, error: 'bad_command' };
  }
  if (o === null || typeof o !== 'object' || Array.isArray(o)) return { ok: false, error: 'bad_command' };
  const spec = Object.hasOwn(COMMANDS, o.cmd) ? COMMANDS[o.cmd] : null;
  if (!spec) return { ok: false, error: 'unknown_command', id: validId(o.id) };
  if (!validId(o.id)) return { ok: false, error: 'bad_command' };
  const allowed = new Set(['cmd', 'id', ...spec.required.map(([k]) => k), ...spec.optional.map(([k]) => k)]);
  if (Object.keys(o).some((k) => !allowed.has(k))) return { ok: false, error: 'bad_command', id: o.id };
  for (const [k, check] of spec.required) if (!Object.hasOwn(o, k) || !check(o[k])) return { ok: false, error: 'bad_command', id: o.id };
  for (const [k, check] of spec.optional) if (Object.hasOwn(o, k) && !check(o[k])) return { ok: false, error: 'bad_command', id: o.id };
  return { ok: true, command: o, risk: spec.risk };
}

function validId(id) {
  return typeof id === 'string' && ID.test(id) ? id : undefined;
}
