// The built client behind the real web layer (web/server/app.ts with stand-ins for the supervisor and the model), driven
// in a real Chromium through what a person does: start a check, watch it, read every section, ask Explain, decide as
// the owner, look as a visitor without the key, both themes, a phone. Every step counts CSP violations and requests to
// other origins; both must stay at zero. Screenshots go to mockups/ for review.
//
//   npm run build && node e2e-check.mjs        (as a non-root user: Chromium's own sandbox stays on)
import { serve } from '@hono/node-server';
import { mkdirSync } from 'node:fs';
import { crc32, deflateSync } from 'node:zlib';
import { chromium } from '../../collector/node_modules/playwright/index.mjs';
import { createApp } from '../server/app.ts';
import { createLimiter, DEFAULT_LIMITS } from '../server/limits.ts';
import { createStore } from '../server/store.ts';

const PORT = Number(process.env.PORT ?? 8097);
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = new URL('./mockups/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const EVIL = '"><img src=x onerror=alert(1)><script>alert(1)</script>';

/** A real PNG (the server checks the signature), a calm grey page with a darker bar. */
function png(w, h) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = (y) => Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, y < h / 8 ? 0x55 : 0xe5)]);
  const raw = Buffer.concat(Array.from({ length: h }, (_, y) => row(y)));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const result = {
  schema: 1, run_id: '11111111-2222-4333-8444-555555555555', url: `https://login.northwind-mail.example/start?session=8f2c&x=${EVIL}`, state: 'done', failure: null,
  assessment: {
    verdict: 'malicious', confidence: 0.9, mode: 'text', mode_reason: null,
    rules: { verdict: 'malicious', score: 70, confidence: 0.9, signals: [
      { id: 'password_form_cross_origin', level: 'high', text: 'The sign-in form sends the password to collect.example.org, another site.', refs: [] },
      { id: 'young_domain', level: 'medium', text: `The domain was registered 6 days ago ${EVIL}`, refs: [] },
      { id: 'redirects', level: 'low', text: 'Two redirects before the page.', refs: [] },
    ] },
    model: { verdict: 'malicious', confidence: 0.9, lowered: false },
    summary: `The page imitates a mail sign-in and sends the password to another site. ${EVIL}`, reasons: [{ claim: `The form posts to collect.example.org ${EVIL}`, evidence: [] }],
    next: null, usage: null, notes: [], versions: { ruleset: 'r', prompt: 'p', model: 'm' },
  },
  evidence_events: 40,
  facts: {
    final_host: 'login.northwind-mail.example', page_title: `Northwind Mail — Sign in ${EVIL}`,
    chain: [{ via: 'requested', host: 'go.example' }, { via: 'http', host: 'sh.example' }, { via: 'commit', host: 'login.northwind-mail.example' }],
    forms: [{ action_host: 'collect.example.org', cross_origin: true, has_password: true, asks: ['email', 'password'] }],
    tls: [{ host: 'login.northwind-mail.example', issuer: "Let's Encrypt", valid_to: '2027-01-29T00:00:00.000Z' }],
    blocked_requests: 1, third_party_hosts: 2, requests_total: 39, hosts: ['collect.example.org', 'cdn.example'],
    links: [{ text: 'Help', host: '', other_site: false, goes: 'nowhere' }, { text: `Privacy ${EVIL}`, host: 'other.example', other_site: true, goes: 'other' }],
    servers: [{ ip: '172.64.149.123', country: 'US', asn: 13335, org: `Cloudflare, Inc. ${EVIL}`, hosts: ['login.northwind-mail.example'], requests: 30 }],
    servers_total: 1,
    domain: { name: 'northwind-mail.example', created: '2026-10-31T00:00:00.000Z', age_days: 6, registrar: `Example Registrar ${EVIL}` },
    devices: [{ device: 'mobile', nav_error: null, final_host: 'login.northwind-mail.example', title: 'Northwind Mail', forms: 1, has_password: true, action_hosts: ['collect.example.org'], differs: [], image: true },
      { device: 'tablet', nav_error: null, final_host: 'login.northwind-mail.example', title: 'Northwind Mail', forms: 1, has_password: true, action_hosts: ['collect.example.org'], differs: [], image: true }],
    hidden_text: false, popups: 0, dialogs: 0, downloads: [],
  },
  hooks: { triggered: false, findings: [], ruleset: 'x' },
  steps: [], refused: [],
  pending_approval: [{ command_id: 'cmd-1', cmd: 'submit_form', sha256: 'b'.repeat(64) }],
  artifacts: [{ name: 'aaaaaaaaaaaaaaaa.png', bytes: 1, sha256: 'a'.repeat(64), mime: 'image/png' }, { name: 'bbbbbbbbbbbbbbbb.png', bytes: 1, sha256: 'a'.repeat(64), mime: 'image/png' }, { name: 'cccccccccccccccc.png', bytes: 1, sha256: 'a'.repeat(64), mime: 'image/png' }],
  shots: { desktop: 'aaaaaaaaaaaaaaaa.png', mobile: 'bbbbbbbbbbbbbbbb.png', tablet: 'cccccccccccccccc.png' },
  timeline: [], notes: [],
};

