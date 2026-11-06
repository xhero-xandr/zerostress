import { LIMITS, cut } from './limits.mjs';
import { probePage, shapeProbe } from './extract.mjs';
import { saveArtifact } from './scan.mjs';

// The same address as a phone and as a tablet would open it. Phishing often shows its real face only to a phone, and a
// harmless page to a desktop robot (spec 005, 3.7). Each device is a fresh browser context: no cookies from the first
// visit, so the page sees a new visitor. The user agents are fixed strings of the same Chrome, not copies of any visitor.
export const DEVICES = Object.freeze({
  mobile: Object.freeze({
    viewport: { width: 412, height: 839 },
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Mobile Safari/537.36',
  }),
  tablet: Object.freeze({
    viewport: { width: 820, height: 1180 },
    userAgent: 'Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36',
  }),
});

const DEVICE_TIMEOUT_MS = 45_000;

/** Opens the job's address as one device and reports `device` (and a screenshot). Never throws: a failure is a result. */
async function captureOne(name, spec, { browser, job, emitter, artifactDir, state }) {
  const base = { device: name, viewport: spec.viewport };
  let context;
  try {
    context = await browser.newContext({
      viewport: spec.viewport, userAgent: spec.userAgent, isMobile: true, hasTouch: true, deviceScaleFactor: 1,
      acceptDownloads: false, serviceWorkers: 'block', permissions: [], locale: 'en-US',
    });
    let opened = 0;
    // the first page is ours; anything the site opens by itself is closed at once
    context.on('page', (p) => { if (++opened > 1) p.close().catch(() => {}); });
    const page = await context.newPage();
    let navError = null;
    try {
      await page.goto(job.url, { timeout: Math.min(job.navTimeoutS, 20) * 1000, waitUntil: 'load' });
      await page.waitForLoadState('networkidle', { timeout: 2000 }).catch(() => {});
    } catch (err) {
      navError = /Timeout/.test(String(err?.message)) ? 'timeout' : (/net::(ERR_[A-Z0-9_]+)/.exec(String(err?.message))?.[1] ?? 'navigation_failed');
    }
    const finalUrl = page.url();
    if (navError || !/^https?:/i.test(finalUrl)) {
      emitter.emit('device', { ...base, final_url: cut(finalUrl, LIMITS.urlChars), nav_error: navError ?? 'not_http', file: null });
      return;
    }
    const cdp = await context.newCDPSession(page);
    const frameId = (await cdp.send('Page.getFrameTree')).frameTree.frame.id;
    const shaped = shapeProbe(await probePage(cdp, frameId), finalUrl);
    const forms = shaped.forms.forms ?? [];
    const png = await page.screenshot({ type: 'png' });
    const art = await saveArtifact(emitter, artifactDir, state, { name: `screenshot-${name}.png`, mime: 'image/png', data: png, ext: 'png' });
    emitter.emit('device', {
      ...base, final_url: cut(finalUrl, LIMITS.urlChars), nav_error: null, title: shaped.page.title,
      forms: forms.length, has_password: forms.some((f) => f.has_password === true) || shaped.forms.loose_password_fields > 0,
      action_origins: [...new Set(forms.map((f) => cut(String(f.action_origin ?? ''), 300)).filter(Boolean))].slice(0, 5),
      text_chars: shaped.page.text.length, file: art.saved ? art.file : null,
    });
  } catch (err) {
    emitter.emit('device', { ...base, final_url: '', nav_error: 'capture_failed', file: null });
  } finally {
    if (context) await Promise.race([context.close().catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);
  }
}

export async function captureDevices(ctx) {
  for (const [name, spec] of Object.entries(DEVICES)) {
    await Promise.race([captureOne(name, spec, ctx), new Promise((r) => setTimeout(r, DEVICE_TIMEOUT_MS))]);
  }
}
