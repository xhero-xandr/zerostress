#!/usr/bin/env node
// Mutation check of the hooks' tests (spec 009, 7): break one protective step at a time in a COPY of web/ and require
// that the tests fail. Two kinds of mutation:
//   - every detection rule switched off in turn (a rule that no test needs on its own is dead weight);
//   - the code mutations of tools/mutations.mjs (normalisation, decoding, activation, cutting, task state, guard).
// A mutation that survives, or whose text is not found exactly once, fails the run. Takes several minutes.
//
//   node tools/mutate.mjs              all of them
//   node tools/mutate.mjs --only=rule  only mutations whose label contains "rule"
//   node tools/mutate.mjs --list       print the labels

import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MUTATIONS } from './mutations.mjs';

const webDir = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const only = args.find((a) => a.startsWith('--only='))?.slice(7);

const rulesSrc = readFileSync(join(webDir, 'hooks/rules.ts'), 'utf8');
// the rules are data now: their ids come from the files
const rulesDir = join(webDir, 'hooks/rules');
const ruleIds = readdirSync(rulesDir).filter((n) => n.endsWith('.rules.json'))
  .flatMap((n) => JSON.parse(readFileSync(join(rulesDir, n), 'utf8')).rules.map((r) => r.id));
const RULES_LINE = 'export const RULES: readonly Rule[] = loaded.rules;';
if (!rulesSrc.includes(RULES_LINE)) throw new Error('hooks/rules.ts no longer exports RULES the way tools/mutate.mjs expects');

const all = [
  ...ruleIds.map((id) => ({ label: `rule off: ${id}`, ruleOff: id, tests: ['hooks/test/hooks.test.ts'] })),
  ...MUTATIONS,
].filter((m) => !only || m.label.includes(only));

if (args.includes('--list')) {
  for (const m of all) console.log(m.label);
  process.exit(0);
}

const work = mkdtempSync(join(tmpdir(), 'zs-mutate-'));
cpSync(webDir, join(work, 'web'), { recursive: true, filter: (p) => !p.includes('node_modules') });
const root = join(work, 'web');
symlinkSync(join(webDir, 'node_modules'), join(root, 'node_modules'), 'junction');

const files = new Map();
const original = (f) => {
  if (!files.has(f)) files.set(f, readFileSync(join(root, f), 'utf8'));
  return files.get(f);
};
const restore = () => { for (const [f, t] of files) writeFileSync(join(root, f), t); };

function testsFail(testFiles, env = {}) {
  const r = spawnSync(process.execPath, ['--test', '--test-concurrency=2', '--test-timeout=30000', ...testFiles], {
    cwd: root, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 240_000,
  });
  return r.status !== 0;
}

let caught = 0;
const bad = [];
try {
  // the unmutated copy must pass, or "caught" would mean nothing
  const base = spawnSync(process.execPath, ['--test', '--test-concurrency=2', 'hooks/test/hooks.test.ts', 'hooks/test/guarded.test.ts'], { cwd: root, encoding: 'utf8', timeout: 240_000 });
  if (base.status !== 0) {
    console.error('the tests fail without any mutation:\n' + base.stdout.split('\n').filter((l) => l.startsWith('✖')).join('\n'));
    process.exit(2);
  }
  for (const m of all) {
    let failed;
    if (m.ruleOff) {
      writeFileSync(join(root, 'hooks/rules.ts'), original('hooks/rules.ts').replace(RULES_LINE, 'export const RULES: readonly Rule[] = loaded.rules.filter((r) => r.id !== process.env.ZS_OFF);'));
      files.set('hooks/rules.ts', rulesSrc);
      failed = testsFail(m.tests, { ZS_OFF: m.ruleOff });
    } else {
      const text = original(m.file);
      const at = text.indexOf(m.from);
      if (at < 0 || text.indexOf(m.from, at + 1) >= 0) {
        bad.push(`NOT APPLIED (found ${at < 0 ? 'zero' : 'several'} times): ${m.label}`);
        continue;
      }
      writeFileSync(join(root, m.file), text.slice(0, at) + m.to + text.slice(at + m.from.length));
      failed = testsFail(m.tests);
    }
    restore();
    if (failed) caught++;
    else bad.push(`SURVIVED: ${m.label}`);
    process.stdout.write(failed ? '.' : 'S');
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
console.log(`\nmutations: ${all.length}, caught: ${caught}`);
for (const b of bad) console.log(b);
process.exit(bad.length ? 1 : 0);
