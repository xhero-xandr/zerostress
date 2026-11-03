import { execFile } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, readdirSync, rmSync, statfsSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from './config.ts';
import { FirecrackerVm } from './firecracker.ts';
import { nullLogger } from './logger.ts';
import type { Logger } from './logger.ts';
import { RunError } from './types.ts';
import type { Backend, StartOptions, VmHandle } from './types.ts';

const MAX_SLOT = 3;
const CLEAN_ENV = { PATH: '/usr/bin:/bin' };

function run(cmd: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, env: CLEAN_ENV, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim().slice(0, 300)));
      else resolve({ stdout, stderr });
    });
  });
}

function slotArg(slot: number): string {
  if (!Number.isInteger(slot) || slot < 0 || slot > MAX_SLOT) throw new Error(`invalid slot ${slot}`);
  return String(slot);
}

/** The real host: cp for disks, sudo zsnet for the network, Firecracker for the VM. No shell anywhere. */
export class LinuxBackend implements Backend {
  private cfg: Config;
  private log: Logger;

  constructor(cfg: Config, log: Logger = nullLogger) {
    this.cfg = cfg;
    this.log = log;
  }

  async prepareDisk(runDir: string): Promise<void> {
    try {
      mkdirSync(runDir, { recursive: true, mode: 0o700 });
      const disk = join(runDir, 'rootfs.ext4');
      await run('/usr/bin/cp', ['--sparse=always', this.cfg.imagePath, disk], 60_000);
      chmodSync(disk, 0o600);
    } catch (e) {
      throw new RunError('disk_copy', e instanceof Error ? e.message : String(e));
    }
  }

  async netUp(slot: number): Promise<void> {
    try {
      await run('/usr/bin/sudo', ['-n', this.cfg.zsnetPath, 'up', slotArg(slot)], 15_000);
    } catch (e) {
      throw new RunError('net_setup', e instanceof Error ? e.message : String(e));
    }
  }

  async netDown(slot: number): Promise<void> {
    await run('/usr/bin/sudo', ['-n', this.cfg.zsnetPath, 'down', slotArg(slot)], 15_000);
  }

  start(opts: StartOptions): Promise<VmHandle> {
    return FirecrackerVm.launch(this.cfg, opts);
  }

  async removeRunDir(runDir: string): Promise<void> {
    rmSync(runDir, { recursive: true, force: true });
  }

  /** Startup recovery (spec 006, 3.5): nothing from a previous process may survive. */
  async recoverHost(): Promise<void> {
    mkdirSync(this.cfg.runsDir, { recursive: true, mode: 0o700 });
    let killed = 0;
    for (const entry of readdirSync('/proc')) {
      if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
      try {
        const cmdline = readFileSync(`/proc/${entry}/cmdline`, 'utf8');
        if (cmdline.includes(this.cfg.runsDir)) {
          process.kill(Number(entry), 'SIGKILL');
          killed++;
        }
      } catch {
        // the process is gone or not ours: nothing to do
      }
    }
    if (killed) await new Promise((r) => setTimeout(r, 300));
    for (let slot = 0; slot <= MAX_SLOT; slot++) {
      try {
        await this.netDown(slot);
      } catch (e) {
        this.log('warn', 'recovery: zsnet down failed', { slot, detail: String(e).slice(0, 200) });
      }
    }
    let removed = 0;
    for (const d of readdirSync(this.cfg.runsDir)) {
      rmSync(join(this.cfg.runsDir, d), { recursive: true, force: true });
      removed++;
    }
    this.log('info', 'recovery done', { killed, removed_dirs: removed });
  }
}

export function freeGbOf(path: string): () => number {
  return () => {
    const s = statfsSync(path);
    return (s.bavail * s.bsize) / 1024 ** 3;
  };
}

/** SHA-256 of the installed guest image as recorded by guest-image/build.sh, for /v1/health. */
export function imageShaFrom(imageDir: string): () => string | null {
  let cached: string | null | undefined;
  return () => {
    if (cached !== undefined) return cached;
    try {
      const m = JSON.parse(readFileSync(join(imageDir, 'manifest.json'), 'utf8')) as { image?: { sha256?: string } };
      cached = m.image?.sha256 ?? null;
    } catch {
      cached = null;
    }
    return cached;
  };
}
