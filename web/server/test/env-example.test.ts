// Every environment variable the web service reads is in the example the host's web.env is made from, and the example
// names nothing that nobody reads (spec 010, 4.3). A variable added in code but not here fails this test, so the
// example, the installer's checks and docs/configuration.md cannot fall behind the code.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const web = join(import.meta.dirname, '..', '..');
const example = readFileSync(join(web, '..', 'config', 'web.env.example'), 'utf8');
const config = readFileSync(join(web, '..', 'docs', 'configuration.md'), 'utf8');

const source = ['server', 'agent', 'hooks']
  .flatMap((d) => readdirSync(join(web, d)).filter((f) => f.endsWith('.ts')).map((f) => readFileSync(join(web, d, f), 'utf8')))
  .join('\n');

// env.NAME, env['NAME'], int(env, 'NAME', ...), num('NAME', ...)
const read = new Set<string>();
for (const re of [/\benv\.([A-Z][A-Z0-9_]+)/g, /\benv\[['"]([A-Z][A-Z0-9_]+)['"]\]/g, /\bint\(env, '([A-Z][A-Z0-9_]+)'/g, /\bnum\('([A-Z][A-Z0-9_]+)'/g]) {
  for (const m of source.matchAll(re)) read.add(m[1]!);
}
const named = new Set([...example.matchAll(/^#? ?([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]!));

test('the scan finds the variables it should (a scan that finds nothing proves nothing)', () => {
  for (const v of ['INFERENCE_API_KEY', 'WEB_LIMIT_PER_HOUR', 'AGENT_MAX_STEPS', 'WEB_PORT']) assert.ok(read.has(v), v);
});

test('every variable the code reads is in web.env.example', () => {
  assert.deepEqual([...read].filter((v) => !named.has(v)).sort(), []);
});

test('web.env.example names only variables the code reads', () => {
  assert.deepEqual([...named].filter((v) => !read.has(v)).sort(), []);
});

test('every variable is described in docs/configuration.md', () => {
  assert.deepEqual([...read].filter((v) => !config.includes(`\`${v}\``)).sort(), []);
});

test('the example carries no key', () => {
  assert.match(example, /^INFERENCE_API_KEY=$/m);
});
