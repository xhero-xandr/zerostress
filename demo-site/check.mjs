// Checks the demo pages with the real collector (a local Chromium) and the real verdict rules, before they are put on a
// public host. A small server stands in for the host: it reads _redirects and _headers the way Cloudflare Pages does.
//
//   cd collector && npx playwright install --only-shell chromium   (once)
//   node demo-site/check.mjs
//
// This shows what the rules make of each page. It does not replace one run through the public host, which is the last step.
import { readFileSync, existsSync, statSync } from 'node:fs';
import http from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanOnce } from '../collector/test/helpers.mjs';
import { analyze } from '../web/agent/signals.ts';
import { createGuardedHooks } from '../web/hooks/index.ts';

const root = fileURLToPath(new URL('.', import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.exe': 'application/octet-stream' };

const redirects = readFileSync(join(root, '_redirects'), 'utf8').split('\n').map((l) => l.trim().split(/\s+/)).filter((p) => p.length >= 2 && !p[0].startsWith('#'))
  .map(([from, to, status]) => ({ from, to, status: Number(status ?? 301) }));

// _headers: a path line, then indented "Name: value" lines
const rules = [];
for (const line of readFileSync(join(root, '_headers'), 'utf8').split('\n')) {
  if (/^\S/.test(line)) rules.push({ path: line.trim(), headers: {} });
  else if (line.trim() && rules.length) { const i = line.indexOf(':'); rules.at(-1).headers[line.slice(0, i).trim()] = line.slice(i + 1).trim(); }
}
const matches = (pat, path) => (pat.endsWith('/*') || pat === '/*' ? path.startsWith(pat.slice(0, -1)) : pat === path);

function start() {
  const server = http.createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const r = redirects.find((x) => x.from === path);
    if (r) { res.writeHead(r.status, { location: r.to }); return res.end(); }
    let file = normalize(join(root, path));
    if (!file.startsWith(root)) { res.writeHead(404); return res.end(); }
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
    if (!existsSync(file) || /(^|\/)(check\.mjs|README\.md)$/.test(file)) { res.writeHead(404); return res.end('not found'); }
    const headers = { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' };
    for (const rule of rules) if (matches(rule.path, path)) Object.assign(headers, Object.fromEntries(Object.entries(rule.headers).map(([k, v]) => [k.toLowerCase(), v])));
    res.writeHead(200, headers);
    res.end(readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) })));
}

// The local server speaks http on an address, so it also earns these; a public host would not.
const ENVIRONMENT = new Set(['lookalike_host', 'no_tls', 'password_over_http']);
// [path, exactly the signals the page itself is meant to earn, whether the injection detectors must fire]
const CASES = [
  ['/safe/', [], false],
  ['/login/', ['password_form_cross_origin'], false],
  ['/start', ['password_form_cross_origin'], false],
  ['/assistant-note/', ['hidden_text'], true],
  ['/files/', [], false],
];

const site = await start();
let failed = 0;
try {
  for (const [path, expected, injection] of CASES) {
    const r = await scanOnce(`${site.origin}${path}`);
    if (r.code !== 0) { console.log(`FAIL  ${path}: collector exit ${r.code} ${String(r.stderr()).slice(0, 300)}`); failed++; continue; }
    const events = r.raw.map((l) => (typeof l === 'string' ? JSON.parse(l) : l));
    const a = analyze(events);
    const hooks = createGuardedHooks();
    for (const e of events) await hooks.inspect(e);
    const fired = hooks.state().triggered;
    await hooks.close();
    const ids = a.signals.map((s) => s.id).filter((id) => !ENVIRONMENT.has(id));
    const problems = [
      ...expected.filter((s) => !ids.includes(s)).map((s) => `missing ${s}`),
      ...ids.filter((s) => !expected.includes(s)).map((s) => `unexpected ${s}`),
      ...(fired !== injection ? [`injection detectors ${fired ? 'fired' : 'did not fire'}, wanted the opposite`] : []),
    ];
    console.log(`${problems.length ? 'FAIL' : 'PASS'}  ${path}  signals=${ids.join(',') || '-'}  injection=${fired}${problems.length ? `  <- ${problems.join('; ')}` : ''}`);
    if (problems.length) failed++;
  }
} finally {
  await site.close();
}
console.log(failed ? `${failed} page(s) do not behave as intended` : 'all demo pages behave as intended');
process.exit(failed ? 1 : 0);
