// The task-level hooks (spec 009, 3.1 and 3.6): every string of every evidence event is inspected before anything
// reaches a model; the first finding turns the task to "rules only" for good.

import type { Category } from './rules.ts';
import { weakActivates } from './rules.ts';
import { scanString, type Finding, type ScanResult } from './scan.ts';

/** Keys that carry the event's own structure, written by the collector, not by the page. */
const STRUCTURAL = new Set(['type', 'v', 'kind', 't', 'sha256']);
const MAX_DEPTH = 12;
/** A structural value is exempt only while it has the plain shape the collector gives it; anything else is scanned. */
function structuralOk(key: string, v: unknown): boolean {
  if (typeof v === 'number') return true;
  if (typeof v !== 'string') return false;
  return key === 'sha256' ? /^[0-9a-f]{64}$/.test(v) : /^[a-z0-9_]{1,40}$/.test(v);
}
const MAX_FINDINGS = 500;
const WITHHELD = '[withheld: inspection failed]';

export type Mode = 'model' | 'rules_only';

export interface HookState {
  triggered: boolean;
  mode: Mode;
  require_confirmation: boolean;
  /** signal for the rules that raise the risk (spec 008); null while nothing was found */
  signal: 'injection_attempt' | null;
  findings: Finding[];
}

export interface Inspected {
  event: unknown;
  findings: Finding[];
}

/** Inspects text that does not come from an evidence event (OCR output, attachment names). */
export function scanText(place: string, text: string): ScanResult {
  try {
    return scanString(place, text);
  } catch {
    return { text: WITHHELD, triggered: true, findings: [errorFinding(place)], weak: [] };
  }
}

function errorFinding(place: string): Finding {
  return { rule: 'hook_error', category: 'error', strength: 'strong', place, view: 'none', layer: 0, quote: '' };
}

function withhold(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) return WITHHELD;
  if (typeof value === 'string') return WITHHELD;
  if (Array.isArray(value)) return value.map((x) => withhold(x, depth + 1));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (depth === 0 && STRUCTURAL.has(k) && structuralOk(k, v)) out[k] = v;
      else out[`withheld_${Object.keys(out).length}`] = withhold(v, depth + 1);
    }
    return out;
  }
  return value;
}

/** The event with every string replaced by a placeholder; if even that cannot be built, an empty marker. */
export function withholdEvent(event: unknown): unknown {
  try {
    return withhold(event, 0);
  } catch {
    return { withheld: true };
  }
}

export function makeFinding(rule: string, place: string): Finding {
  return { ...errorFinding(place), rule };
}

export function makeState(triggered: boolean, findings: Finding[]): HookState {
  return {
    triggered,
    mode: triggered ? 'rules_only' : 'model',
    require_confirmation: triggered,
    signal: triggered ? 'injection_attempt' : null,
    findings: [...findings],
  };
}

/**
 * Runs one harmless text through every code path (all rule sets, the decoders), so that the first real event does not
 * pay for compiling them: in a fresh thread that is 200-300 ms. The state it touches is thrown away.
 */
export function warmUp(): void {
  const sample = [
    'Opening hours 9 to 5. Привет мир, как дела? 你好，欢迎来到我们的网站。 Hola, bonjour, guten Tag.',
    'aGVsbG8gd29ybGQgdGhpcyBpcyBhIHRlc3Q= 100%25 sure &amp; &#65; café',
  ].join(String.fromCharCode(10));
  createHooks().inspect({ type: 'evidence', kind: 'warm', text: sample, list: [sample], nested: { text: sample } });
}

export interface Hooks {
  inspect(event: unknown): Inspected;
  state(): HookState;
}

export function createHooks(): Hooks {
  let triggered = false;
  const all: Finding[] = [];
  // Weak signals do not fire alone, but a page can spread them over fields and events: the task adds them up.
  const taskWeak = new Map<Category, string[]>();
  let eventWeak: Array<[Category, string]> = [];
  let accumulated = false;

  const keep = (fs: Finding[]) => {
    if (fs.length) triggered = true;
    for (const f of fs) if (all.length < MAX_FINDINGS) all.push(f);
  };

  function walk(value: unknown, place: string, depth: number, findings: Finding[], failed: { v: boolean }): unknown {
    if (depth > MAX_DEPTH) {
      findings.push({ ...errorFinding(place), rule: 'depth' });
      failed.v = true;
      return WITHHELD;
    }
    if (typeof value === 'string') {
      const r = scanString(place, value);
      findings.push(...r.findings);
      for (const c of r.weak) eventWeak.push([c, place]);
      return r.text;
    }
    if (Array.isArray(value)) return value.map((x, i) => walk(x, `${place}[${i}]`, depth + 1, findings, failed));
    if (value !== null && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      let n = 0;
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        const here = place ? `${place}.${k}` : k;
        if (depth === 0 && STRUCTURAL.has(k) && structuralOk(k, v)) {
          out[k] = v;
          continue;
        }
        const key = scanString(`${here}#key`, k);
        findings.push(...key.findings);
        const name = key.findings.length ? `removed_key_${n++}` : k;
        out[name] = walk(v, here, depth + 1, findings, failed);
      }
      return out;
    }
    return value;
  }

  return {
    inspect(event) {
      const findings: Finding[] = [];
      eventWeak = [];
      try {
        const failed = { v: false };
        const out = walk(event, '', 0, findings, failed);
        // the place of the event: its kind, so findings read as "page.hidden_text.text"
        const kind = event && typeof event === 'object' && typeof (event as { kind?: unknown }).kind === 'string' ? (event as { kind: string }).kind : '';
        const named = findings.map((f) => ({ ...f, place: kind ? `${kind}.${f.place}`.replace(/\.$/, '') : f.place }));
        for (const [c, p] of eventWeak) {
          const where = taskWeak.get(c) ?? [];
          if (where.length < 5) where.push(kind ? `${kind}.${p}` : p);
          taskWeak.set(c, where);
        }
        if (!accumulated && weakActivates(new Set(taskWeak.keys()))) {
          accumulated = true;
          named.push({
            rule: 'accumulated', category: 'accumulated', strength: 'strong', view: 'none', layer: 0, quote: '',
            place: [...taskWeak.entries()].map(([c, w]) => `${c}@${w.join('|')}`).join(' '),
          });
        }
        keep(named);
        return { event: out, findings: named };
      } catch {
        const f = [errorFinding('event')];
        keep(f);
        return { event: withholdEvent(event), findings: f };
      }
    },
    state() {
      return makeState(triggered, all);
    },
  };
}
