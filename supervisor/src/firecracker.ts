import { execFile, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';
import type { Config } from './config.ts';
import { probeAgent, runAgentJob } from './vsock.ts';
import { RunError } from './types.ts';
import type { StartOptions, VmHandle } from './types.ts';

const CONSOLE_KEEP = 64 * 1024;

/** One Firecracker API call. Every configuration step must answer 204. */
export function fcPut(apiSock: string, path: string, body: unknown, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      {
        socketPath: apiSock,
        path,
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          if (res.statusCode === 204) resolve();
          else reject(new RunError('fc_api', `PUT ${path} -> ${res.statusCode} ${Buffer.concat(chunks).toString('utf8').slice(0, 200)}`));
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => reject(new RunError('fc_api', `PUT ${path}: ${e.message}`)));
    req.end(data);
  });
}

export function bootArgs(slot: number): string {
  return [
    'console=ttyS0', 'reboot=k', 'panic=1', 'pci=off', 'root=/dev/vda', 'rw',
    `ip=172.16.${slot}.2::172.16.${slot}.1:255.255.255.252::eth0:off:1.1.1.1`,
  ].join(' ');
}

export function guestMac(slot: number): string {
  return `06:00:AC:10:0${slot}:02`;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });

export class FirecrackerVm implements VmHandle {
  readonly exited: Promise<void>;
  private cfg: Config;
  private proc: ChildProcess;
  private apiSock: string;
  private vsockUds: string;
  private tail = Buffer.alloc(0);
  private dead = false;
  private stopping: Promise<void> | null = null;
  private runId: string;
  private writer: ((line: string) => void) | null = null;

  private constructor(cfg: Config, opts: StartOptions) {
    this.cfg = cfg;
    this.apiSock = join(opts.runDir, 'fc.sock');
    this.vsockUds = join(opts.runDir, 'v.sock');
    this.runId = opts.runId;
    // Firecracker runs as a systemd unit started by the root helper (cgroup limits, guaranteed network teardown).
    // The helper blocks until the unit has ended, so the exit of this child means "the VM is gone", and the guest
    // serial console arrives on its stdout. It is read into a small ring buffer, never to a file: a guest could flood it.
    this.proc = spawn('/usr/bin/sudo', ['-n', cfg.zsvmPath, 'run', String(opts.slot), opts.runId, String(opts.memMib), String(opts.vcpu)], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: '/usr/bin:/bin' },
      cwd: opts.runDir,
    });
    const keep = (d: Buffer) => {
      this.tail = Buffer.concat([this.tail, d]);
      if (this.tail.length > CONSOLE_KEEP) this.tail = this.tail.subarray(this.tail.length - CONSOLE_KEEP);
    };
    this.proc.stdout?.on('data', keep);
    this.proc.stderr?.on('data', keep);
    this.exited = new Promise<void>((resolve) => {
      const done = () => {
        this.dead = true;
        resolve();
      };
      this.proc.once('exit', done);
      this.proc.once('error', (e) => {
        keep(Buffer.from(`spawn error: ${e.message}\n`));
        done();
      });
    });
  }

  /** Starts the process and configures the VM through the API. Cleans up after itself on failure. */
  static async launch(cfg: Config, opts: StartOptions): Promise<FirecrackerVm> {
    const vm = new FirecrackerVm(cfg, opts);
    try {
      for (let i = 0; i < 50 && !existsSync(vm.apiSock) && !vm.dead; i++) await sleep(60);
      if (vm.dead || !existsSync(vm.apiSock)) throw new RunError('fc_api', `firecracker did not start: ${vm.console().slice(-200)}`);
      const s = vm.apiSock;
      await fcPut(s, '/machine-config', { vcpu_count: opts.vcpu, mem_size_mib: opts.memMib });
      await fcPut(s, '/boot-source', { kernel_image_path: cfg.kernelPath, boot_args: bootArgs(opts.slot) });
      await fcPut(s, '/drives/rootfs', {
        drive_id: 'rootfs',
        path_on_host: join(opts.runDir, 'rootfs.ext4'),
        is_root_device: true,
        is_read_only: false,
      });
      await fcPut(s, '/network-interfaces/net1', { iface_id: 'net1', guest_mac: guestMac(opts.slot), host_dev_name: `zstap${opts.slot}` });
      await fcPut(s, '/vsock', { guest_cid: 3, uds_path: vm.vsockUds });
      await fcPut(s, '/actions', { action_type: 'InstanceStart' });
      return vm;
    } catch (e) {
      await vm.stop();
      throw e;
    }
  }

  async waitReady(timeoutMs: number, signal: AbortSignal): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (signal.aborted) throw signal.reason;
      if (this.dead) throw new RunError('fc_crashed', `firecracker exited during boot: ${this.console().slice(-200)}`);
      if (await probeAgent(this.vsockUds, this.cfg.vsockPort, signal)) return;
      if (Date.now() >= deadline) throw new RunError('boot_timeout', 'the guest agent did not come up in time');
      await sleep(200, signal);
    }
  }

  async runJob(job: string, onLine: (line: string) => void, signal: AbortSignal): Promise<void> {
    try {
      await runAgentJob(this.vsockUds, this.cfg.vsockPort, job, onLine, this.cfg.maxEvidenceBytes, signal, (w) => {
        this.writer = w;
      });
    } catch (e) {
      if (signal.aborted) throw signal.reason;
      throw new RunError('agent_error', e instanceof Error ? e.message : String(e));
    } finally {
      this.writer = null;
    }
  }

  send(line: string): void {
    if (!this.writer) throw new Error('no open agent connection');
    this.writer(line);
  }

  /**
   * Stops the unit (SIGTERM; verified to end Firecracker in well under a second) and waits until the helper has
   * returned, which happens only after ExecStopPost has torn the slot's network down. The slot must not be reused
   * before that, or a late "zsnet down" could remove the network of the next VM on the same slot.
   */
  stop(): Promise<void> {
    if (!this.stopping) {
      this.stopping = (async () => {
        if (this.dead) return;
        await new Promise<void>((resolve) => {
          execFile('/usr/bin/sudo', ['-n', this.cfg.zsvmPath, 'stop', this.runId], { timeout: 15_000, env: { PATH: '/usr/bin:/bin' } }, () => resolve());
        });
        await Promise.race([this.exited, sleep(8000)]);
        if (!this.dead) this.proc.kill('SIGKILL'); // the sudo child only; the unit is already stopped or stuck for systemd to handle
        await Promise.race([this.exited, sleep(2000)]);
      })();
    }
    return this.stopping;
  }

  console(): string {
    return this.tail.toString('utf8');
  }
}
