// Host-side client for the guest agent through Firecracker's vsock Unix socket (stdlib only).
// Usage: node vsock-client.mjs [flags] UDS PORT JOB_JSON [COMMAND_JSON...]
//   --probe        only check that the agent accepts the connection (exit 0), do not send a job
//   --burst        send the job and all commands in ONE write (pipelining)
//   --abort-ms=N   drop the connection N ms after the last line was sent (a client that vanishes)
//   --timeout=S    give up after S seconds (default 90) and print what has arrived
// Commands follow the job, one per line, 250 ms apart unless --burst. The client never half-closes: EOF means
// "client gone" for the agent.
import net from 'node:net';

const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith('--'));
const [uds, port, job, ...cmds] = args.filter((a) => !a.startsWith('--'));
const probe = flags.includes('--probe');
const burst = flags.includes('--burst');
const abortMs = Number(flags.find((f) => f.startsWith('--abort-ms='))?.split('=')[1] ?? 0);
const GAP_MS = 250;

const t0 = Date.now();
const sock = net.connect(uds);
let buf = '';
let handshaken = false;

// On timeout the output received so far is still printed: it is the only clue to what the guest was doing.
const timeoutS = Number(flags.find((f) => f.startsWith('--timeout='))?.split('=')[1] ?? 90);
const giveUp = setTimeout(() => {
  console.error('client timeout');
  process.stdout.write(buf);
  process.exitCode = 3;
  setTimeout(() => process.exit(3), 200);
}, timeoutS * 1000);

function send(lines) {
  let i = 0;
  const next = () => {
    if (sock.destroyed) return;
    if (i < lines.length) {
      sock.write(lines[i++] + '\n');
      setTimeout(next, GAP_MS);
    } else if (abortMs > 0) {
      setTimeout(() => sock.destroy(), abortMs);
    }
  };
  next();
}

sock.on('connect', () => sock.write(`CONNECT ${port}\n`));
sock.on('data', (d) => {
  buf += d.toString('utf8');
  if (!handshaken) {
    const nl = buf.indexOf('\n');
    if (nl < 0) return;
    const first = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!/^OK \d+$/.test(first)) { console.error('handshake failed:', first); process.exit(2); }
    handshaken = true;
    console.error(`handshake ${Date.now() - t0} ms`);
    if (probe) { sock.destroy(); process.exit(0); }
    if (burst) {
      sock.write([job, ...cmds].join('\n') + '\n');
      if (abortMs > 0) setTimeout(() => sock.destroy(), abortMs);
    } else {
      send([job, ...cmds]);
    }
  }
});
sock.on('close', () => {
  clearTimeout(giveUp);
  if (!handshaken) { console.error('closed before handshake'); process.exit(2); }
  // No process.exit() here: stdout to a pipe is async and exit would cut the output at the pipe buffer size.
  process.stdout.write(buf);
  console.error(`done ${Date.now() - t0} ms`);
});
// A write after the agent already closed is expected in the bad-command cases; the verdict is in the status line.
sock.on('error', (e) => {
  if (handshaken && (e.code === 'EPIPE' || e.code === 'ECONNRESET')) return;
  console.error('socket error:', e.code);
  process.exit(2);
});
