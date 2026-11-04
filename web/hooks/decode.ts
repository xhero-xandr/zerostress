// Decoding layers (spec 009, 3.3): text that a page wrote in an encoded form so that a plain match would miss it.

import type { OriginMap } from './normalize.ts';

export const MAX_TOKENS = 50;
export const MAX_DECODED = 8 * 1024;

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', shy: '' };

/**
 * Decodes percent escapes, HTML entities and \uXXXX / \xXX escapes in one left-to-right pass.
 * Returns null when nothing was decoded. Every output character maps back to the escape it came from.
 */
export function unescapeText(src: string): { text: string; origin: OriginMap } | null {
  const out: string[] = [];
  const start: number[] = [];
  const end: number[] = [];
  let changed = false;
  const emit = (s: string, a: number, b: number) => {
    for (let k = 0; k < s.length; k++) {
      out.push(s[k]!);
      start.push(a);
      end.push(b);
    }
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === '%' && /^%[0-9a-fA-F]{2}/.test(src.slice(i, i + 3))) {
      const bytes: number[] = [];
      let j = i;
      while (j + 2 < src.length + 0 && src[j] === '%' && /^[0-9a-fA-F]{2}$/.test(src.slice(j + 1, j + 3))) {
        bytes.push(parseInt(src.slice(j + 1, j + 3), 16));
        j += 3;
      }
      emit(new TextDecoder('utf-8').decode(Uint8Array.from(bytes)), i, j);
      changed = true;
      i = j;
      continue;
    }
    if (c === '&') {
      const m = /^&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z]{2,8}));/.exec(src.slice(i, i + 12));
      if (m) {
        let ch: string | undefined;
        if (m[1] !== undefined || m[2] !== undefined) {
          const cp = m[1] !== undefined ? parseInt(m[1], 10) : parseInt(m[2]!, 16);
          ch = cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : '';
        } else {
          ch = NAMED[m[3]!.toLowerCase()];
        }
        if (ch !== undefined) {
          emit(ch, i, i + m[0].length);
          changed = true;
          i += m[0].length;
          continue;
        }
      }
    }
    if (c === '\\') {
      const u = /^\\u([0-9a-fA-F]{4})/.exec(src.slice(i, i + 6));
      const x = /^\\x([0-9a-fA-F]{2})/.exec(src.slice(i, i + 4));
      const m = u ?? x;
      if (m) {
        emit(String.fromCharCode(parseInt(m[1]!, 16)), i, i + m[0].length);
        changed = true;
        i += m[0].length;
        continue;
      }
    }
    emit(c, i, i + 1);
    i++;
  }
  return changed ? { text: out.join(''), origin: { start, end } } : null;
}

export interface Token {
  s: number;
  e: number;
  decoded: string;
  kind: 'base64' | 'tags';
}

const B64 = /[A-Za-z0-9+/_-]{24,}={0,2}/g;
const TAGS = /[\u{E0020}-\u{E007E}]{12,}/gu;

function printableUtf8(bytes: Uint8Array): string | null {
  let s: string;
  try {
    s = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  if (s.length < 8) return null;
  let ok = 0;
  for (const ch of s) if (/[\p{L}\p{N}\p{P}\p{S}\s]/u.test(ch)) ok++;
  return ok / [...s].length >= 0.9 ? s : null;
}

/** base64 runs that decode to readable text, and runs of invisible "tag" characters (ASCII smuggling). */
export function encodedTokens(src: string): Token[] {
  const found: Token[] = [];
  for (const m of src.matchAll(TAGS)) {
    if (found.length >= MAX_TOKENS) break;
    const decoded = [...m[0]].map((ch) => String.fromCharCode(ch.codePointAt(0)! - 0xe0000)).join('');
    found.push({ s: m.index!, e: m.index! + m[0].length, decoded, kind: 'tags' });
  }
  for (const m of src.matchAll(B64)) {
    if (found.length >= MAX_TOKENS) break;
    const tok = m[0].replace(/=+$/, '');
    let bytes: Uint8Array;
    try {
      bytes = Buffer.from(tok.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    } catch {
      continue;
    }
    if (bytes.length > MAX_DECODED) continue;
    const s = printableUtf8(bytes);
    if (s) found.push({ s: m.index!, e: m.index! + m[0].length, decoded: s, kind: 'base64' });
  }
  return found;
}
