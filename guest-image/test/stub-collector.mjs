// Test double for the evidence collector (spec 005 replaces it). Contract: job JSON on the first stdin line,
// NDJSON events on stdout. A job with a "session" object keeps stdin open and delivers one command per line.
// Modes: default (hello), "fetch" (HTTP GET of job.url), "sleep", "flood", "whoami", "chromium", "sys", "session".
// For the supervisor (which sends kind:"url") the mode rides in the URL: ?stub=session&hang_on=wait (see below).
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
const lines = rl[Symbol.asyncIterator]();
const first = await lines.next();
if (first.done) { console.error('no job on stdin'); process.exit(2); }
const job = JSON.parse(first.value);
const emit = (o) => process.stdout.write(JSON.stringify(o) + '\n');

// The supervisor sends {kind:"url", url}. For tests the mode can ride in the URL: ?stub=sleep&ms=20000
// (stub=fetch is the default, i.e. a plain GET of the URL). Smoke tests set job.mode directly.
let mode = job.mode;
if (!mode && job.kind === 'url') {
  const u = new URL(job.url);
  mode = u.searchParams.get('stub') ?? 'fetch';
  if (u.searchParams.has('ms')) job.ms = Number(u.searchParams.get('ms'));
  if (u.searchParams.has('hang_on')) job.hang_on = u.searchParams.get('hang_on');
}
mode ??= 'hello';

emit({ type: 'event', kind: 'started', mode, uid: process.getuid() });

const PAGE = '<title>Sign in</title><h1>Sign in</h1><a href="https://example.com/x">Reset password</a>' +
  '<button>Go</button><label>Email <input type="email"></label><p style="display:none">hidden text</p>';

function memInfoMib() {
  const m = {};
  for (const l of readFileSync('/proc/meminfo', 'utf8').split('\n')) {
    const [k, v] = l.split(':');
    if (v) m[k] = parseInt(v, 10) / 1024;
  }
  return m;
}

// Proportional set size of every browser process, so shared pages are counted once.
function browserPssMib() {
  let kib = 0;
  for (const pid of readdirSync('/proc')) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      if (!/chrom|headless/i.test(readFileSync(`/proc/${pid}/comm`, 'utf8'))) continue;
      const m = /^Pss:\s+(\d+)/m.exec(readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8'));
      if (m) kib += Number(m[1]);
    } catch { /* the process went away between listing and reading */ }
  }
  return Math.round(kib / 1024);
}

switch (mode) {
  case 'fetch': {
    try {
      const r = await fetch(job.url, { redirect: 'manual', signal: AbortSignal.timeout(job.timeout_ms ?? 5000) });
      emit({ type: 'event', kind: 'response', url: job.url, status: r.status });
    } catch (e) {
      emit({ type: 'event', kind: 'error', url: job.url, error: String(e.cause?.code ?? e.message) });
    }
    break;
  }
  case 'chromium': {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ chromiumSandbox: true });
    try {
      const page = await browser.newPage();
      await page.goto(job.url ?? 'data:text/html;charset=utf-8,<title>ok</title><h1>Привет, мир 日本語 😀</h1>');
      const png = await page.screenshot();
      emit({
        type: 'event', kind: 'chromium', version: browser.version(), title: await page.title(),
        screenshot_bytes: png.length, ...(job.png ? { png_b64: png.toString('base64') } : {}),
      });
    } finally {
      await browser.close();
    }
    break;
  }
  case 'sys': {
    // guest clock and listening TCP sockets (state 0A = LISTEN)
    const listeners = [];
    for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) {
      for (const l of readFileSync(f, 'utf8').split('\n').slice(1)) {
        const c = l.trim().split(/\s+/);
        if (c[3] === '0A') listeners.push(c[1]);
      }
    }
    emit({ type: 'event', kind: 'sys', epoch_ms: Date.now(), tcp_listeners: listeners });
    break;
  }
  case 'sleep':
    await new Promise((r) => setTimeout(r, job.ms ?? 1000));
    break;
  case 'flood': {
    // honour backpressure, otherwise Node buffers the whole flood in memory and the VM runs out of RAM
    const line = JSON.stringify({ type: 'event', kind: 'flood', pad: 'x'.repeat(1000) }) + '\n';
    for (;;) {
      if (!process.stdout.write(line)) await new Promise((r) => process.stdout.once('drain', r));
    }
  }
  case 'whoami':
    emit({ type: 'event', kind: 'whoami', out: execFileSync('/usr/bin/id', ['-un']).toString().trim() });
    break;
  case 'session': {
    // Speaks the session protocol of spec 005 (evidence lines: session_ready, cmd_result) without a browser, so the
    // supervisor can be tested end to end. Every command is echoed raw (byte-exact forwarding can be checked).
    // Knobs: job.hang_on = a command type that is never answered; job.browser = true makes "snapshot" start the
    // browser on a fixed page and report the aria snapshot, whether a ref from it resolves, and the guest memory.
    // "wait" sleeps, "open_link" with ref e999 fails with ref_not_found, "close" ends the session.
    const ev = (o) => emit({ type: 'evidence', v: 1, ...o });
    ev({ kind: 'nav', via: 'stub' });
    ev({ kind: 'session_ready' });
    let browser;
    let page;
    for (;;) {
      const next = await lines.next();
      if (next.done) break;
      const raw = next.value;
      if (!raw.trim()) continue;
      let cmd;
      try { cmd = JSON.parse(raw); } catch { ev({ kind: 'bad_line', raw }); continue; }
      ev({ kind: 'echo', id: cmd.id, cmd: cmd.cmd, raw });
      if (cmd.cmd === job.hang_on) continue;
      let ok = true;
      let error;
      if (cmd.cmd === 'wait') await new Promise((r) => setTimeout(r, cmd.ms));
      if (cmd.cmd === 'open_link' && cmd.ref === 'e999') { ok = false; error = 'ref_not_found'; }
      if (cmd.cmd === 'snapshot' && job.browser === true) {
        const before = memInfoMib();
        if (!browser) {
          const { chromium } = await import('playwright');
          browser = await chromium.launch({ chromiumSandbox: true });
          page = await browser.newPage();
          await page.setContent(PAGE);
        }
        const text = await page.ariaSnapshot({ mode: 'ai' });
        const ref = /link "Reset password".*?\[ref=(\w+)\]/.exec(text)?.[1];
        const href = ref ? await page.locator(`aria-ref=${ref}`).getAttribute('href') : null;
        await page.screenshot({ fullPage: true });
        const after = memInfoMib();
        emit({
          type: 'event', kind: 'snapshot', id: cmd.id, text, ref, href,
          mem_used_before_mib: Math.round(before.MemTotal - before.MemAvailable),
          mem_used_after_mib: Math.round(after.MemTotal - after.MemAvailable),
          browser_pss_mib: browserPssMib(),
        });
      }
      ev({ kind: 'cmd_result', id: cmd.id, ok, ...(error ? { error } : {}) });
      if (cmd.cmd === 'close') break;
    }
    await browser?.close();
    break;
  }
  default:
    break;
}
emit({ type: 'event', kind: 'done' });
// In a session the agent keeps stdin open until the collector exits, so an open stdin would keep Node alive forever.
rl.close();
process.stdin.destroy();
