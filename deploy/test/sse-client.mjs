// Measures how a proxy delivers a Server-Sent Events stream: node sse-client.mjs URL [LABEL]
// Prints HTTP status, when each "data:" line arrived (ms from start) and when/why the stream ended.
const [url, label = url] = process.argv.slice(2);
const t0 = Date.now();
const arrivals = [];
let status = 0;
let end = 'ended by the server';
try {
  const res = await fetch(url, { signal: AbortSignal.timeout(70_000) });
  status = res.status;
  const dec = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.startsWith('data:')) arrivals.push(Date.now() - t0);
    }
  }
} catch (e) {
  end = `broken: ${e.cause?.code ?? e.name}`;
}
const gaps = arrivals.slice(1).map((v, i) => v - arrivals[i]);
console.log(`${label}: status=${status} events=${arrivals.length} first=${arrivals[0] ?? '-'}ms gaps=[${gaps.join(',')}] total=${Date.now() - t0}ms (${end})`);
