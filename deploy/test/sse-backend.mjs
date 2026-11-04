// Tiny SSE backend for proxy experiments (127.0.0.1, port from PORT, default 8009).
//   /events : an event right away, then one every 2 s, ten in total, then the stream ends
//   /idle   : an event right away, silence for 45 s, then one more event and the end
//   /ping   : plain short response
import http from 'node:http';

const sse = { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' };
http
  .createServer((req, res) => {
    if (req.url === '/events') {
      res.writeHead(200, sse);
      let n = 0;
      const tick = () => {
        res.write(`id: ${++n}\ndata: ${Date.now()}\n\n`);
        if (n >= 10) { clearInterval(t); res.end(); }
      };
      const t = setInterval(tick, 2000);
      tick();
      req.on('close', () => clearInterval(t));
    } else if (req.url === '/idle') {
      res.writeHead(200, sse);
      res.write('data: first\n\n');
      const t = setTimeout(() => { res.write('data: after 45s of silence\n\n'); res.end(); }, 45_000);
      req.on('close', () => clearTimeout(t));
    } else {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok\n');
    }
  })
  .listen(Number(process.env.PORT || 8009), '127.0.0.1');
