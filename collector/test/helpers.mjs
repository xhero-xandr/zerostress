import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ENTRY = join(dirname(fileURLToPath(import.meta.url)), '..', 'collect.mjs');
export const RUN_ID = '3f1c2a64-8d0b-4c35-9a77-0b6f3a1e2d90';

/**
 * Starts the real collector as a child process (real Chromium) the way the guest agent does: job on the first stdin
 * line, one command per further line, events on stdout.
 */
export function startCollector(jobFields, { env = {} } = {}) {
  const artifactDir = mkdtempSync(join(tmpdir(), 'zs-art-'));
  const child = spawn(process.execPath, [ENTRY], {
    env: { ...process.env, ZS_ARTIFACT_DIR: artifactDir, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const events = [];
  const raw = [];
  let stderr = '';
  let buf = '';
  const waiters = [];
  child.stdout.on('data', (d) => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      raw.push(line);
      let ev;
      try { ev = JSON.parse(line); } catch { ev = { type: 'unparsable', line }; }
      events.push(ev);
      for (const w of [...waiters]) if (w.pred(ev)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(ev); }
    }
  });
  child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));

  const job = { schema: 1, run_id: RUN_ID, kind: 'url', ...jobFields };
  child.stdin.write(JSON.stringify(job) + '\n');

  const api = {
    child, events, raw, artifactDir, exited,
    stderr: () => stderr,
    kinds: (k) => events.filter((e) => e.kind === k),
    first: (k) => events.find((e) => e.kind === k),
    waitFor(pred, ms = 40000) {
      const found = events.find(pred);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`timeout waiting for event; got kinds: ${events.map((e) => e.kind).join(',')}; stderr: ${stderr.slice(0, 500)}`)), ms);
        waiters.push({ pred, resolve: (e) => { clearTimeout(t); resolve(e); } });
      });
    },
    /** Sends one command line and resolves with its cmd_result. */
    async command(cmd, ms = 40000) {
      child.stdin.write(JSON.stringify(cmd) + '\n');
      return api.waitFor((e) => e.kind === 'cmd_result' && e.id === cmd.id, ms);
    },
    sendRaw(line) { child.stdin.write(line + '\n'); },
    files: () => readdirSync(artifactDir),
    async finish(ms = 40000) {
      const code = await Promise.race([exited, new Promise((_, rej) => setTimeout(() => rej(new Error('collector did not exit; stderr: ' + stderr.slice(0, 500))), ms))]);
      try { api.filesAtExit = readdirSync(artifactDir); } catch { api.filesAtExit = []; }
      api.artifactBytes = Object.fromEntries(api.filesAtExit.map((f) => [f, statSync(join(artifactDir, f)).size]));
      rmSync(artifactDir, { recursive: true, force: true });
      return code;
    },
    kill() { child.kill('SIGKILL'); },
  };
  return api;
}

/** One autonomous pass: returns { events, code, ... }. */
export async function scanOnce(url, extra = {}) {
  const c = startCollector({ url, ...extra });
  const code = await c.finish();
  return { ...c, code };
}
