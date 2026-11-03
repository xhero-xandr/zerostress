import net from 'node:net';

/** Splits a byte stream into lines at 0x0A before decoding, so multi-byte characters are never cut. */
export class LineSplitter {
  private buf: Buffer = Buffer.alloc(0);
  private maxLine: number;

  constructor(maxLine: number) {
    this.maxLine = maxLine;
  }

  push(chunk: Buffer, onLine: (line: string) => void): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    let nl: number;
    while ((nl = this.buf.indexOf(0x0a)) >= 0) {
      onLine(this.buf.subarray(0, nl).toString('utf8'));
      this.buf = this.buf.subarray(nl + 1);
    }
    if (this.buf.length > this.maxLine) throw new Error('line too long');
  }
}

export interface AgentConnection {
  sock: net.Socket;
  /** Bytes that arrived together with the handshake reply. */
  rest: Buffer;
}

/**
 * Opens a stream to the guest agent through Firecracker's vsock proxy socket:
 * connect to the Unix socket, send "CONNECT <port>", expect "OK <n>".
 * Firecracker closes the connection at once when nothing listens in the guest.
 */
export function connectAgent(uds: string, port: number, handshakeMs: number, signal?: AbortSignal): Promise<AgentConnection> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(uds);
    let buf = Buffer.alloc(0);
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      sock.destroy();
      reject(err);
    };
    const onAbort = () => fail(signal!.reason instanceof Error ? signal!.reason : new Error('aborted'));
    const timer = setTimeout(() => fail(new Error('handshake timeout')), handshakeMs);
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }
    sock.on('connect', () => sock.write(`CONNECT ${port}\n`));
    sock.on('error', (e) => fail(e));
    sock.on('close', () => fail(new Error('closed before handshake')));
    sock.on('data', function onData(d: Buffer) {
      buf = Buffer.concat([buf, d]);
      const nl = buf.indexOf(0x0a);
      if (nl < 0) {
        if (buf.length > 64) fail(new Error('handshake reply too long'));
        return;
      }
      const first = buf.subarray(0, nl).toString('utf8');
      if (!/^OK \d+$/.test(first)) return fail(new Error(`handshake refused: ${first.slice(0, 40)}`));
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      sock.off('data', onData);
      sock.removeAllListeners('close');
      sock.removeAllListeners('error');
      resolve({ sock, rest: buf.subarray(nl + 1) });
    });
  });
}

/** True when the guest agent accepts a connection (the connection is closed again without sending a job). */
export async function probeAgent(uds: string, port: number, signal?: AbortSignal): Promise<boolean> {
  try {
    const { sock } = await connectAgent(uds, port, 1000, signal);
    sock.destroy();
    return true;
  } catch {
    return false;
  }
}

/**
 * Sends one job line and delivers every complete line the agent streams back, until the connection closes.
 * Never half-closes (EOF would make the agent kill the job). A trailing partial line is dropped.
 * Resolves on close or reset (the caller decides from the last line whether the job finished); rejects on handshake
 * failure, an over-long line, or abort.
 */
export async function runAgentJob(
  uds: string,
  port: number,
  job: string,
  onLine: (line: string) => void,
  maxLine: number,
  signal?: AbortSignal,
): Promise<void> {
  const { sock, rest } = await connectAgent(uds, port, 2000, signal);
  return new Promise<void>((resolve, reject) => {
    const splitter = new LineSplitter(maxLine);
    let done = false;
    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      signal?.removeEventListener('abort', onAbort);
      sock.destroy();
      if (err) reject(err);
      else resolve();
    };
    const onAbort = () => finish(signal!.reason instanceof Error ? signal!.reason : new Error('aborted'));
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }
    const feed = (chunk: Buffer) => {
      try {
        splitter.push(chunk, onLine);
      } catch (e) {
        finish(e as Error);
      }
    };
    sock.on('data', feed);
    sock.on('close', () => finish());
    sock.on('error', () => finish()); // a reset ends the stream; the caller looks at the last line
    sock.write(job + '\n');
    if (rest.length) feed(rest);
  });
}
