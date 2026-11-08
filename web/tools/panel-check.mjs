// One real deep check through the browser extension, the way a person does it: load build/extension in Chromium, tick
// "Let the agent act on the page", check a link in the side panel, answer the approval (Allow or Don't allow), and
// wait for the verdict. Screenshots and a summary go to build/e2e/panel/. Counts against the site's limits.
//
//   cd web/client && npm run build:extension
//   node web/tools/panel-check.mjs [link] [allow|deny]
//     default link: https://zerostress.space/demo/shared-file (offers a harmless file), default answer: allow
//
// Run it as the owner of the checkout (Chromium refuses to sandbox itself as root). It needs Playwright's Chromium:
// `npx playwright install chromium` in guest/collector, once. On the server itself, ZS_ORIGIN=127.0.0.1 talks to the local
// Caddy instead of going out through Cloudflare (which may challenge the server's own address).
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from '../../guest/collector/node_modules/playwright/index.mjs';

const [link = 'https://zerostress.space/demo/shared-file', answer = 'allow'] = process.argv.slice(2);
const root = resolve(import.meta.dirname, '../..');
const ext = join(root, 'build/extension');
const out = join(root, 'build/e2e/panel');
mkdirSync(out, { recursive: true });
const profile = mkdtempSync(join(tmpdir(), 'zs-panel-'));
const ctx = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, ...(process.env.ZS_ORIGIN ? [`--host-resolver-rules=MAP zerostress.space ${process.env.ZS_ORIGIN}`] : [])] });
try {
  const sw = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent('serviceworker', { timeout: 15000 });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(String(e)));
  await p.setViewportSize({ width: 400, height: 900 });
  await p.goto(`chrome-extension://${new URL(sw.url()).host}/sidepanel.html`);
  const f = p.frameLocator('#agent');
  await f.getByRole('checkbox').check({ timeout: 90000 });
  await f.getByLabel('Message to the agent').fill(link);
  await f.getByRole('button', { name: /^(Check|Send)$/ }).click();
  const t0 = Date.now();
  const s = () => `${Math.round((Date.now() - t0) / 1000)} s`;
  const dlg = f.getByRole('alertdialog').first();
  const first = await Promise.race([
    dlg.waitFor({ timeout: 240000 }).then(() => 'approval'),
    f.getByText(/^Verdict:/).waitFor({ timeout: 240000 }).then(() => 'verdict'),
    f.getByText(/hourly limit|try again|already have a check/).waitFor({ timeout: 240000 }).then(() => 'refused'),
  ]);
  console.log(`after ${s()}: ${first}`);
  if (first === 'refused') { console.log(await f.locator('main').innerText()); process.exitCode = 2; }
  else {
    if (first === 'approval') {
      console.log('asked:', (await dlg.textContent()).replace(/(Allow|Don’t allow)/g, ' [$1]'));
      await p.screenshot({ path: join(out, 'approval.png') });
      await dlg.getByRole('button', { name: answer === 'allow' ? 'Allow' : 'Don’t allow', exact: true }).click();
      await f.getByText(/^Verdict:/).waitFor({ timeout: 240000 });
    }
    console.log(await f.getByText(/^Verdict:/).textContent(), `(${s()})`);
    for (const l of await f.locator('ol li').allTextContents()) if (/gatekeeper|approv|download|inside the sandbox/i.test(l)) console.log('  ', l);
    // a wall: the server asks Cloudflare on its own, and the panel tells its answer when it comes
    if (/unknown/.test(await f.getByText(/^Verdict:/).first().textContent())) {
      const so = f.getByText(/Cloudflare’s scanner (scanned it now|had scanned it recently)|could not answer|Today's new scans/).first();
      await so.waitFor({ timeout: 150000 }).then(async () => console.log('second opinion:', await so.textContent(), `(${s()})`), () => console.log('second opinion: none in time'));
    }
    await p.waitForTimeout(4000);
    await p.screenshot({ path: join(out, 'final.png') });
    console.log(`screenshots: ${out}; page errors: ${errors.length ? errors.join(' | ') : 'none'}`);
  }
} finally {
  await ctx.close();
  rmSync(profile, { recursive: true, force: true });
}
