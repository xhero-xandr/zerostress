import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { bootArgs, fcPut, guestMac } from '../src/firecracker.ts';
import { LineSplitter, connectAgent, probeAgent, runAgentJob } from '../src/vsock.ts';
import { RunError } from '../src/types.ts';
import { tempDir } from './helpers.ts';

// a Unix socket on Linux, a named pipe on Windows: same code path for the client either way
const endpoint = (name: string) => (process.platform === 'win32' ? `\\\\.\\pipe\\sup-test-${process.pid}-${name}` : join(tempDir(), `${name}.sock`));

/** Emulates Firecracker's vsock proxy: "CONNECT <port>" -> "OK <n>", then whatever `agent` does with the job line. */
function fakeProxy(path: string, agent: (job: string, sock: net.Socket) => void, opts: { refuse?: boolean } = {}): Promise<net.Server> {
  const server = net.createServer((sock) => {
    if (opts.refuse) return void sock.destroy(); // nothing listens in the guest: Firecracker closes at once
    let buf = '';
    let shaken = false;
    sock.on('error', () => {});
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      if (!shaken) {
        const nl = buf.indexOf('\n');
        if (nl < 0) return;
        assert.match(buf.slice(0, nl), /^CONNECT \d+$/);
        buf = buf.slice(nl + 1);
        shaken = true;
        sock.write('OK 1073741824\n');
      }
      const nl = buf.indexOf('\n');
      if (shaken && nl >= 0) {
        const job = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        agent(job, sock);
      }
    });
  });
  return new Promise((resolve) => server.listen(path, () => resolve(server)));
}

test('LineSplitter: lines across chunks, multi-byte characters across chunk borders, line cap', () => {
  const got: string[] = [];
  const s = new LineSplitter(100);
  const bytes = Buffer.from('{"t":"привет"}\n{"t":2}\n', 'utf8');
  for (let i = 0; i < bytes.length; i += 3) s.push(bytes.subarray(i, i + 3), (l) => got.push(l));
  assert.deepEqual(got, ['{"t":"привет"}', '{"t":2}']);
  assert.throws(() => new LineSplitter(10).push(Buffer.alloc(20, 0x61), () => {}), /line too long/);
});

test('runAgentJob: sends the job, streams lines in order, ends when the agent closes', async () => {
  const path = endpoint('job');
  const server = await fakeProxy(path, (job, sock) => {
    assert.equal(JSON.parse(job).kind, 'url');
    sock.write('{"e":1}\n{"e":2}\n{"type":"status","status":"ok"}\n');
    sock.end();
  });
  try {
    const lines: string[] = [];
    await runAgentJob(path, 5000, '{"kind":"url"}', (l) => lines.push(l), 1000);
    assert.deepEqual(lines, ['{"e":1}', '{"e":2}', '{"type":"status","status":"ok"}']);
  } finally {
    server.close();
  }
});

test('runAgentJob: a trailing partial line is dropped, a reset still ends the stream', async () => {
  const path = endpoint('partial');
  const server = await fakeProxy(path, (_job, sock) => {
    sock.write('{"e":1}\n{"e":2');
    sock.destroy();
  });
  try {
    const lines: string[] = [];
    await runAgentJob(path, 5000, '{}', (l) => lines.push(l), 1000);
    assert.deepEqual(lines, ['{"e":1}']);
  } finally {
    server.close();
  }
});

test('runAgentJob: abort closes the connection and rejects with the reason', async () => {
  const path = endpoint('abort');
  const server = await fakeProxy(path, () => {}); // never answers
  try {
    const ctl = new AbortController();
    const p = runAgentJob(path, 5000, '{}', () => {}, 1000, ctl.signal);
    setTimeout(() => ctl.abort(new RunError('cancelled')), 50);
    await assert.rejects(p, (e: unknown) => e instanceof RunError && e.reason === 'cancelled');
  } finally {
    server.close();
  }
});

test('runAgentJob: an over-long line is an error', async () => {
  const path = endpoint('long');
  const server = await fakeProxy(path, (_j, sock) => sock.write('x'.repeat(5000)));
  try {
    await assert.rejects(runAgentJob(path, 5000, '{}', () => {}, 1000), /line too long/);
  } finally {
    server.close();
  }
});

test('probeAgent: true when the agent answers, false when Firecracker closes at once or nothing exists', async () => {
  const ok = endpoint('probe-ok');
  const refuse = endpoint('probe-no');
  const s1 = await fakeProxy(ok, () => {});
  const s2 = await fakeProxy(refuse, () => {}, { refuse: true });
  try {
    assert.equal(await probeAgent(ok, 5000), true);
    assert.equal(await probeAgent(refuse, 5000), false);
    assert.equal(await probeAgent(endpoint('missing'), 5000), false);
  } finally {
    s1.close();
    s2.close();
  }
});

test('connectAgent: refuses a malformed handshake reply', async () => {
  const path = endpoint('badhs');
  const server = net.createServer((sock) => {
    sock.on('data', () => sock.write('NOPE\n'));
    sock.on('error', () => {});
  });
  await new Promise<void>((r) => server.listen(path, r));
  try {
    await assert.rejects(connectAgent(path, 5000, 1000), /handshake refused/);
  } finally {
    server.close();
  }
});

/** Emulates the Firecracker API: records calls, answers 204 or an error for a chosen path. */
function fakeFirecracker(path: string, failPath?: string): Promise<{ server: http.Server; calls: { path: string; body: unknown }[] }> {
  const calls: { path: string; body: unknown }[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      calls.push({ path: req.url ?? '', body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      if (req.url === failPath) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end('{"fault_message":"bad value"}');
      } else {
        res.writeHead(204);
        res.end();
      }
    });
  });
  return new Promise((resolve) => server.listen(path, () => resolve({ server, calls })));
}

test('fcPut: 204 resolves, anything else is an fc_api error carrying the reply', async () => {
  const path = endpoint('fc');
  const { server, calls } = await fakeFirecracker(path, '/boot-source');
  try {
    await fcPut(path, '/machine-config', { vcpu_count: 2, mem_size_mib: 1024 });
    await assert.rejects(fcPut(path, '/boot-source', { x: 1 }), (e: unknown) => e instanceof RunError && e.reason === 'fc_api' && /bad value/.test(e.message));
    assert.deepEqual(calls.map((c) => c.path), ['/machine-config', '/boot-source']);
    await assert.rejects(fcPut(endpoint('absent'), '/x', {}), (e: unknown) => e instanceof RunError && e.reason === 'fc_api');
  } finally {
    server.close();
  }
});

test('boot arguments and MAC follow the slot, matching zsnet and the tested guest configuration', () => {
  assert.equal(
    bootArgs(1),
    'console=ttyS0 reboot=k panic=1 pci=off root=/dev/vda rw ip=172.16.1.2::172.16.1.1:255.255.255.252::eth0:off:1.1.1.1',
  );
  assert.equal(guestMac(0), '06:00:AC:10:00:02');
  assert.equal(guestMac(3), '06:00:AC:10:03:02');
});
