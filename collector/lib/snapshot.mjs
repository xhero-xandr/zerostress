import { LIMITS, cut, cutBytes } from './limits.mjs';

/**
 * The only snapshot call in the collector. Mode "ai" gives stable aria-ref links; mode "default" would reset
 * every ref already handed out (spec 005, 3.4), so it must never be used.
 */
export async function takeSnapshot(page) {
  const full = await page.ariaSnapshot({ mode: 'ai', timeout: LIMITS.snapshotTimeoutMs });
  // Links come from the whole snapshot: a page must not be able to push them out of the report by padding it with text.
  const links = parseLinks(full);
  let truncated = false;
  let lines = full.split('\n');
  if (lines.length > LIMITS.snapshotLines) {
    lines = lines.slice(0, LIMITS.snapshotLines);
    truncated = true;
  }
  let text = lines.join('\n');
  if (Buffer.byteLength(text) > LIMITS.snapshotBytes) {
    text = cutBytes(text, LIMITS.snapshotBytes);
    truncated = true;
  }
  return { text, lines: text === '' ? 0 : text.split('\n').length, truncated, links };
}

const LINK_LINE = /^\s*- link(?: "((?:[^"\\]|\\.)*)")?(?: \[[^\]]*\])*? \[ref=([a-z0-9]+)\]/;
const URL_LINE = /^\s*- \/url: (.*)$/;

/** Links of the (already cut) snapshot: ref, visible text and href, in document order. */
export function parseLinks(text) {
  const lines = text.split('\n');
  const links = [];
  for (let i = 0; i < lines.length && links.length < LIMITS.links; i++) {
    const m = LINK_LINE.exec(lines[i]);
    if (!m) continue;
    let name = m[1] ?? '';
    try {
      name = JSON.parse(`"${name}"`);
    } catch {
      // keep the raw text
    }
    let href = '';
    for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
      const u = URL_LINE.exec(lines[j]);
      if (u) {
        href = u[1];
        break;
      }
      if (/^\s*- link/.test(lines[j])) break;
    }
    links.push({ ref: m[2], text: cut(name, LIMITS.linkTextChars), href: cut(href, LIMITS.urlChars) });
  }
  return links;
}

export function withOrigins(links, pageUrl) {
  let base;
  try {
    base = new URL(pageUrl).origin;
  } catch {
    base = '';
  }
  return links.map((l) => {
    let differs;
    try {
      differs = new URL(l.href, pageUrl).origin !== base;
    } catch {
      differs = true; // not a URL at all
    }
    return { ...l, origin_differs: differs };
  });
}
