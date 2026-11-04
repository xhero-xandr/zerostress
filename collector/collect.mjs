// ZeroStress evidence collector (spec 005). Runs inside the guest microVM as an unprivileged user.
// Contract: the job (JSON) on the first stdin line, evidence events (NDJSON) on stdout. With a "session" in the job the
// collector stays alive after the scan and executes one command per stdin line (lib/session.mjs).
// Exit codes: 0 done, 2 bad job, 3 browser or navigation failure.
import { createInterface } from 'node:readline';
import { chromium } from 'playwright';
import { createEmitter } from './lib/emitter.mjs';
import { JobError, parseJob } from './lib/job.mjs';
import { LIMITS, cut } from './lib/limits.mjs';
import { VIEWPORT, runScan } from './lib/scan.mjs';
import { runSession } from './lib/session.mjs';

const ARTIFACT_DIR = process.env.ZS_ARTIFACT_DIR || '/run/zerostress/artifacts';
const emitter = createEmitter(process.stdout);

async function finish(code) {
  await emitter.flush().catch(() => {});
  process.exit(code);
}

async function main() {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const lines = rl[Symbol.asyncIterator]();
  const first = await lines.next();

  let job;
  try {
    if (first.done) throw new JobError('no job on stdin');
    job = parseJob(first.value);
  } catch (err) {
    emitter.emit('error', { code: 'bad_job', message: cut(err instanceof JobError ? err.message : 'invalid job', LIMITS.errorChars) });
    return finish(2);
  }

  let browser;
  let code = 0;
  let closing = false; // closing the browser on purpose is not a crash
  try {
    browser = await chromium.launch({ headless: true, chromiumSandbox: true });
    const context = await browser.newContext({
      viewport: VIEWPORT, acceptDownloads: false, serviceWorkers: 'block', permissions: [], locale: 'en-US',
    });
    const page = await context.newPage();
    let crashed = false;
    const onCrash = () => {
      if (crashed || closing) return;
      crashed = true;
      emitter.emit('error', { code: 'browser_crashed', message: 'the browser or the page died' });
      finish(3);
    };
    page.on('crash', onCrash);
    browser.on('disconnected', onCrash);

    const scan = await runScan({ job, browser, context, page, emitter, artifactDir: ARTIFACT_DIR });
    let sessionEnd = null;
    if (job.session) {
      sessionEnd = await runSession({ job, context, page, lines, rl, emitter, scan, artifactDir: ARTIFACT_DIR });
    }
    scan.tracker.finish();
    emitter.emit('summary', summary(scan, sessionEnd));
  } catch (err) {
    emitter.emit('error', { code: 'collector_failed', message: cut(err?.message ?? err, LIMITS.errorChars) });
    code = 3;
  } finally {
    closing = true;
    rl.close();
    process.stdin.destroy();
    if (browser) await Promise.race([browser.close().catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);
  }
  return finish(code);
}

function summary(scan, sessionEnd) {
  const s = scan.tracker.stats;
  const truncated = [];
  if (s.requestsDropped) truncated.push('request');
  if (s.consoleDropped) truncated.push('console');
  const dropped = emitter.dropped();
  truncated.push(...Object.keys(dropped));
  return {
    final_url: cut(scan.finalUrl, LIMITS.urlChars),
    nav_error: scan.navError,
    counts: { ...emitter.counts(), requests_seen: s.requests, blocked: s.blocked, dialogs: s.dialogs, downloads: s.downloads, popups: s.popups },
    truncated: [...new Set(truncated)],
    dropped,
    ...(sessionEnd ? { session_end: sessionEnd } : {}),
    duration_ms: emitter.elapsed(),
  };
}

main().catch((err) => {
  emitter.emit('error', { code: 'collector_failed', message: cut(err?.message ?? err, LIMITS.errorChars) });
  finish(3);
});
