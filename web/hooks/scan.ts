// Scanning one string (spec 009, 3.2-3.5): views, decoding layers, activation, cutting.

import { MAX_DECODED, encodedTokens, unescapeText } from './decode.ts';
import {
  buildView, originSpan, reversed, rot13, squash,
  type Fold, type OriginMap, type View, type ViewName,
} from './normalize.ts';
import { RULES, SQUASHED_CYR, SQUASHED_LAT, type Category, type Strength } from './rules.ts';

export const MAX_STRING = 256 * 1024;
export const MAX_DEPTH = 2;
export const REMOVED = '[removed: instruction aimed at an AI agent]';
const MAX_HITS = 200;
const QUOTE_MAX = 160;

export interface Finding {
  rule: string;
  category: Category | 'error' | 'size';
  strength: Strength;
  place: string;
  view: ViewName | 'decoded' | 'none';
  layer: number;
  /** the removed fragment, clipped. It is page content: data, never instructions, escaped wherever it is shown */
  quote: string;
}

interface Hit {
  rule: string;
  category: Category;
  strength: Strength;
  view: ViewName | 'decoded';
  layer: number;
  s: number;
  e: number;
}

export interface ScanResult {
  text: string;
  findings: Finding[];
  /** a rule fired strongly enough to count (strong rule, or two kinds of weak ones) */
  triggered: boolean;
}

class Views {
  private cache = new Map<ViewName, View>();
  src: string;
  origin: OriginMap | undefined;
  constructor(src: string, origin?: OriginMap) {
    this.src = src;
    this.origin = origin;
  }
  get(name: ViewName): View {
    let v = this.cache.get(name);
    if (v) return v;
    switch (name) {
      case 'lat': case 'leet': case 'cyr': case 'raw':
        v = buildView(this.src, name as Fold, this.origin);
        break;
      case 'squashed_lat': v = squash(this.get('lat'), name); break;
      case 'squashed_cyr': v = squash(this.get('cyr'), name); break;
      case 'rot13': v = rot13(this.get('lat')); break;
      case 'reversed': v = reversed(this.get('lat')); break;
    }
    this.cache.set(name, v);
    return v;
  }
}

function viewHits(src: string, origin: OriginMap | undefined, layer: number): Hit[] {
  const views = new Views(src, origin);
  const hits: Hit[] = [];
  const seen = new Set<string>();
  const record = (rule: string, category: Category, strength: Strength, view: ViewName | 'decoded', v: View, from: number, to: number) => {
    const [s, e] = originSpan(v, from, to);
    const key = `${rule}:${s}:${e}`;
    if (seen.has(key) || hits.length >= MAX_HITS) return;
    seen.add(key);
    hits.push({ rule, category, strength, view, layer, s, e });
  };
  for (const rule of RULES) {
    for (const name of rule.views) {
      const v = views.get(name);
      if (!v.text) continue;
      rule.re.lastIndex = 0;
      for (const m of v.text.matchAll(rule.re)) {
        if (m[0].length === 0) continue;
        record(rule.id, rule.category, rule.strength, name, v, m.index!, m.index! + m[0].length);
        if (hits.length >= MAX_HITS) return hits;
      }
    }
  }
  for (const [name, phrases, id] of [['squashed_lat', SQUASHED_LAT, 'override.squashed'], ['squashed_cyr', SQUASHED_CYR, 'ru.override.squashed']] as const) {
    const v = views.get(name);
    if (!v.text) continue;
    for (const p of phrases) {
      let at = v.text.indexOf(p);
      while (at >= 0 && hits.length < MAX_HITS) {
        record(id, 'override', 'strong', name, v, at, at + p.length);
        at = v.text.indexOf(p, at + p.length);
      }
    }
  }
  return hits;
}

/** Strong hits always count; weak ones only when two different kinds of them meet in the same string. */
function active(hits: Hit[]): Hit[] {
  const weakKinds = new Set(hits.filter((h) => h.strength === 'weak').map((h) => h.category));
  return hits.filter((h) => h.strength === 'strong' || weakKinds.size >= 2);
}

