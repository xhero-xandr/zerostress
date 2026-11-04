// Regenerate canonical.json from the TypeScript reference: node supervisor-go/testdata/gen-canonical.mjs
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateCommand } from '../../supervisor/src/commands.ts';

const here = dirname(fileURLToPath(import.meta.url));

const refs = (n, v) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`e${i}`, v]));
const sf = (values, extra = {}) => ({ cmd: 'submit_form', id: 'f', snap: 4, form: 'e1', values, ...extra });
const wide = '日'.repeat(100);

// Valid commands. `raw` (optional) is the JSON text to decode instead of the value, for number spellings that
// JSON.stringify would normalise away.
const valid = [
  { input: { cmd: 'snapshot', id: 'a' } },
  { input: { id: 'a', cmd: 'snapshot' } },
  { input: { cmd: 'snapshot', id: 'A-z_0-9' } },
  { input: { cmd: 'snapshot', id: 'x'.repeat(64) } },
  { input: { cmd: 'scroll', id: 'a', dy: -5000 } },
  { input: { cmd: 'scroll', id: 'a', dy: 5000 } },
  { input: { cmd: 'scroll', id: 'a', dy: 0 } },
  { input: { dy: 100, id: 'a', cmd: 'scroll' } },
  { input: { id: 'a', cmd: 'scroll', dy: 100 } },
  { input: { cmd: 'scroll', id: 'a', dy: 0 }, raw: '{"cmd":"scroll","id":"a","dy":-0}' },
  { input: { cmd: 'scroll', id: 'a', dy: 100 }, raw: '{"cmd":"scroll","id":"a","dy":1e2}' },
  { input: { cmd: 'scroll', id: 'a', dy: 100 }, raw: '{"cmd":"scroll","id":"a","dy":100.0}' },
  { input: { cmd: 'scroll', id: 'a', dy: 5000 }, raw: '{"dy":5E+3,"cmd":"scroll","id":"a"}' },
  { input: { cmd: 'wait', id: 'a', ms: 0 } },
  { input: { cmd: 'wait', id: 'a', ms: 5000 } },
  { input: { ms: 250, cmd: 'wait', id: 'w' } },
  { input: { cmd: 'screenshot', id: 'a' } },
  { input: { cmd: 'screenshot', id: 'a', full: true } },
  { input: { full: false, id: 'a', cmd: 'screenshot' } },
  { input: { cmd: 'open_link', id: 'a', snap: 3, ref: 'e7' } },
  { input: { ref: 'f1e3', snap: 3, id: 'a', cmd: 'open_link' } },
  { input: { cmd: 'open_link', id: 'a', snap: 0, ref: 'e0' } },
  { input: { cmd: 'open_link', id: 'a', snap: 1000000000, ref: 'f9999e999999999' } },
  { input: { cmd: 'back', id: 'a' } },
  { input: { cmd: 'close', id: 'a' } },
  { input: { cmd: 'close', id: 'idle-close_' } },
  { input: { cmd: 'download', id: 'a', snap: 1, ref: 'e2' } },
  { input: { ref: 'e2', snap: 1, id: 'a', cmd: 'download' } },
  { input: { cmd: 'submit_form', id: 'a', snap: 1, form: 'e4', values: {} } },
  { input: { cmd: 'submit_form', id: 'a', snap: 1, form: 'e4', values: { e5: 'x', e6: 'y' } } },
  { input: { values: { e6: 'b', e5: 'a' }, cmd: 'submit_form', id: 'x', form: 'e4', snap: 2 } },
  { input: { snap: 2, form: 'e4', id: 'x', cmd: 'submit_form', values: { e5: 'a', e6: 'b' } } },
  { input: { id: 'x', values: { e10: '10', e2: '2', e1: '1', f1e1: 'frame' }, snap: 2, form: 'f2e4', cmd: 'submit_form' } },
  { input: sf({ e2: 'Привет, мир' }) },
  { input: sf({ e2: 'Привет 日本語 😀', e3: '日本語のテキスト', e4: 'emoji 😀🎉👍🏽' }) },
  { input: sf({ e2: '"' }) },
  { input: sf({ e2: '\\' }) },
  { input: sf({ e2: '/' }) },
  { input: sf({ e2: '\\"\\\\"/' }) },
  { input: sf({ e2: 'a b' }) },
  { input: sf({ e2: 'a b' }) },
  { input: sf({ e2: 'a~b' }) },
  { input: sf({ e2: '<script>alert(1)</script>' }) },
  { input: sf({ e2: 'a&b>c<d' }) },
  { input: sf({ e2: ' nbsp ­ soft ​ zwsp ﻿ bom ÿ' }) },
  { input: sf({ e2: 'a b  c' }) },
  { input: sf({ e2: '' }) },
  { input: sf({ e2: 'x'.repeat(100) }) },
  { input: sf({ e2: '😀'.repeat(50) }) },
  { input: sf({ e2: 'é' + '日'.repeat(99) }) },
  { input: sf(refs(20, 'v')) },
  { input: sf({ e2: '  "\\/<>&' }, { id: 'U_1-2' }) },
  { input: sf({ e2: 'http://user:pa$$@example.test/?a=1&b=2#frag' }) },
  { input: sf({ e2: wide, e3: wide, e4: wide, e5: wide, e6: wide, e7: wide, e8: wide, e9: wide, e10: wide, e11: wide, e12: 'x'.repeat(50) }) },
  // duplicate keys: the last one wins in both decoders
  { input: { cmd: 'snapshot', id: 'b' }, raw: '{"cmd":"snapshot","id":"a","id":"b"}' },
];

