import { spawn } from 'node:child_process';
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

  private constructor(cfg: Config, opts: StartOptions) {
    this.cfg = cfg;
    this.apiSock = join(opts.runDir, 'fc.sock');
    this.vsockUds = join(opts.runDir, 'v.sock');
    // the serial console is read into a small ring buffer, never to a file: a guest could flood it
    this.proc = spawn(cfg.firecrackerPath, ['--api-sock', this.apiSock, '--id', opts.runId], {
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
      await runAgentJob(this.vsockUds, this.cfg.vsockPort, job, onLine, this.cfg.maxEvidenceBytes, signal);
    } catch (e) {
      if (signal.aborted) throw signal.reason;
      throw new RunError('agent_error', e instanceof Error ? e.message : String(e));
    }
  }

  stop(): Promise<void> {
    if (!this.stopping) {
      this.stopping = (async () => {
        if (this.dead) return;
        this.proc.kill('SIGTERM');
        await Promise.race([this.exited, sleep(1000)]);
        if (!this.dead) this.proc.kill('SIGKILL');
        await Promise.race([this.exited, sleep(3000)]);
      })();
    }
    return this.stopping;
  }

  console(): string {
    return this.tail.toString('utf8');
  }
}
