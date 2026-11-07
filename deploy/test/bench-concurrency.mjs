// Concurrency measurement with real Chromium in real microVMs, through the installed supervisor.
// For each concurrency level N: submit N jobs at once, sample the host every 250 ms, report memory, CPU, timings, failures.
// Run as root on the host: /zerostress/runtime/node/bin/node bench-concurrency.mjs   (LEVELS=1,2,3,4 REPEATS=2 MEM_MIB=1024)
// It sets SUP_CONCURRENCY (and SUP_MEM_MIB) through a temporary systemd drop-in and always removes it again.
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const SOCK = '/zerostress/run/supervisor.sock';
const DROPIN_DIR = '/etc/systemd/system/zerostress-supervisor.service.d';
const DROPIN = `${DROPIN_DIR}/bench.conf`;
const PAGES = [
  'https://example.com/',
  'https://en.wikipedia.org/wiki/Firecracker_(software)',
  'https://www.mozilla.org/en-US/',
];
const LEVELS = (process.env.LEVELS || '1,2,3,4').split(',').map(Number);
const REPEATS = Number(process.env.REPEATS || 2);
const MEM_MIB = Number(process.env.MEM_MIB || 1024);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function api(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ socketPath: SOCK, path, method, headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json; try { json = JSON.parse(text); } catch { /* sse or empty */ }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}

const sh = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const mem = () => {
  const t = readFileSync('/proc/meminfo', 'utf8');
  const g = (k) => Number(new RegExp(`^${k}:\\s+(\\d+)`, 'm').exec(t)[1]) / 1024;
  return { avail: g('MemAvailable'), total: g('MemTotal'), swapUsed: g('SwapTotal') - g('SwapFree') };
};
const cpu = () => {
  const l = readFileSync('/proc/stat', 'utf8').split('\n')[0].split(/\s+/).slice(1).map(Number);
  return { idle: l[3] + l[4], total: l.reduce((a, b) => a + b, 0) };
};
const psi = (f) => { try { return Number(/some avg10=([\d.]+)/.exec(readFileSync(f, 'utf8'))[1]); } catch { return null; } };
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const f1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : '-');

async function waitHealth() {
  for (let i = 0; i < 60; i++) {
    try { if ((await api('GET', '/v1/health')).status === 200) return; } catch { /* not up yet */ }
    await sleep(500);
  }
  throw new Error('supervisor did not come back');
}
async function setLevel(n) {
  mkdirSync(DROPIN_DIR, { recursive: true });
  writeFileSync(DROPIN, `[Service]\nEnvironment=SUP_CONCURRENCY=${n}\nEnvironment=SUP_MEM_MIB=${MEM_MIB}\n`);
  sh('systemctl', ['daemon-reload']);
  sh('systemctl', ['restart', 'zerostress-supervisor']);
  await waitHealth();
}
function hostClean() {
  const units = sh('systemctl', ['list-units', '--all', '--no-legend', '--plain', 'zsvm-*.service']).trim().split('\n').filter(Boolean).length;
  return units === 0;
}

async function wave(n, rep) {
  const t0 = Date.now();
  const jobs = [];
  for (let i = 0; i < n; i++) {
    const url = `${PAGES[(i + rep) % PAGES.length]}?stub=chromium`;
    const r = await api('POST', '/v1/runs', { kind: 'url', url });
    if (r.status !== 202) throw new Error(`submit failed: ${r.status} ${r.text}`);
    jobs.push({ id: r.json.run_id, page: PAGES[(i + rep) % PAGES.length], running: null, done: null, peakMiB: 0, view: null });
  }
  let minAvail = Infinity, maxSwap = 0, prev = cpu();
  const cpuBusy = [];
  let psiCpuMax = 0, psiMemMax = 0;
  for (;;) {
    await sleep(250);
    const now = Date.now();
    for (const j of jobs) {
      if (j.done) continue;
      const v = (await api('GET', `/v1/runs/${j.id}`)).json;
      j.view = v;
      if (v.state === 'running' && !j.running) j.running = now;
      if (v.state === 'done' || v.state === 'failed') j.done = now;
      try {
        const p = Number(readFileSync(`/sys/fs/cgroup/system.slice/zsvm-${j.id}.service/memory.peak`, 'utf8')) / 1048576;
        if (p > j.peakMiB) j.peakMiB = p;
      } catch { /* unit not there (yet or any more) */ }
    }
    const m = mem();
    minAvail = Math.min(minAvail, m.avail);
    maxSwap = Math.max(maxSwap, m.swapUsed);
    const c = cpu();
    cpuBusy.push(100 * (1 - (c.idle - prev.idle) / (c.total - prev.total)));
    prev = c;
    psiCpuMax = Math.max(psiCpuMax, psi('/proc/pressure/cpu') ?? 0);
    psiMemMax = Math.max(psiMemMax, psi('/proc/pressure/memory') ?? 0);
    if (jobs.every((j) => j.done)) break;
    if (now - t0 > 150_000) break;
  }
  const makespan = (Math.max(...jobs.map((j) => j.done ?? Date.now())) - t0) / 1000;
  // evidence of one successful job proves Chromium really rendered
  let evidence = '';
  const ok = jobs.find((j) => j.view?.state === 'done');
  if (ok) {
    const ev = (await api('GET', `/v1/runs/${ok.id}/events`)).text;
    const m = /"kind":"chromium"[^\n]*/.exec(ev);
    evidence = m ? m[0].slice(0, 160) : '(no chromium event)';
  }
  for (let i = 0; i < 40 && !hostClean(); i++) await sleep(250);
  return {
    n, makespan, minAvail, maxSwap, psiCpuMax, psiMemMax,
    cpuAvg: mean(cpuBusy), cpuMax: Math.max(...cpuBusy),
    jobs: jobs.map((j) => ({
      page: j.page, state: j.view?.state, reason: j.view?.reason, agent: j.view?.agent_status,
      boot: j.running ? (j.running - t0) / 1000 : null, run: j.running && j.done ? (j.done - j.running) / 1000 : null,
      peakMiB: j.peakMiB,
    })),
    evidence, clean: hostClean(),
  };
}

