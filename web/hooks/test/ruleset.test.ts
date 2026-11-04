import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createHooks } from '../index.ts';
import { CATEGORIES } from '../kinds.ts';
import { viewOf } from '../normalize.ts';
import { RULES, RULESET_SHA256, SQUASHED } from '../rules.ts';
import { loadRuleset, RulesetError } from '../ruleset.ts';

const realDir = fileURLToPath(new URL('../rules/', import.meta.url));
const hooksDir = fileURLToPath(new URL('../', import.meta.url));
const scratch: string[] = [];
after(() => { for (const d of scratch) rmSync(d, { recursive: true, force: true }); });

type Files = Record<string, unknown>;

const base = (): Files => ({
  'macros.json': { schema: 1, macros: { W: 'alpha|beta' } },
  'squashed.json': { schema: 1, sets: [{ id: 's.one', view: 'squashed_lat', fold: 'none', parts: [['ignoreall'], ['previousinstructions']] }] },
  'a.rules.json': {
    schema: 1,
    rules: [{
      id: 'x.one', category: 'override', strength: 'strong', views: ['lat'], pattern: ['b:@W'],
      examples: { fire: ['alpha here'], quiet: ['gamma'] },
    }],
  },
});

function write(files: Files): string {
  const dir = mkdtempSync(join(tmpdir(), 'zs-rules-'));
  scratch.push(dir);
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return dir;
}

// a one-rule file the cases below edit
type R = Record<string, unknown>;
const withRule = (edit: (r: R) => void): Files => {
  const f = base();
  edit((f['a.rules.json'] as { rules: R[] }).rules[0]!);
  return f;
};

// ---- a good set ------------------------------------------------------------------------------------------------------

test('a small good set loads, with a hash', () => {
  const rs = loadRuleset(write(base()));
  assert.equal(rs.rules.length, 1);
  assert.equal(rs.rules[0]!.id, 'x.one');
  assert.match(rs.hash, /^[0-9a-f]{64}$/);
  assert.deepEqual(rs.squashed[0]!.phrases, ['ignoreallpreviousinstructions']);
});

test('the hash follows the content and the names, and nothing else', () => {
  const a = loadRuleset(write(base())).hash;
  assert.equal(loadRuleset(write(base())).hash, a, 'same files, same hash');
  const changed = base();
  (changed['macros.json'] as { macros: Record<string, string> }).macros.W = 'alpha|betb';
  assert.notEqual(loadRuleset(write(changed)).hash, a, 'one letter changes it');
  const renamed = base();
  renamed['b.rules.json'] = renamed['a.rules.json'];
  delete renamed['a.rules.json'];
  assert.notEqual(loadRuleset(write(renamed)).hash, a, 'a renamed file changes it');
});

// ---- everything that is not exactly right is refused -----------------------------------------------------------------

