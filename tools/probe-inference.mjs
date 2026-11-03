// Probe Vultr Serverless Inference: for each chat-capable model check plain chat, strict json_schema and image input.
// Usage on the server:  set -a; . /etc/zerostress/web.env; set +a; node tools/probe-inference.mjs [model ...]
// The key is read from the environment and never printed.
import { deflateSync, crc32 } from 'node:zlib';

const base = process.env.INFERENCE_BASE_URL;
const key = process.env.INFERENCE_API_KEY;
if (!base || !key) { console.error('INFERENCE_BASE_URL and INFERENCE_API_KEY must be set'); process.exit(1); }

const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
const scrub = (s) => String(s).split(key).join('***');

async function call(path, body, timeoutMs = 90_000) {
  const t0 = Date.now();
  try {
    const r = await fetch(base + path, { method: path === '/models' ? 'GET' : 'POST', headers, body: body && JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    const text = await r.text();
    let json; try { json = JSON.parse(text); } catch { /* keep text */ }
    return { status: r.status, ms: Date.now() - t0, json, text };
  } catch (e) {
    return { status: 0, ms: Date.now() - t0, text: String(e.cause?.code ?? e.message) };
  }
}

// solid red 64x64 PNG, built in memory (no files)
function redPng() {
  const w = 64, h = 64;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1); raw[o] = 0; raw[o + 1 + x * 3] = 255; }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const png = redPng().toString('base64');

const schema = {
  type: 'object', additionalProperties: false, required: ['verdict', 'confidence'],
  properties: { verdict: { type: 'string', enum: ['safe', 'suspicious', 'malicious'] }, confidence: { type: 'number' } },
};

const text = (m) => m?.json?.choices?.[0]?.message?.content;

async function probe(model) {
  const row = { model };
  const plain = await call('/chat/completions', { model, max_tokens: 300, messages: [{ role: 'user', content: 'Reply with the single word: pong' }] });
  row.plain = plain.status === 200 && text(plain) ? `ok ${plain.ms}ms` : `fail ${plain.status} ${scrub(plain.text).slice(0, 80).replace(/\s+/g, ' ')}`;
  if (plain.status !== 200) return row;

  const js = await call('/chat/completions', {
    model, max_tokens: 600,
    messages: [{ role: 'user', content: 'A page on a non-bank domain asks for a bank password. Classify it.' }],
    response_format: { type: 'json_schema', json_schema: { name: 'verdict', strict: true, schema } },
  });
  let jsOk = false;
  try { const o = JSON.parse(text(js)); jsOk = ['safe', 'suspicious', 'malicious'].includes(o.verdict) && typeof o.confidence === 'number' && Object.keys(o).length === 2; } catch { /* not valid */ }
  row.json_schema = jsOk ? `ok ${js.ms}ms` : `fail ${js.status} ${scrub(js.status === 200 ? String(text(js)) : js.text).slice(0, 80).replace(/\s+/g, ' ')}`;

  const vis = await call('/chat/completions', {
    model, max_tokens: 400,
    messages: [{ role: 'user', content: [
      { type: 'text', text: 'What is the dominant color of this image? Answer with one word.' },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${png}` } },
    ] }],
  });
  const vt = String(text(vis) ?? '');
  row.vision = vis.status === 200 && /red/i.test(vt) ? `ok ${vis.ms}ms` : `no: ${vis.status} ${scrub(vis.status === 200 ? vt : vis.text).slice(0, 80).replace(/\s+/g, ' ')}`;
  return row;
}

let models = process.argv.slice(2);
if (!models.length) {
  const r = await call('/models');
  const all = (r.json?.data ?? []).map((m) => m.id);
  const skip = /(embedding|reranker|retriever|tts|asr|speech|whisper|image|music|ace-step|chatterbox|safety|voxtral)/i;
  models = all.filter((m) => !skip.test(m));
}
console.log(`probing ${models.length} models`);
const out = [];
const queue = [...models];
await Promise.all(Array.from({ length: 3 }, async () => { for (let m; (m = queue.shift());) out.push(await probe(m)); }));
out.sort((a, b) => a.model.localeCompare(b.model));
for (const r of out) console.log(`${r.model}\n   plain: ${r.plain}\n   json_schema: ${r.json_schema ?? '-'}\n   vision: ${r.vision ?? '-'}`);
