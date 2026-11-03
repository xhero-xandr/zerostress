// Test double for the evidence collector (spec 005 replaces it). Contract: job JSON on stdin, NDJSON events on stdout.
// Modes: default (hello), "fetch" (HTTP GET of job.url), "sleep", "flood", "whoami".
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const job = JSON.parse(readFileSync(0, 'utf8'));
const emit = (o) => process.stdout.write(JSON.stringify(o) + '\n');

emit({ type: 'event', kind: 'started', mode: job.mode ?? 'hello', uid: process.getuid() });

switch (job.mode) {
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
  default:
    break;
}
emit({ type: 'event', kind: 'done' });
