// A stand-in for the model service: a local HTTP server that speaks the chat-completions protocol, records every
// request and answers as the test says. The real service is never contacted from the tests.

import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface Seen {
  headers: IncomingHttpHeaders;
  raw: string;
  body: any;
}

export interface Reply {
  status?: number;
  headers?: Record<string, string>;
  /** an object is sent as JSON, a string as it is */
  body?: unknown;
  delayMs?: number;
}

export interface FakeModel {
  url: string;
  seen: Seen[];
  maxInFlight(): number;
  close(): Promise<void>;
}

export async function startFakeModel(handler: (seen: Seen, n: number) => Reply): Promise<FakeModel> {
  const seen: Seen[] = [];
  let inFlight = 0;
  let max = 0;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      inFlight++;
      max = Math.max(max, inFlight);
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: any;
      try {
        body = JSON.parse(raw);
      } catch {
        body = undefined;
      }
      const s: Seen = { headers: req.headers, raw, body };
      seen.push(s);
      const reply = handler(s, seen.length);
      if (reply.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs));
      const payload = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body ?? {});
      res.writeHead(reply.status ?? 200, { 'content-type': 'application/json', ...reply.headers });
      res.end(payload);
      inFlight--;
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    seen,
    maxInFlight: () => max,
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}

/** A well-formed chat answer carrying `content`. */
export function chat(content: unknown, usage: Record<string, number> = { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 }): Reply {
  return { body: { choices: [{ message: { role: 'assistant', content: typeof content === 'string' ? content : JSON.stringify(content) } }], usage } };
}

/** A well-formed answer object of the model. */
export function answer(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { verdict: 'suspicious', confidence: 0.7, summary: 'The page behaves in a way that deserves care.', reasons: [], next: { action: 'none' }, ...over };
}
