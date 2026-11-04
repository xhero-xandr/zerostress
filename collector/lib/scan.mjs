import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LIMITS, cut } from './limits.mjs';
import { sha256 } from './emitter.mjs';
import { probePage, shapeProbe } from './extract.mjs';
import { takeSnapshot, withOrigins } from './snapshot.mjs';
import { attachTracker } from './tracker.mjs';

export const VIEWPORT = Object.freeze({ width: 1280, height: 800 });

/** Short, stable code for a failed navigation (the page cannot choose it). */
export function navErrorCode(err) {
  const msg = String(err?.message ?? err);
  if (err?.name === 'TimeoutError' || /Timeout \d+ms exceeded/.test(msg)) return 'timeout';
  const net = /net::(ERR_[A-Z0-9_]+)/.exec(msg);
  if (net) return net[1];
  if (/Download is starting/.test(msg)) return 'download';
  return 'navigation_failed';
}

export const ARTIFACT_TOTAL_MAX = 32 * 1024 * 1024;

/**
 * Writes a file to the artifact directory (tmpfs of the guest) and reports it with its size and SHA-256. The bytes never
 * travel in the event stream. `state.artifactBytes` enforces the total limit of the run.
 */
export async function saveArtifact(emitter, artifactDir, state, { name, mime, data, ext }) {
  const info = { id: sha256(data).slice(0, 16), name: cut(name, 255), bytes: data.length, sha256: sha256(data), mime };
  state.artifactBytes ??= 0;
  if (state.artifactBytes + data.length > ARTIFACT_TOTAL_MAX) {
    emitter.emit('artifact', { ...info, saved: false, error: 'artifact_limit' });
    return { ...info, saved: false, error: 'artifact_limit' };
  }
  try {
    mkdirSync(artifactDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(artifactDir, `${info.id}.${ext}`), data, { mode: 0o600 });
    state.artifactBytes += data.length;
    emitter.emit('artifact', { ...info, saved: true });
    return { ...info, saved: true };
  } catch (err) {
    const error = cut(err.code ?? 'write_failed', 40).toLowerCase();
    emitter.emit('artifact', { ...info, saved: false, error });
    return { ...info, saved: false, error };
  }
}

export async function saveScreenshot(page, emitter, artifactDir, state, { full = false } = {}) {
  const png = await page.screenshot({ type: 'png', fullPage: full });
  return saveArtifact(emitter, artifactDir, state, { name: 'screenshot.png', mime: 'image/png', data: png, ext: 'png' });
}

/** Takes a snapshot and reports `snapshot` and `links`. Returns the snapshot number and the parsed links. */
export async function reportSnapshot(page, emitter, state, pageUrl) {
  const snap = await takeSnapshot(page);
  state.snap += 1;
  emitter.emit('snapshot', { snap: state.snap, text: snap.text, lines: snap.lines, truncated: snap.truncated });
  const links = withOrigins(snap.links, pageUrl);
  emitter.emit('links', { snap: state.snap, links });
  return { snap: state.snap, links };
}

/** Reports `page` and `forms` from the isolated-world probe. */
export async function reportPage(cdp, emitter, frameId, pageUrl) {
  const raw = await probePage(cdp, frameId);
  const shaped = shapeProbe(raw, pageUrl);
  emitter.emit('page', shaped.page);
  emitter.emit('forms', shaped.forms);
  return shaped;
}

/**
 * The autonomous pass: open the address, follow whatever the page does by itself, then report what was found.
 * Returns the facts the session loop and the summary need.
 */
export async function runScan({ job, browser, context, page, emitter, artifactDir }) {
  const cdp = await context.newCDPSession(page);
  const tracker = await attachTracker({ page, context, cdp, emitter });
  const state = { snap: 0, artifactBytes: 0 };

  emitter.emit('nav', { via: 'requested', from: '', to: cut(job.url, LIMITS.urlChars) });
  let navError = null;
  try {
    await page.goto(job.url, { timeout: job.navTimeoutS * 1000, waitUntil: 'load' });
  } catch (err) {
    navError = navErrorCode(err);
  }
  if (!navError) {
    await page.waitForLoadState('networkidle', { timeout: LIMITS.settleMs }).catch(() => {});
    await tracker.waitForScheduled();
  }

  const finalUrl = page.url();
  const loaded = !navError && /^https?:/i.test(finalUrl);
  let links = [];
  let artifact = null;
  if (loaded) {
    await reportPage(cdp, emitter, tracker.mainFrameId(), finalUrl);
    const s = await reportSnapshot(page, emitter, state, finalUrl);
    links = s.links;
    artifact = await saveScreenshot(page, emitter, artifactDir, state);
  }
  return { cdp, tracker, state, navError, finalUrl, loaded, links, artifact };
}
