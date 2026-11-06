// Test double for the evidence collector (spec 005 replaces it). Contract: job JSON on the first stdin line,
// NDJSON events on stdout. A job with a "session" object keeps stdin open and delivers one command per line.
// Modes: default (hello), "fetch" (HTTP GET of job.url), "sleep", "flood", "whoami", "chromium", "sys", "session".
// For the supervisor (which sends kind:"url") the mode rides in the URL: ?stub=session&hang_on=wait (see below).
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { accessSync, constants as fsc, existsSync, unlinkSync, writeSync, openSync, closeSync } from 'node:fs';
import net from 'node:net';
import { Worker } from 'node:worker_threads';
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
  if (u.searchParams.has('mb')) job.mb = Number(u.searchParams.get('mb'));
  if (u.searchParams.has('to')) job.to = u.searchParams.get('to');
  if (u.searchParams.has('host_ip')) job.host_ip = u.searchParams.get('host_ip');
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


// ---- containment probes (deploy/test/containment-e2e.sh): each tries to break one wall from inside the guest, as the
// same unprivileged user the browser runs as. `ok: true` means the wall HELD.
const wall = (name, ok, detail) => emit({ type: 'event', kind: 'wall', wall: name, ok, detail });

function tcpConnect(host, port, ms = 2500) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (r) => { sock.destroy(); resolve(r); };
    sock.setTimeout(ms, () => done('timeout'));
    sock.on('connect', () => done('connected'));
    sock.on('error', (e) => done(e.code ?? 'error'));
  });
}

function defaultGateway() {
  const l = readFileSync('/proc/net/route', 'utf8').split('\n').slice(1).map((x) => x.split('\t')).find((c) => c[1] === '00000000');
  if (!l) return null;
  const n = parseInt(l[2], 16);
  return [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255].join('.');
}

async function runProbes() {
  // who we are
  const uid = process.getuid();
  const capEff = /^CapEff:\s+(\S+)/m.exec(readFileSync('/proc/self/status', 'utf8'))?.[1] ?? '?';
  wall('identity: not root, no capabilities', uid !== 0 && /^0+$/.test(capEff), `uid=${uid} CapEff=${capEff}`);

  // write where only root may
  const writable = ['/etc/passwd', '/etc/shadow', '/usr/bin', '/usr/local/bin', '/opt/collector/collect.mjs', '/opt/node', '/boot', '/lib/systemd/system', '/etc/systemd/system/zerostress-agent.service', '/usr/local/bin/zerostress-agent']
    .filter((p) => { try { accessSync(p, fsc.W_OK); return true; } catch { return false; } });
  wall('the system and the agent cannot be modified', writable.length === 0, writable.length ? `writable: ${writable.join(', ')}` : 'none writable');
  let shadow = true;
  try { readFileSync('/etc/shadow'); } catch { shadow = false; }
  wall('/etc/shadow is unreadable', !shadow, shadow ? 'readable' : 'refused');
  const sudo = ['/usr/bin/sudo', '/bin/sudo', '/usr/bin/doas'].filter((p) => existsSync(p));
  wall('no sudo or doas in the image', sudo.length === 0, sudo.join(', ') || 'absent');
  const mod = spawnSync('/sbin/insmod', ['/dev/null'], { encoding: 'utf8' });
  wall('kernel modules cannot be loaded', mod.status !== 0, `insmod exit ${mod.status} ${String(mod.stderr).trim().slice(0, 80)}`);

  // secrets: the image carries none
  const files = ['/etc/zerostress', '/root/.ssh', '/etc/ssh/ssh_host_rsa_key', '/etc/ssh/ssh_host_ed25519_key', '/etc/ssh/ssh_host_ecdsa_key', '/home/pw/.ssh', '/home/pw/.env', '/opt/collector/.env', '/.env']
    .filter((p) => existsSync(p));
  wall('no keys, tokens or ssh material on disk (by name)', files.length === 0, files.join(', ') || 'none found');
  const g = spawnSync('/usr/bin/grep', ['-rIl', '--exclude-dir=node_modules', '--exclude-dir=pw-browsers', '--exclude-dir=proc', '--exclude-dir=sys', '-e', ['INFERENCE_', 'API_KEY'].join(''), '-e', ['api.vultr', 'inference.com'].join(''), '-e', ['VULTR_', 'API_KEY'].join(''), '-e', ['BEGIN OPENSSH ', 'PRIVATE KEY'].join(''), '-e', ['BEGIN RSA ', 'PRIVATE KEY'].join(''), '/etc', '/opt', '/home', '/var/lib', '/usr/local'], { encoding: 'utf8', timeout: 60000 });
  const hits = String(g.stdout).trim().split('\n').filter(Boolean);
  wall('no key names or private keys inside any file (by content)', hits.length === 0, hits.slice(0, 5).join(', ') || 'none found');
  const envHits = [];
  for (const pid of readdirSync('/proc').filter((x) => /^\d+$/.test(x))) {
    try {
      for (const kv of readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0')) {
        const k = kv.split('=')[0];
        if (/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(k)) envHits.push(`${pid}:${k}`);
      }
    } catch { /* not ours to read */ }
  }
  wall('no secret-looking variables in any readable process environment', envHits.length === 0, envHits.join(', ') || 'none');

  // devices and mounts: nothing shared with the host
  const mounts = readFileSync('/proc/mounts', 'utf8').split('\n').map((l) => l.split(' ')).filter((c) => c.length > 2);
  const shared = mounts.filter((c) => /^(9p|virtiofs|nfs|nfs4|cifs|overlay|fuse|fuse\..+)$/.test(c[2])).map((c) => `${c[1]}:${c[2]}`);
  wall('no shared folders or network mounts from the host', shared.length === 0, shared.join(', ') || 'none');
  const blocks = readdirSync('/sys/block').filter((b) => !/^(loop|ram|zram)/.test(b));
  wall('the only disk is the VM\'s own root disk', blocks.length === 1 && blocks[0] === 'vda', blocks.join(', '));
  const dev = ['/dev/kvm', '/dev/mem', '/dev/kmem', '/dev/port'].filter((p) => existsSync(p) && (() => { try { accessSync(p, fsc.R_OK); return true; } catch { return false; } })());
  wall('no readable /dev/kvm, /dev/mem or /dev/port', dev.length === 0, dev.join(', ') || 'none');

  // vsock: the guest may not open a channel to the host (CID 2)
  const py = "import socket,sys\nr=[]\nfor p in (1,22,80,443,1024,5000,5001,8080,9999):\n s=socket.socket(socket.AF_VSOCK,socket.SOCK_STREAM); s.settimeout(2)\n try:\n  s.connect((2,p)); r.append(str(p)+':connected')\n except Exception as e:\n  r.append(str(p)+':'+type(e).__name__)\n finally:\n  s.close()\nprint(' '.join(r))\n";
  const v = spawnSync('/usr/bin/python3', ['-c', py], { encoding: 'utf8', timeout: 40000 });
  const out = String(v.stdout).trim();
  wall('the guest cannot open a vsock channel to the host', v.status === 0 && out !== '' && !out.includes('connected'), out || String(v.stderr).trim().slice(0, 120));

  // network: only the public internet
  const gw = defaultGateway();
  const targets = [['the cloud metadata address', '169.254.169.254', [80, 443]], ['the host side of the guest link', gw, [22, 80, 443, 8080, 5000]], ['a private 10.x address', '10.0.0.1', [22, 80]], ['a private 192.168.x address', '192.168.0.1', [80]], ['the other guest address range', '172.16.0.6', [22, 80]]];
  if (job.host_ip) targets.push(['the host\'s own public address', job.host_ip, [22, 80, 443, 8080]]);
  for (const [label, host, ports] of targets) {
    if (!host) { wall(`cannot reach ${label}`, false, 'address unknown'); continue; }
    const res = [];
    for (const p of ports) res.push(`${p}:${await tcpConnect(host, p)}`);
    wall(`cannot reach ${label}`, !res.some((x) => x.endsWith(':connected')), `${host} ${res.join(' ')}`);
  }
  const ctl = await tcpConnect('1.1.1.1', 443, 5000);
  wall('control: the public internet is reachable', ctl === 'connected', `1.1.1.1:443 ${ctl}`);
}