const BAD: Array<[string, () => Files, RegExp]> = [
  ['an unknown field in a rule', () => withRule((r) => { r.extra = 1; }), /unknown field "extra"/],
  ['a missing field in a rule', () => withRule((r) => { delete r.examples; }), /missing field "examples"/],
  ['a rule id with capitals', () => withRule((r) => { r.id = 'X.one'; }), /bad rule id/],
  ['an unknown category', () => withRule((r) => { r.category = 'mystery'; }), /unknown category/],
  ['a strength that is neither', () => withRule((r) => { r.strength = 'medium'; }), /strength/],
  ['no views', () => withRule((r) => { r.views = []; }), /list of 1 to 6/],
  ['a view a rule cannot match on', () => withRule((r) => { r.views = ['squashed_lat']; }), /cannot match on the view/],
  ['a view listed twice', () => withRule((r) => { r.views = ['lat', 'lat']; }), /listed twice/],
  ['an unknown fold', () => withRule((r) => { r.fold = 'lat'; }), /fold can only be/],
  ['a part without a kind', () => withRule((r) => { r.pattern = ['alpha']; }), /must start with b:, gap: or raw:/],
  ['a gap that is too large', () => withRule((r) => { r.pattern = ['b:alpha', 'gap:10', 'b:beta']; }), /gap needs a number/],
  ['a gap that is not a number', () => withRule((r) => { r.pattern = ['b:alpha', 'gap:x', 'b:beta']; }), /gap needs a number/],
  ['an empty part', () => withRule((r) => { r.pattern = ['b:']; }), /empty b: part/],
  ['an unknown macro', () => withRule((r) => { r.pattern = ['b:@NOPE']; }), /unknown macro @NOPE/],
  ['a pattern that does not compile', () => withRule((r) => { r.pattern = ['raw:(']; }), /does not compile/],
  ['a pattern that matches nothing at all (the empty string)', () => withRule((r) => { r.pattern = ['raw:a*']; }), /matches the empty string/],
  ['a nested unbounded repeat', () => withRule((r) => { r.pattern = ['raw:(?:a+)+']; r.examples = { fire: ['aaa'], quiet: ['b'] }; }), /unbounded repeat/],
  ['an example that does not fire', () => withRule((r) => { r.examples = { fire: ['gamma'], quiet: ['delta'] }; }), /its own example does not fire/],
  ['a quiet example that fires', () => withRule((r) => { r.examples = { fire: ['alpha'], quiet: ['beta'] }; }), /a quiet example fires/],
  ['no fire example', () => withRule((r) => { r.examples = { fire: [], quiet: ['gamma'] }; }), /examples\.fire/],
  ['no quiet example', () => withRule((r) => { r.examples = { fire: ['alpha'], quiet: [] }; }), /examples\.quiet/],
  ['an example that is too long', () => withRule((r) => { r.examples = { fire: ['alpha ' + 'x'.repeat(600)], quiet: ['gamma'] }; }), /at most 500/],
  ['an unknown field in the examples', () => withRule((r) => { r.examples = { fire: ['alpha'], quiet: ['gamma'], more: [] }; }), /unknown field "more"/],
  ['a note that is not text', () => withRule((r) => { r.note = 5; }), /note must be a string/],
  ['a second schema', () => { const f = base(); (f['a.rules.json'] as R).schema = 2; return f; }, /schema must be 1/],
  ['an unknown field in a file', () => { const f = base(); (f['a.rules.json'] as R).extra = 1; return f; }, /unknown field "extra"/],
  ['an empty list of rules', () => { const f = base(); (f['a.rules.json'] as R).rules = []; return f; }, /non-empty list/],
  ['a duplicate id across files', () => { const f = base(); f['b.rules.json'] = f['a.rules.json']; return f; }, /duplicate rule id/],
  ['a missing macros file', () => { const f = base(); delete f['macros.json']; return f; }, /macros\.json is missing/],
  ['a missing squashed file', () => { const f = base(); delete f['squashed.json']; return f; }, /squashed\.json is missing/],
  ['an unexpected file', () => ({ ...base(), 'notes.txt': 'hello' }), /unexpected file "notes\.txt"/],
  ['a file that is not JSON', () => ({ ...base(), 'b.rules.json': '{ not json' }), /not valid JSON/],
  ['a file that is too large', () => ({ ...base(), 'b.rules.json': ' '.repeat(600 * 1024) }), /file is too large/],
  ['a macro name in lower case', () => ({ ...base(), 'macros.json': { schema: 1, macros: { w: 'x' } } }), /bad macro name/],
  ['an empty macro', () => ({ ...base(), 'macros.json': { schema: 1, macros: { W: '' } } }), /non-empty string/],
  ['a macro cycle', () => ({ ...base(), 'macros.json': { schema: 1, macros: { W: '@V', V: '@W' } } }), /nest too deep/],
  ['a macro that is not text', () => ({ ...base(), 'macros.json': { schema: 1, macros: { W: 5 } } }), /non-empty string/],
  ['a squashed phrase that is too short', () => ({ ...base(), 'squashed.json': { schema: 1, sets: [{ id: 's.one', view: 'squashed_lat', fold: 'none', parts: [['ignore'], ['rules']] }] } }), /shorter than 16/],
  ['a squashed phrase with a space', () => ({ ...base(), 'squashed.json': { schema: 1, sets: [{ id: 's.one', view: 'squashed_lat', fold: 'none', parts: [['ignore all'], ['previous instructions']] }] } }), /letters and digits only/],
  ['a squashed set with the id of a rule', () => ({ ...base(), 'squashed.json': { schema: 1, sets: [{ id: 'x.one', view: 'squashed_lat', fold: 'none', parts: [['ignoreall'], ['previousinstructions']] }] } }), /also a rule id/],
  ['a squashed set on a view it cannot have', () => ({ ...base(), 'squashed.json': { schema: 1, sets: [{ id: 's.one', view: 'lat', fold: 'none', parts: [['ignoreall'], ['previousinstructions']] }] } }), /view must be squashed_lat or squashed_cyr/],
];