const results = [];
try {
  const m0 = mem();
  console.log(`host: ${f1(m0.total)} MiB RAM, ${f1(m0.avail)} MiB available, swap used ${f1(m0.swapUsed)} MiB; guest RAM ${MEM_MIB} MiB; ${REPEATS} waves per level`);
  for (const n of LEVELS) {
    await setLevel(n);
    for (let rep = 0; rep < REPEATS; rep++) {
      const r = await wave(n, rep);
      results.push(r);
      const okN = r.jobs.filter((j) => j.state === 'done').length;
      console.log(`N=${n} wave ${rep + 1}: ${okN}/${n} done, makespan ${f1(r.makespan)}s, min MemAvailable ${f1(r.minAvail)} MiB, cpu avg/max ${f1(r.cpuAvg)}/${f1(r.cpuMax)}%, VM peaks ${r.jobs.map((j) => f1(j.peakMiB)).join('/')} MiB`);
      for (const j of r.jobs) if (j.state !== 'done') console.log(`   FAILED: ${j.page} -> ${j.state} ${j.reason} ${j.agent ?? ''}`);
    }
  }
} finally {
  rmSync(DROPIN, { force: true });
  try { rmSync(DROPIN_DIR); } catch { /* not empty or gone */ }
  sh('systemctl', ['daemon-reload']);
  sh('systemctl', ['restart', 'zerostress-supervisor']);
}

console.log('\n| N | done | makespan s (avg/max) | boot s (avg) | page run s (avg/max) | min MemAvailable MiB | swap max MiB | VM peak MiB (max) | sum of peaks MiB | CPU busy % (avg/max) | PSI cpu/mem avg10 max |');
console.log('|---|---|---|---|---|---|---|---|---|---|---|');
for (const n of LEVELS) {
  const rs = results.filter((r) => r.n === n);
  const js = rs.flatMap((r) => r.jobs);
  const ok = js.filter((j) => j.state === 'done');
  console.log(`| ${n} | ${ok.length}/${js.length} | ${f1(mean(rs.map((r) => r.makespan)))}/${f1(Math.max(...rs.map((r) => r.makespan)))} | ${f1(mean(js.map((j) => j.boot).filter((x) => x != null)))} | ${f1(mean(ok.map((j) => j.run)))}/${f1(Math.max(...ok.map((j) => j.run), 0))} | ${f1(Math.min(...rs.map((r) => r.minAvail)))} | ${f1(Math.max(...rs.map((r) => r.maxSwap)))} | ${f1(Math.max(...js.map((j) => j.peakMiB)))} | ${f1(Math.max(...rs.map((r) => r.jobs.reduce((s, j) => s + j.peakMiB, 0))))} | ${f1(mean(rs.map((r) => r.cpuAvg)))}/${f1(Math.max(...rs.map((r) => r.cpuMax)))} | ${f1(Math.max(...rs.map((r) => r.psiCpuMax)))}/${f1(Math.max(...rs.map((r) => r.psiMemMax)))} |`);
}
console.log('\nper page (successful jobs, page run seconds / VM peak MiB):');
for (const p of PAGES) {
  const js = results.flatMap((r) => r.jobs).filter((j) => j.page === p && j.state === 'done');
  console.log(`  ${p}: n=${js.length} run avg ${f1(mean(js.map((j) => j.run)))}s, peak max ${f1(Math.max(...js.map((j) => j.peakMiB), 0))} MiB`);
}
console.log('\nevidence sample:', results.find((r) => r.evidence)?.evidence ?? '(none)');
console.log('host clean after all waves:', results.every((r) => r.clean));
