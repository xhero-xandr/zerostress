// What does page.ariaSnapshot({mode:'ai'}) give us (spec 005)? Run with Playwright 1.64.1 installed next to this file:
//   node aria-probe.mjs
// Static test page only (setContent): hidden and tricky text, iframe, shadow DOM, SVG, links, a password form.
import { chromium } from 'playwright';

const html = `<!doctype html><html lang="en"><head><title>PROBE-title</title>
<meta name="description" content="PROBE-meta-description"></head><body>
<h1>PROBE-visible-heading</h1>
<p>PROBE-visible-paragraph</p>
<div style="display:none">PROBE-display-none</div>
<div aria-hidden="true">PROBE-aria-hidden</div>
<span style="font-size:0">PROBE-zero-size</span>
<span style="color:#fff;background:#fff">PROBE-white-on-white</span>
<div style="position:absolute;left:-9999px">PROBE-offscreen</div>
<!-- PROBE-html-comment -->
<img alt="PROBE-img-alt" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">
<a href="https://example.org/same?x=1" title="PROBE-link-title">PROBE-link-text</a>
<a href="https://evil.example/login" aria-label="PROBE-aria-label">icon</a>
<a href="javascript:void(0)">PROBE-js-link</a>
<button id="b1">PROBE-button</button>
<form action="https://collect.example/post" method="post">
<label>PROBE-user<input name="u" type="text"></label>
<label>PROBE-pass<input name="p" type="password"></label>
<input type="submit" value="PROBE-submit"></form>
<iframe srcdoc="<p>PROBE-iframe-text</p><a href='https://iframe.example/'>PROBE-iframe-link</a>"></iframe>
<div id="host"></div>
<svg width="100" height="30"><title>PROBE-svg-title</title><text x="0" y="20">PROBE-svg-text</text></svg>
<script>const r=document.getElementById('host').attachShadow({mode:'open'});r.innerHTML='<button>PROBE-shadow-button</button>';</script>
</body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent(html);
await page.waitForLoadState('load');
await page.waitForTimeout(300); // iframe srcdoc

const refLine = (snap, text) => snap.split('\n').find((l) => l.includes(text) && l.includes('[ref='));
const refOf = (snap, text) => refLine(snap, text)?.match(/\[ref=([^\]]+)\]/)?.[1];
const targets = [['link', 'PROBE-link-text'], ['button', 'PROBE-button'], ['password input', 'PROBE-pass'], ['shadow button', 'PROBE-shadow-button'], ['iframe link', 'PROBE-iframe-link']];

const ai = await page.ariaSnapshot({ mode: 'ai' });
console.log('=== ai snapshot ===\n' + ai + '\n');
const refs = Object.fromEntries(targets.map(([label, text]) => [label, refOf(ai, text)]));

async function resolveAll(when) {
  const out = [];
  for (const [label] of targets) {
    const ref = refs[label];
    const n = ref ? await page.locator(`aria-ref=${ref}`).count().catch(() => 'error') : 'no ref';
    out.push(`${label}(${ref})=${n}`);
  }
  console.log(`${when.padEnd(44)} ${out.join('  ')}`);
}

console.log('=== do refs resolve, and what invalidates them? ===');
await resolveAll('right after the ai snapshot');
await resolveAll('again, nothing happened in between');
const def = await page.ariaSnapshot({ mode: 'default' });
await resolveAll('after a default-mode snapshot');
const ai1b = await page.ariaSnapshot({ mode: 'ai' });
await resolveAll('after another ai snapshot (same page)');
console.log(`ai snapshot text identical to the first one: ${ai1b === ai}`);

console.log('\n=== which markers reach the snapshot ===');
const markers = [...new Set(html.match(/PROBE-[a-z-]+/g))];
for (const m of markers) console.log(`${m.padEnd(26)} ai:${ai.includes(m) ? 'YES' : 'no '}  default:${def.includes(m) ? 'YES' : 'no '}`);
console.log(`\nrefs in ai: ${(ai.match(/\[ref=/g) ?? []).length}, in default: ${(def.match(/\[ref=/g) ?? []).length}; url lines: ${(ai.match(/\/url: .*/g) ?? []).join(' | ')}`);

console.log('\n=== what happens to refs when the page changes ===');
await page.evaluate(() => { const p = document.createElement('p'); p.textContent = 'PROBE-inserted-at-top'; document.body.prepend(p); });
const ai3 = await page.ariaSnapshot({ mode: 'ai' });
console.log(`link ref before inserting a paragraph at the top: ${refs.link}, after: ${refOf(ai3, 'PROBE-link-text')}, new paragraph got: ${refOf(ai3, 'PROBE-inserted-at-top')}`);
await page.evaluate(() => { const a = document.querySelector('a'); a.replaceWith(a.cloneNode(true)); });
console.log(`after replacing the link element by a clone, the old ref resolves to ${await page.locator(`aria-ref=${refs.link}`).count()} element(s)`);
const ai4 = await page.ariaSnapshot({ mode: 'ai' });
console.log(`the clone has the ref: ${refOf(ai4, 'PROBE-link-text')}`);
await page.evaluate(() => document.querySelector('a').remove());
console.log(`after removing the link from the DOM, ref ${refOf(ai4, 'PROBE-link-text')} resolves to ${await page.locator(`aria-ref=${refOf(ai4, 'PROBE-link-text')}`).count()} element(s)`);
await page.goto('about:blank');
console.log(`after navigating away, the old button ref ${refs.button} resolves to ${await page.locator(`aria-ref=${refs.button}`).count()} element(s)`);

console.log('\n=== does depth do anything? (8 nested levels, text on every level) ===');
await page.setContent(`<body>${Array.from({ length: 8 }, (_, i) => `<div>level-${i}`).join('')}${'</div>'.repeat(8)}</body>`);
for (const opts of [{ mode: 'ai' }, { mode: 'ai', depth: 2 }, { mode: 'ai', depth: 4 }]) {
  const s = await page.ariaSnapshot(opts);
  console.log(`${JSON.stringify(opts).padEnd(26)} lines=${s.split('\n').length} deepest level included: ${s.includes('level-7')}`);
}

console.log('\n=== size and time on a large page (3000 paragraphs with a link each) ===');
const big = `<html><body>${Array.from({ length: 3000 }, (_, i) => `<p>item ${i} <a href="https://e.example/${i}">link ${i}</a></p>`).join('')}</body></html>`;
await page.setContent(big);
const t0 = Date.now();
const s = await page.ariaSnapshot({ mode: 'ai' });
console.log(`ai: ${Date.now() - t0} ms, ${s.length} chars, ${s.split('\n').length} lines, ${(s.match(/\[ref=/g) ?? []).length} refs`);
await browser.close();
