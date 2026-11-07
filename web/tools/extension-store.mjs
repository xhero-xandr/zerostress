// The Chrome Web Store package: build/extension without the manifest's "key". The store refuses that field and gives
// the item its own id; the key stays in the unpacked build (GitHub release), so its id stays the one we know.
// Usage: node web/tools/extension-store.mjs <out.zip>   (after `npm run build:extension` in web/client)
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const out = resolve(process.argv[2] ?? 'zerostress-extension-store.zip');
const src = resolve(import.meta.dirname, '../../build/extension');
const dir = mkdtempSync(join(tmpdir(), 'zs-store-'));
try {
  cpSync(src, dir, { recursive: true });
  const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  delete m.key;
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(m, null, 2) + '\n');
  rmSync(out, { force: true });
  execFileSync('zip', ['-qr', out, '.'], { cwd: dir });
  console.log(out);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