for (const [label, make, expected] of BAD) {
  test(`refused: ${label}`, () => {
    assert.throws(() => loadRuleset(write(make())), (e: unknown) => e instanceof RulesetError && expected.test(e.message), label);
  });
}

test('refused: more rules than the limit', () => {
  const f = base();
  const one = (f['a.rules.json'] as { rules: R[] }).rules[0]!;
  (f['a.rules.json'] as { rules: R[] }).rules = Array.from({ length: 601 }, (_, i) => ({ ...one, id: `x.r${i}` }));
  assert.throws(() => loadRuleset(write(f)), /expected 1 to 600 rules/);
});

test('refused: a directory or a link in place of a file', () => {
  const dir = write(base());
  mkdirSync(join(dir, 'b.rules.json'));
  assert.throws(() => loadRuleset(dir), /regular file/);
  const dir2 = write(base());
  try {
    symlinkSync(join(dir2, 'a.rules.json'), join(dir2, 'c.rules.json'));
  } catch {
    return; // links need a privilege on some systems; the directory case above shows the check
  }
  assert.throws(() => loadRuleset(dir2), /regular file/);
});

test('refused: a directory that does not exist, or is empty', () => {
  assert.throws(() => loadRuleset(join(tmpdir(), 'zs-no-such-rules-dir')), /cannot read/);
  assert.throws(() => loadRuleset(write({})), /expected 1 to 64 files/);
});

// ---- the real rule set -----------------------------------------------------------------------------------------------

test('the real rule set: what it holds', () => {
  assert.ok(RULES.length >= 56, `${RULES.length} rules`);
  assert.equal(new Set(RULES.map((r) => r.id)).size, RULES.length);
  for (const r of RULES) assert.ok((CATEGORIES as readonly string[]).includes(r.category), r.id);
  assert.deepEqual(SQUASHED.map((s) => s.id).sort(), ['override.squashed', 'ru.override.squashed']);
});

test('the real rule set: every rule carries its own proof (examples are in the file, not only checked at load)', () => {
  let seen = 0;
  for (const name of readdirSync(realDir).filter((n) => n.endsWith('.rules.json'))) {
    const doc = JSON.parse(readFileSync(join(realDir, name), 'utf8')) as { rules: Array<{ id: string; examples: { fire: string[]; quiet: string[] } }> };
    for (const r of doc.rules) {
      assert.ok(r.examples.fire.length >= 1 && r.examples.quiet.length >= 1, r.id);
      seen++;
    }
  }
  assert.equal(seen, RULES.length);
});

test('the real rule set: the hash is the one an independent computation gives, and the hooks report it', () => {
  const h = createHash('sha256');
  for (const name of readdirSync(realDir).sort()) h.update(name).update('\0').update(readFileSync(join(realDir, name))).update('\0');
  assert.equal(RULESET_SHA256, h.digest('hex'));
  assert.equal(createHooks().state().ruleset, RULESET_SHA256);
});