const SHOTS = { 'aaaaaaaaaaaaaaaa.png': png(1280, 800), 'bbbbbbbbbbbbbbbb.png': png(412, 839), 'cccccccccccccccc.png': png(820, 1180) };
const approvals = [];
const app = createApp({
  run: (_input, onProgress) => new Promise((resolve) => {
    onProgress({ kind: 'state', state: 'queued', position: 1 });
    setTimeout(() => onProgress({ kind: 'state', state: 'running', position: null }), 300);
    setTimeout(() => resolve(result), 1500);
  }),
  fetchShot: async (_run, name) => SHOTS[name],
  approve: async (...a) => { approvals.push(a); },
  cancel: async () => {},
  chat: { reply: async (_r, input) => ({ text: input.kind === 'explain' ? `Explained: the form sends your password to another site. ${EVIL}` : `Answered: ${input.message}`, source: 'model', reason: null }) },
  store: createStore(null),
  limiter: createLimiter({ ...DEFAULT_LIMITS, perHour: 100, active: 5 }),
  demos: [{ label: 'A fake sign-in page', url: 'https://login.northwind-mail.example/start' }],
  session: { idle_s: 30, max_s: 120 },
  clientIp: () => '203.0.113.7',
});
const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: PORT });

const problems = [];
const check = (ok, what) => { if (!ok) problems.push(what); console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`); };
const browser = await chromium.launch({ chromiumSandbox: true });

async function open(viewport) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: viewport.width < 500 ? 2 : 1 });
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  page.foreign = [];
  page.on('request', (r) => { if (new URL(r.url()).origin !== BASE) page.foreign.push(r.url()); });
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  return { ctx, page };
}
const clean = async (page, what) => {
  const v = await page.evaluate(() => window.__csp.splice(0));
  check(v.length === 0 && page.foreign.length === 0, `${what}: no CSP violation, no request elsewhere${v.length ? ' — ' + v.join(', ') : ''}${page.foreign.length ? ' — ' + page.foreign.join(', ') : ''}`);
  const injected = await page.evaluate(() => [...document.querySelectorAll('img')].filter((i) => !i.getAttribute('src')?.startsWith('/r/')).length + document.querySelectorAll('[onerror]').length);
  check(injected === 0, `${what}: hostile text stayed text`);
};
const shot = (page, name, fullPage = true) => page.screenshot({ path: `${OUT}${name}.png`, fullPage });

try {
  // ---- the owner: start a check, watch it, read the report ----
  const { ctx, page } = await open({ width: 1280, height: 900 });
  await page.goto(`${BASE}/`);
  await page.getByRole('heading', { level: 1 }).waitFor();
  await shot(page, 'e2e-01-home-light');
  await clean(page, 'home');
  await page.getByRole('button', { name: 'A fake sign-in page' }).click();
  check((await page.getByLabel('Link to check').inputValue()) === 'https://login.northwind-mail.example/start', 'an example fills the field');
  await page.getByRole('button', { name: 'Check link' }).click();
  await page.waitForURL(/\/r\/[0-9a-f]{32}#k=/);
  const reportUrl = page.url();
  const id = /\/r\/([0-9a-f]{32})/.exec(reportUrl)[1];
  await page.getByText('Checking the link').waitFor();
  await shot(page, 'e2e-02-progress');
  await page.getByRole('heading', { level: 1, name: 'Dangerous' }).waitFor({ timeout: 10_000 });
  check(true, 'progress turns into the report by itself (stream, then state)');
  await shot(page, 'e2e-03-report-summary-light');
  await clean(page, 'report summary');
  const linksToChecked = await page.evaluate(() => [...document.querySelectorAll('a[href]')].filter((a) => /example/.test(a.getAttribute('href'))).length);
  check(linksToChecked === 0, 'no address from the report is a link');
  check(await page.getByText('The agent needs your decision').isVisible(), 'the owner sees the decision');

  for (const [tab, heading] of [['Security', 'The domain'], ['Network', 'Servers it talked to'], ['Links', 'Links on the page'], ['Behavior', 'What the agent did']]) {
    await page.getByRole('link', { name: tab, exact: true }).click();
    await page.getByRole('heading', { name: heading }).waitFor();
    check(new URL(page.url()).hash.startsWith('#k='), `${tab}: the key stays in the fragment`);
    await shot(page, `e2e-04-tab-${tab.toLowerCase()}`);
    await clean(page, `tab ${tab}`);
  }
  await page.getByRole('link', { name: 'Summary', exact: true }).click();

  await page.getByRole('button', { name: 'Explain' }).click();
  await page.locator('dialog[open]').getByText(/Explained:/).waitFor();
  await page.getByLabel('Ask about this report').fill('Who owns the site?');
  await page.getByRole('button', { name: 'Ask' }).click();
  await page.getByText('Answered: Who owns the site?').waitFor();
  await shot(page, 'e2e-05-explain', false);
  await clean(page, 'Explain');
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'Download' }).click();
  await page.getByRole('menuitem', { name: 'Report (JSON)' }).waitFor();
  await shot(page, 'e2e-06-download-menu', false);
  await clean(page, 'Download menu');
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'Phone' }).click();
  check((await page.locator('img[src*="screenshot.png?device=mobile"]').count()) === 1, 'the phone screenshot is shown on demand');

  await page.getByRole('button', { name: 'Allow', exact: true }).click();
  await page.getByText(/Allowed\. The agent is carrying it out/).waitFor();
  check(approvals.length === 1 && approvals[0][1] === 'cmd-1', 'the owner allows the very command that was shown');

  await page.getByRole('button', { name: 'Dark' }).click();
  check((await page.evaluate(() => document.documentElement.getAttribute('data-theme'))) === 'dark', 'the dark theme is chosen');
  const darkBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  check(darkBg === 'rgb(11, 18, 32)', `the chosen dark theme is really dark (${darkBg})`);
  await shot(page, 'e2e-07-report-summary-dark');
  await clean(page, 'dark theme');
  await page.reload();
  await page.getByRole('heading', { level: 1, name: 'Dangerous' }).waitFor();
  check((await page.evaluate(() => document.documentElement.getAttribute('data-theme'))) === 'dark', 'the choice is remembered');
  await page.goto(`${BASE}/`);
  await shot(page, 'e2e-08-home-dark');
  await page.getByRole('button', { name: 'Light' }).click();
  const lightBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  check(lightBg === 'rgb(248, 250, 252)', `the chosen light theme is really light (${lightBg})`);
  await page.getByRole('button', { name: 'System' }).click();
  check((await page.evaluate(() => document.documentElement.hasAttribute('data-theme'))) === false, '"System" leaves it to the system');
  await ctx.close();

  // ---- the system asks for dark, nothing chosen ----
  const sys = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'dark' });
  const sp = await sys.newPage();
  await sp.goto(`${BASE}/`);
  const bg = await sp.evaluate(() => getComputedStyle(document.body).backgroundColor);
  check(bg === 'rgb(11, 18, 32)', `a dark system gives the dark theme without a choice (${bg})`);
  await sys.close();

  // ---- a visitor with the shared link (no key), and a phone ----
  const { ctx: vctx, page: v } = await open({ width: 390, height: 844 });
  await v.goto(reportUrl.split('#')[0]);
  await v.getByRole('heading', { level: 1, name: 'Dangerous' }).waitFor();
  check(await v.getByText('The person who started this check can decide here.').isVisible(), 'a visitor is told who decides');
  check((await v.getByRole('button', { name: 'Allow', exact: true }).count()) === 0, 'a visitor gets no buttons to decide');
  await shot(v, 'e2e-09-report-phone');
  await clean(v, 'phone, visitor');
  await v.goto(`${BASE}/r/${'f'.repeat(32)}`);
  await v.getByRole('heading', { name: 'Report not found' }).waitFor();
  await v.goto(`${BASE}/r/${id}/nope`);
  await v.getByRole('heading', { name: 'Report not found' }).waitFor();
  check(true, 'an unknown report and an unknown section say "not found"');
  await clean(v, 'not found');
  await vctx.close();
} catch (e) {
  problems.push(`step failed: ${e.message.split('\n')[0]}`);
  console.log(`FAIL  ${e.message.split('\n')[0]}`);
} finally {
  await browser.close();
  server.close();
}
console.log(problems.length ? `E2E FAILED: ${problems.length} problem(s)` : `E2E OK, screenshots in ${OUT}`);
process.exit(problems.length ? 1 : 0);