function burn(ms) {
  const code = `const end = Date.now() + ${ms}; let x = 0; while (Date.now() < end) { x += Math.sqrt(x + 1); }`;
  return new Promise((resolve) => { const w = new Worker(code, { eval: true }); w.on('exit', resolve); w.on('error', resolve); });
}

switch (mode) {
  case 'probe':
    await runProbes();
    break;
  case 'memhog': {
    // touch every page, so the guest really holds the memory (the VM has less RAM than the host unit's ceiling)
    const keep = [];
    const target = job.mb ?? 1500;
    for (let mb = 0; mb < target; mb += 16) {
      const b = Buffer.alloc(16 * 1024 * 1024, 1);
      for (let i = 0; i < b.length; i += 4096) b[i] = 2;
      keep.push(b);
      if (mb % 128 === 0) emit({ type: 'event', kind: 'memhog', mb });
    }
    emit({ type: 'event', kind: 'memhog_done', mb: target });
    break;
  }
  case 'cpuburn':
    await Promise.all([burn(job.ms ?? 8000), burn(job.ms ?? 8000), burn(job.ms ?? 8000), burn(job.ms ?? 8000)]);
    emit({ type: 'event', kind: 'cpuburn_done', ms: job.ms ?? 8000 });
    break;
  case 'diskfill': {
    const target = job.to === 'home' ? '/home/pw/fill.bin' : '/tmp/fill.bin';
    const fd = openSync(target, 'w');
    const chunk = Buffer.alloc(8 * 1024 * 1024, 7);
    try {
      for (let mb = 0; mb < (job.mb ?? 512); mb += 8) { writeSync(fd, chunk); if (mb % 128 === 0) emit({ type: 'event', kind: 'diskfill', mb }); }
      emit({ type: 'event', kind: 'diskfill_done', mb: job.mb ?? 512 });
    } finally { closeSync(fd); try { unlinkSync(target); } catch { /* gone */ } }
    break;
  }
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