// Invalid inputs. `ordered: false` marks messages that depend on the order the keys are visited in: the test then
// only requires that the Go validator rejects the input.
const invalid = [
  { input: null },
  { input: 5 },
  { input: 'snapshot' },
  { input: [] },
  { input: [{ cmd: 'snapshot', id: 'a' }] },
  { input: true },
  { input: {} },
  { input: { id: 'a' } },
  { input: { cmd: 5, id: 'a' } },
  { input: { cmd: null, id: 'a' } },
  ...['eval', 'goto', 'click', 'constructor', '__proto__', 'toString', 'hasOwnProperty', '', 'SNAPSHOT', 'snapshot '].map((cmd) => ({ input: { cmd, id: 'a' } })),
  ...['', 'a b', 'a/b', 'a.b', 'é', 'x'.repeat(65), 5, null, 'a\n', 'a '].map((id) => ({ input: { cmd: 'snapshot', id } })),
  { input: { cmd: 'snapshot' } },
  { input: { cmd: 'snapshot', id: 'a', extra: 1 } },
  { input: { cmd: 'scroll', id: 'a', dy: 1, ms: 2 } },
  { input: { cmd: 'scroll', id: 'a' } },
  { input: { cmd: 'open_link', id: 'a', ref: 'e1' } },
  { input: { cmd: 'open_link', id: 'a', snap: 1 } },
  { input: { cmd: 'submit_form', id: 'a', snap: 1, form: 'e1' } },
  { input: { cmd: 'download', id: 'a', snap: 1, ref: 'e1', url: 'https://evil.test/' } },
  { input: { cmd: 'snapshot', id: 'a', ['x'.repeat(60)]: 1 } },
  { input: { cmd: 'snapshot', id: 'a' }, raw: '{"cmd":"snapshot","id":"a","__proto__":{"x":1}}' },
  { input: { cmd: 'snapshot', id: 'a', ms: 5 } },
  { input: { cmd: 'close', id: 'a', full: true } },
  { input: { cmd: 'scroll', id: 'a', dy: 5001 } },
  { input: { cmd: 'scroll', id: 'a', dy: -5001 } },
  { input: { cmd: 'scroll', id: 'a', dy: 1.5 } },
  { input: { cmd: 'scroll', id: 'a', dy: '10' } },
  { input: { cmd: 'scroll', id: 'a', dy: null } },
  { input: { cmd: 'scroll', id: 'a', dy: true } },
  { input: { cmd: 'scroll', id: 'a', dy: [1] } },
  { input: { cmd: 'scroll', id: 'a', dy: 0.1 } },
  { input: { cmd: 'wait', id: 'a', ms: -1 } },
  { input: { cmd: 'wait', id: 'a', ms: 5001 } },
  { input: { cmd: 'wait', id: 'a', ms: 1e12 } },
  { input: { cmd: 'open_link', id: 'a', snap: -1, ref: 'e1' } },
  { input: { cmd: 'open_link', id: 'a', snap: 1e12, ref: 'e1' } },
  { input: { cmd: 'open_link', id: 'a', snap: 1000000001, ref: 'e1' } },
  { input: { cmd: 'screenshot', id: 'a', full: 'yes' } },
  { input: { cmd: 'screenshot', id: 'a', full: 1 } },
  { input: { cmd: 'screenshot', id: 'a', full: null } },
  ...['', 'e', '7', 'e-1', 'E7', ' e7', 'e7 ', 'e7;x', 'a1', 'f1', 'e1e2', 'f99999e1', 'e1234567890', 'e7\n', 'e١', 5, null, ['e1']].map((ref) => ({
    input: { cmd: 'open_link', id: 'a', snap: 1, ref },
  })),
  { input: { cmd: 'download', id: 'a', snap: 1, ref: 'x' } },
  { input: { cmd: 'submit_form', id: 'a', snap: 1, form: 'form-1', values: {} } },
  { input: sf(refs(21, 'x')) },
  { input: sf({ e2: 'x'.repeat(101) }) },
  { input: sf({ e2: '😀'.repeat(51) }) },
  ...['a\nb', 'a\u0000b', 'a\u001fb', 'a\u007fb', 'a\u0080b', 'a\u0085b', 'a\u009fb', 'a\tb', 'a\rb'].map((v) => ({ input: sf({ e2: v }) })),
  { input: sf({ e2: 5 }) },
  { input: sf({ e2: null }) },
  { input: sf({ e2: ['x'] }) },
  { input: sf({ name: 'x' }) },
  { input: sf({ '': 'x' }) },
  { input: sf({ e2: 'ok', name: 'x' }), ordered: false },
  { input: sf({ e2: 5, e3: 'a\nb' }), ordered: false },
  { input: sf(['x']) },
  { input: sf(null) },
  { input: sf('e2') },
  { input: sf({ e2: 'a' }, { extra1: 1, extra2: 2 }), ordered: false },
  { input: sf(refs(20, wide)) },
];

function run(c) {
  const text = c.raw ?? JSON.stringify(c.input);
  return { text, result: validateCommand(JSON.parse(text)) };
}

const out = { valid: [], invalid: [] };
for (const c of valid) {
  const { text, result } = run(c);
  if (!result.ok) throw new Error(`expected valid: ${text} -> ${result.error}`);
  out.valid.push({ input: c.input, ...(c.raw ? { raw: c.raw } : {}), canonical: result.command.canonical, sha256: result.command.sha256 });
}
for (const c of invalid) {
  const { text, result } = run(c);
  if (result.ok) throw new Error(`expected invalid: ${text}`);
  out.invalid.push({ input: c.input, ...(c.raw ? { raw: c.raw } : {}), error: result.error, ordered: c.ordered !== false });
}
writeFileSync(join(here, 'canonical.json'), JSON.stringify(out, null, 1) + '\n');
console.log(`valid: ${out.valid.length}, invalid: ${out.invalid.length}`);
