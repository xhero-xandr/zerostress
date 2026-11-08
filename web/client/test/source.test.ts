/// <reference types="node" />
// The client never turns text into markup or runs text as code (it was a search over app.js before spec 012). React
// escapes text by itself; these are the ways around it, and none may appear in the sources.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

// vitest runs from web/client
const SRC = join(process.cwd(), 'src') + '/';
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e): string[] => (e.isDirectory() ? files(join(dir, e.name)) : /\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [join(dir, e.name)] : []));

const FORBIDDEN = ['dangerouslySetInnerHTML', 'innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function', 'setTimeout("', "setTimeout('", 'javascript:', 'localStorage.setItem(KEY, key', 'sessionStorage'];

test('no source of the client writes markup, runs text or keeps the task key (but task-key.ts, in this tab only)', () => {
  const all = files(SRC);
  expect(all.length).toBeGreaterThan(5);
  for (const f of all) {
    const text = readFileSync(f, 'utf8');
    // the owner's key leaves the address and stays with the tab (spec 012, 8 November 2026): there, and only there
    const allowed = f.endsWith('/task-key.ts') ? ['sessionStorage'] : [];
    for (const bad of FORBIDDEN) if (!allowed.includes(bad)) expect(text.includes(bad), `${f.slice(SRC.length)}: ${bad}`).toBe(false);
  }
  const keeper = readFileSync(join(SRC, 'task-key.ts'), 'utf8');
  expect(keeper).not.toMatch(/localStorage/);
  expect(keeper.match(/sessionStorage\.(\w+)/g)?.sort()).toEqual(['sessionStorage.getItem', 'sessionStorage.setItem']);
});

test('the task key is read only from the fragment (then kept by the tab) and sent only in its header', () => {
  const api = readFileSync(join(SRC, 'api.ts'), 'utf8');
  expect(api).toMatch(/'x-task-key': key/);
  for (const f of files(SRC)) {
    const text = readFileSync(f, 'utf8');
    expect(/[?&]k=|key=\$\{|\$\{key\}/.test(text.replace(/hash: `k=\$\{key\}`/g, '')), `${f.slice(SRC.length)} puts the key in an address`).toBe(false);
  }
});
