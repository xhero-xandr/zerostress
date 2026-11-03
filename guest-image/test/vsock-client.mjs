// Host-side client for the guest agent through Firecracker's vsock Unix socket (stdlib only).
// Usage: node vsock-client.mjs UDS PORT JOB_JSON [--probe]
//   --probe: only check that the agent accepts the connection (exit 0), do not send a job.
import net from 'node:net';

const [uds, port, job, flag] = process.argv.slice(2);
const probe = flag === '--probe';
const t0 = Date.now();
const sock = net.connect(uds);
let buf = '';
let handshaken = false;

const giveUp = setTimeout(() => { console.error('client timeout'); process.exit(3); }, 90_000);

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
    sock.write(job + '\n'); // never half-close: EOF means "client gone" for the agent
  }
});
sock.on('close', () => {
  clearTimeout(giveUp);
  if (!handshaken) { console.error('closed before handshake'); process.exit(2); }
  // No process.exit() here: stdout to a pipe is async and exit would cut the output at the pipe buffer size.
  process.stdout.write(buf);
  console.error(`done ${Date.now() - t0} ms`);
});
sock.on('error', (e) => { console.error('socket error:', e.code); process.exit(2); });