function collect(src: string, layer: number): Hit[] {
  const hits = viewHits(src, undefined, layer);
  const un = unescapeText(src);
  if (un && un.text.length <= MAX_STRING) hits.push(...viewHits(un.text, un.origin, layer).map((h) => ({ ...h, view: 'decoded' as const })));
  if (layer < MAX_DEPTH) {
    for (const t of encodedTokens(src)) {
      if (t.kind === 'tags') {
        // invisible text has no honest use: its presence is a finding, whatever it says
        hits.push({ rule: 'smuggle.tags', category: 'smuggle', strength: 'strong', view: 'decoded', layer: layer + 1, s: t.s, e: t.e });
        continue;
      }
      if (t.decoded.length > MAX_DECODED) continue;
      const inner = active(collect(t.decoded, layer + 1));
      if (inner.length) {
        const h = inner[0]!;
        hits.push({ rule: h.rule, category: h.category, strength: 'strong', view: 'decoded', layer: layer + 1, s: t.s, e: t.e });
      }
    }
  }
  return hits.slice(0, MAX_HITS);
}

/** The enclosing line (up to 800 characters), else the sentence around the match (at most 300 either side). */
function expand(src: string, s: number, e: number): [number, number] {
  const ls = src.lastIndexOf('\n', s - 1) + 1;
  let le = src.indexOf('\n', e);
  if (le < 0) le = src.length;
  if (le - ls <= 800) return [ls, le];
  let a = Math.max(ls, s - 300);
  for (let i = s - 1; i >= a; i--) {
    if (/[.!?]/.test(src[i]!)) { a = i + 1; break; }
  }
  let z = Math.min(le, e + 300);
  for (let i = e; i < z; i++) {
    if (/[.!?]/.test(src[i]!)) { z = i + 1; break; }
  }
  return [a, z];
}

export function scanString(place: string, input: string): ScanResult {
  const findings: Finding[] = [];
  let src = input;
  let oversize = false;
  if (src.length > MAX_STRING) {
    src = src.slice(0, MAX_STRING);
    oversize = true;
  }
  const found = collect(src, 0);
  if (found.length >= MAX_HITS) {
    // the scan stopped counting: whatever follows was not examined, so none of the string goes on
    const quote = src.slice(0, QUOTE_MAX);
    const fs = active(found).map((h): Finding => ({ rule: h.rule, category: h.category, strength: h.strength, place, view: h.view, layer: h.layer, quote }));
    fs.push({ rule: 'overflow', category: 'size', strength: 'strong', place, view: 'none', layer: 0, quote });
    return { text: REMOVED, findings: fs, triggered: true };
  }
  const hits = active(found);
  const spans: Array<[number, number]> = hits.map((h) => expand(src, h.s, h.e));
  const order = spans.map((_, i) => i).sort((a, b) => spans[a]![0] - spans[b]![0]);
  const merged: Array<{ s: number; e: number; hits: Hit[] }> = [];
  for (const i of order) {
    const [s, e] = spans[i]!;
    const last = merged[merged.length - 1];
    if (last && s <= last.e) {
      last.e = Math.max(last.e, e);
      last.hits.push(hits[i]!);
    } else {
      merged.push({ s, e, hits: [hits[i]!] });
    }
  }
  let out = '';
  let at = 0;
  for (const m of merged) {
    out += src.slice(at, m.s) + REMOVED;
    at = m.e;
    const quote = src.slice(m.s, m.e).slice(0, QUOTE_MAX);
    for (const h of m.hits) findings.push({ rule: h.rule, category: h.category, strength: h.strength, place, view: h.view, layer: h.layer, quote });
  }
  out += src.slice(at);
  if (oversize) {
    out += REMOVED;
    findings.push({ rule: 'oversize', category: 'size', strength: 'strong', place, view: 'none', layer: 0, quote: '' });
  }
  return { text: out, findings, triggered: findings.length > 0 };
}
