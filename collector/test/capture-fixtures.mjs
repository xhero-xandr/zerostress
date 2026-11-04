// Records what the real collector reports for the injection pages, as fixtures for the hooks (web/hooks, spec 009).
// Run by hand after changing the pages or the collector: node test/capture-fixtures.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startPages } from './pages.mjs';
import { scanOnce } from './helpers.mjs';

const out = fileURLToPath(new URL('../../web/hooks/test/fixtures/', import.meta.url));
mkdirSync(out, { recursive: true });
const pages = await startPages();
try {
  for (const [name, path] of [['inject', '/inject'], ['inject-places', '/inject-places'], ['inject-download', '/inject-download'], ['benign', '/']]) {
    const r = await scanOnce(`${pages.origin}${path}`);
    if (r.code !== 0) throw new Error(`${path}: exit ${r.code} ${r.stderr()}`);
    // addresses of the local test server are not interesting and change with the port
    const lines = r.raw.map((l) => l.split(pages.origin).join('http://page.test').split(pages.other).join('http://other.test'));
    writeFileSync(`${out}${name}.ndjson`, lines.join('\n') + '\n');
    console.log(name, lines.length, 'events');
  }
} finally {
  await pages.close();
}
