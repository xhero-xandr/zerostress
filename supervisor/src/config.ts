import { join } from 'node:path';

export interface Config {
  concurrency: number;
  queueMax: number;
  queueWaitMs: number;
  bootTimeoutMs: number;
  hardTimeoutMs: number;
  vcpu: number;
  memMib: number;
  minFreeGb: number;
  resultTtlMs: number;
  maxEvidenceBytes: number;
  /** Interactive sessions (spec 006, 3.7-3.8). */
  sessionSlots: number;
  sessionIdleMs: number;
  sessionMaxMs: number;
  sessionGraceMs: number;
  approvalTtlMs: number;
  commandMax: number;
  commandTimeoutMs: number;
  shutdownGraceMs: number;
  keepaliveMs: number;
  vsockPort: number;
  socketPath: string;
  stateDir: string;
  runsDir: string;
  resultsDir: string;
  dbPath: string;
  imageDir: string;
  imagePath: string;
  kernelPath: string;
  firecrackerPath: string;
  zsnetPath: string;
  zsvmPath: string;
}

type Env = Record<string, string | undefined>;

function int(env: Env, name: string, def: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return def;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a non-negative integer`);
  const v = Number(raw);
  if (v < min || v > max) throw new Error(`${name} must be between ${min} and ${max}`);
  return v;
}

export function loadConfig(env: Env = process.env): Config {
  const stateDir = env.SUP_STATE_DIR || '/var/lib/zerostress';
  const imageDir = env.SUP_IMAGE_DIR || '/opt/zerostress/images';
  return {
    // slots 0..3 exist in zsnet, so at most four microVMs at a time
    concurrency: int(env, 'SUP_CONCURRENCY', 2, 1, 4),
    queueMax: int(env, 'SUP_QUEUE_MAX', 20, 1, 1000),
    queueWaitMs: int(env, 'SUP_QUEUE_WAIT_S', 120, 1, 3600) * 1000,
    bootTimeoutMs: int(env, 'SUP_BOOT_TIMEOUT_S', 15, 1, 120) * 1000,
    hardTimeoutMs: int(env, 'SUP_HARD_TIMEOUT_S', 90, 5, 600) * 1000,
    vcpu: int(env, 'SUP_VCPU', 2, 1, 4),
    memMib: int(env, 'SUP_MEM_MIB', 1024, 256, 4096),
    minFreeGb: int(env, 'SUP_MIN_FREE_GB', 20, 0, 1000),
    resultTtlMs: int(env, 'SUP_RESULT_TTL_H', 24, 1, 24 * 30) * 3600 * 1000,
    maxEvidenceBytes: 2 * 1024 * 1024,
    sessionSlots: int(env, 'SUP_SESSION_SLOTS', 1, 0, 4),
    sessionIdleMs: int(env, 'SUP_SESSION_IDLE_S', 60, 5, 120) * 1000,
    sessionMaxMs: int(env, 'SUP_SESSION_MAX_S', 300, 30, 600) * 1000,
    sessionGraceMs: int(env, 'SUP_SESSION_GRACE_S', 30, 1, 120) * 1000,
    approvalTtlMs: int(env, 'SUP_APPROVAL_TTL_S', 300, 10, 3600) * 1000,
    // the agent forwards at most 200 lines per job (004, 8e): keep room for the supervisor's own close
    commandMax: int(env, 'SUP_COMMAND_MAX', 190, 1, 199),
    commandTimeoutMs: int(env, 'SUP_COMMAND_TIMEOUT_S', 30, 1, 120) * 1000,
    shutdownGraceMs: 10_000,
    keepaliveMs: 15_000,
    vsockPort: 5000,
    socketPath: env.SUP_SOCKET || '/run/zerostress/supervisor.sock',
    stateDir,
    runsDir: join(stateDir, 'runs'),
    resultsDir: join(stateDir, 'results'),
    dbPath: join(stateDir, 'supervisor.db'),
    imageDir,
    imagePath: join(imageDir, 'guest-rootfs.ext4'),
    kernelPath: env.SUP_KERNEL || join(imageDir, 'vmlinux-6.18.56'),
    firecrackerPath: env.SUP_FIRECRACKER || '/opt/zerostress/bin/firecracker',
    zsnetPath: env.SUP_ZSNET || '/opt/zerostress/bin/zsnet',
    zsvmPath: env.SUP_ZSVM || '/opt/zerostress/bin/zsvm',
  };
}
