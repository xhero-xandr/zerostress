// Text views for the injection hooks (spec 009, 3.2). Every view keeps, for each character, the span of the ORIGINAL
// text it came from, so a match found in a normalised view can be cut out of the original.

export type ViewName = 'lat' | 'leet' | 'cyr' | 'raw' | 'squashed_lat' | 'squashed_cyr' | 'rot13' | 'reversed';

export interface View {
  name: ViewName;
  text: string;
  /** start[i], end[i]: the span of the original text that produced text[i] (end exclusive) */
  start: number[];
  end: number[];
}

/** Position map of a decoded string back to the text it was decoded from. */
export interface OriginMap {
  start: number[];
  end: number[];
}

const MARK = /\p{M}/u;
const WS = /^\s$/u;
// invisible characters that carry no text for a human; a few fillers that \p{Cf} does not cover
const IGNORABLE = /^(?:[\p{Cf}\p{Cc}\p{Cs}\p{Co}\p{Cn}\p{Variation_Selector}ᅟᅠㅤﾠ⠀])$/u;

// Cyrillic and Greek letters that look like Latin ones (after lower-casing)
const TO_LATIN: Record<string, string> = {
  а: 'a', в: 'b', е: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x', і: 'i', ї: 'i', ј: 'j',
  ѕ: 's', ԁ: 'd', ԛ: 'q', ԝ: 'w', ӏ: 'i', ɡ: 'g', ı: 'i', ſ: 's', ɑ: 'a', ο: 'o', α: 'a', ν: 'v', ρ: 'p', τ: 't',
  υ: 'u', κ: 'k', ι: 'i', ε: 'e', χ: 'x', β: 'b', μ: 'm', η: 'n',
};
// Latin letters that look like Cyrillic ones
const TO_CYRILLIC: Record<string, string> = {
  a: 'а', c: 'с', e: 'е', o: 'о', p: 'р', x: 'х', y: 'у', k: 'к', m: 'м', h: 'н', t: 'т', i: 'и', і: 'и', ї: 'и',
};
const LEET: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', $: 's' };

export type Fold = 'lat' | 'leet' | 'cyr' | 'raw';

function mapChar(c: string, fold: Fold): string {
  switch (fold) {
    case 'lat':
      return TO_LATIN[c] ?? c;
    case 'leet': {
      const l = TO_LATIN[c] ?? c;
      return LEET[l] ?? l;
    }
    case 'cyr':
      return TO_CYRILLIC[c] ?? c;
    default:
      return c;
  }
}

/** Builds one normalised view of `src`. `origin` maps the characters of `src` to an earlier text (decoded layers). */
export function buildView(src: string, fold: Fold, origin?: OriginMap): View {
  const chars: string[] = [];
  const start: number[] = [];
  const end: number[] = [];
  const decompose = fold !== 'raw';
  let off = 0;
  const push = (s: string, a: number, b: number) => {
    for (let k = 0; k < s.length; k++) {
      chars.push(s[k]!);
      start.push(a);
      end.push(b);
    }
  };
  for (const ch of src) {
    const i0 = off;
    off += ch.length;
    const a = origin ? origin.start[i0]! : i0;
    const b = origin ? origin.end[off - 1]! : off;
    if (WS.test(ch)) {
      const nl = ch === '\n' || ch === '\r' || ch === ' ' || ch === ' ';
      const last = chars.length - 1;
      if (last >= 0 && (chars[last] === ' ' || chars[last] === '\n')) {
        if (nl) chars[last] = '\n';
        end[last] = Math.max(end[last]!, b);
        continue;
      }
      push(nl ? '\n' : ' ', a, b);
      continue;
    }
    if (IGNORABLE.test(ch)) continue;
    for (const c of ch.normalize(decompose ? 'NFKD' : 'NFKC')) {
      if (decompose && MARK.test(c)) continue;
      for (const lc of c.toLowerCase()) push(mapChar(lc, fold), a, b);
    }
  }
  return { name: fold, text: chars.join(''), start, end };
}

/** Keeps only letters and digits: catches "i.g.n.o.r.e" and "и г н о р и р у й". */
export function squash(v: View, name: ViewName): View {
  const chars: string[] = [];
  const start: number[] = [];
  const end: number[] = [];
  for (let i = 0; i < v.text.length; i++) {
    const c = v.text[i]!;
    if (/[\p{L}\p{N}]/u.test(c)) {
      chars.push(c);
      start.push(v.start[i]!);
      end.push(v.end[i]!);
    }
  }
  return { name, text: chars.join(''), start, end };
}

export function rot13(v: View): View {
  const text = v.text.replace(/[a-z]/g, (c) => String.fromCharCode(((c.charCodeAt(0) - 97 + 13) % 26) + 97));
  return { name: 'rot13', text, start: v.start, end: v.end };
}

export function reversed(v: View): View {
  return { name: 'reversed', text: [...v.text].reverse().join(''), start: [...v.start].reverse(), end: [...v.end].reverse() };
}

/** The span of the original text behind v.text[from, to). */
export function originSpan(v: { start: number[]; end: number[] }, from: number, to: number): [number, number] {
  let s = Infinity;
  let e = -Infinity;
  for (let i = from; i < to; i++) {
    if (v.start[i]! < s) s = v.start[i]!;
    if (v.end[i]! > e) e = v.end[i]!;
  }
  return [s, e];
}

/** Folds a pattern source the same way the cyrillic view folds text (й → и, ё → е). */
export function foldPattern(s: string): string {
  return s.normalize('NFKD').replace(/\p{M}/gu, '');
}
