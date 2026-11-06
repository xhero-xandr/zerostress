// Records what the real collector reports for the injection pages, as fixtures for the hooks (web/hooks, spec 009).
// Run by hand after changing the pages or the collector: node test/capture-fixtures.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startPages } from './pages.mjs';
import { scanOnce } from './helpers.mjs';

const hooksOut = fileURLToPath(new URL('../../../web/hooks/test/fixtures/', import.meta.url));
const agentOut = fileURLToPath(new URL('../../../web/agent/test/fixtures/', import.meta.url));
mkdirSync(hooksOut, { recursive: true });
mkdirSync(agentOut, { recursive: true });
const pages = await startPages();
try {
  // [fixture, path, directory]: the injection pages feed the hooks (009), the others the verdict rules (008)
  const wanted = [
    ['inject', '/inject', hooksOut], ['inject-places', '/inject-places', hooksOut], ['inject-download', '/inject-download', hooksOut], ['benign', '/', hooksOut],
    ['login', '/login', agentOut], ['chain', '/r1', agentOut], ['meta-refresh', '/meta', agentOut], ['script-redirect', '/js', agentOut],
    ['hidden', '/hidden', agentOut], ['auto-download', '/autodownload', agentOut], ['popups', '/popups', agentOut], ['dialog', '/dialog', agentOut],
    ['schemes', '/schemes', agentOut], ['many-requests', '/many', agentOut], ['plain', '/', agentOut], ['unreachable', '://refused', agentOut],
  ];
  for (const [name, path, out] of wanted) {
    const url = path === '://refused' ? 'http://127.0.0.1:1/' : `${pages.origin}${path}`;
    const r = await scanOnce(url);
    if (r.code !== 0) throw new Error(`${path}: exit ${r.code} ${r.stderr()}`);
    // addresses of the local test server are not interesting and change with the port
    const lines = r.raw.map((l) => l.split(pages.origin).join('http://page.test').split(pages.other).join('http://other.test').split('http://127.0.0.1:1').join('http://down.test'));
    writeFileSync(`${out}${name}.ndjson`, lines.join('\n') + '\n');
    console.log(name, lines.length, 'events');
  }
} finally {
  await pages.close();
}