test('the real rule set: no rule is slow on hostile input', () => {
  const hostile = [
    'a '.repeat(40_000), 'ignore '.repeat(20_000), ' '.repeat(100_000), `ignore ${'x '.repeat(40_000)}instructions`,
    'you '.repeat(30_000), '<'.repeat(80_000), 'и '.repeat(40_000), '- '.repeat(40_000),
  ];
  const slow: string[] = [];
  for (const text of hostile) {
    const views = new Map<string, string>();
    for (const r of RULES) {
      for (const name of r.views) {
        if (!views.has(name)) views.set(name, viewOf(text, name).text);
        const t0 = process.hrtime.bigint();
        r.re.lastIndex = 0;
        r.re.test(views.get(name)!);
        r.re.lastIndex = 0;
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        if (ms > 500) slow.push(`${r.id} on ${name}: ${ms.toFixed(0)} ms`);
      }
    }
  }
  assert.deepEqual(slow, []);
});

// ---- a damaged set stops the hooks from starting ---------------------------------------------------------------------

function importHooksFrom(rulesEdit: (copyDir: string) => void): { code: number | null; err: string } {
  const root = mkdtempSync(join(tmpdir(), 'zs-hooks-'));
  scratch.push(root);
  const copy = join(root, 'hooks');
  cpSync(hooksDir, copy, { recursive: true, filter: (p) => !p.includes(`${join(hooksDir, 'test')}`) });
  rulesEdit(copy);
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', "const m = await import('./hooks/hooks.ts'); m.createHooks(); console.log('started')"], { cwd: root, encoding: 'utf8' });
  return { code: r.status, err: r.stderr };
}

test('control: an untouched copy of the hooks starts', () => {
  const r = importHooksFrom(() => {});
  assert.equal(r.code, 0, r.err);
});

test('a rule file without its examples: the hooks do not start', () => {
  const r = importHooksFrom((dir) => {
    const path = join(dir, 'rules', 'english-override.rules.json');
    const doc = JSON.parse(readFileSync(path, 'utf8')) as { rules: Array<Record<string, unknown>> };
    delete doc.rules[0]!.examples;
    writeFileSync(path, JSON.stringify(doc));
  });
  assert.notEqual(r.code, 0);
  assert.match(r.err, /RulesetError|missing field "examples"/);
});

test('a missing rules directory: the hooks do not start', () => {
  const r = importHooksFrom((dir) => rmSync(join(dir, 'rules'), { recursive: true }));
  assert.notEqual(r.code, 0);
  assert.match(r.err, /cannot read the rules directory/);
});

test('a rules file that is not JSON: the hooks do not start', () => {
  const r = importHooksFrom((dir) => writeFileSync(join(dir, 'rules', 'russian.rules.json'), '{'));
  assert.notEqual(r.code, 0);
  assert.match(r.err, /not valid JSON/);
});

test('an extra file in the rules directory: the hooks do not start', () => {
  const r = importHooksFrom((dir) => writeFileSync(join(dir, 'rules', 'extra.rules.json.bak'), '{}'));
  assert.notEqual(r.code, 0);
  assert.match(r.err, /unexpected file/);
});

test('"gap:N" allows at most N words between the parts', () => {
  const ok = loadRuleset(write(withRule((r) => {
    r.pattern = ['b:alpha', 'gap:1', 'b:beta'];
    r.examples = { fire: ['alpha beta', 'alpha x beta'], quiet: ['alpha x y z beta', 'beta alpha'] };
  })));
  assert.equal(ok.rules.length, 1);
  assert.throws(() => loadRuleset(write(withRule((r) => {
    r.pattern = ['b:alpha', 'gap:1', 'b:beta'];
    r.examples = { fire: ['alpha x y beta'], quiet: ['gamma'] };
  }))), /its own example does not fire/);
});

test('"fold": "cyr" folds the pattern like the cyrillic view (й → и, ё → е)', () => {
  const rs = loadRuleset(write(withRule((r) => {
    r.fold = 'cyr';
    r.views = ['cyr'];
    r.pattern = ['b:йод'];
    r.examples = { fire: ['Йод есть'], quiet: ['иод'.replace('и', 'у')] };
  })));
  assert.equal(rs.rules[0]!.re.source.includes('й'), false);
});
