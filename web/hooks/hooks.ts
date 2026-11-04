// The task-level hooks (spec 009, 3.1 and 3.6): every string of every evidence event is inspected before anything
// reaches a model; the first finding turns the task to "rules only" for good.

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
    return { text: WITHHELD, triggered: true, findings: [errorFinding(place)] };
  }
}

function errorFinding(place: string): Finding {
  return { rule: 'hook_error', category: 'error', strength: 'strong', place, view: 'none', layer: 0, quote: '' };
}

export interface Hooks {
  inspect(event: unknown): Inspected;
  state(): HookState;
}

export function createHooks(): Hooks {
  let triggered = false;
  const all: Finding[] = [];

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

  return {
    inspect(event) {
      const findings: Finding[] = [];
      try {
        const failed = { v: false };
        const out = walk(event, '', 0, findings, failed);
        // the place of the event: its kind, so findings read as "page.hidden_text.text"
        const kind = event && typeof event === 'object' && typeof (event as { kind?: unknown }).kind === 'string' ? (event as { kind: string }).kind : '';
        const named = findings.map((f) => ({ ...f, place: kind ? `${kind}.${f.place}`.replace(/\.$/, '') : f.place }));
        keep(named);
        return { event: out, findings: named };
      } catch {
        const f = [errorFinding('event')];
        keep(f);
        let safe: unknown;
        try {
          safe = withhold(event, 0);
        } catch {
          safe = { withheld: true }; // even walking the event failed: nothing of it goes on
        }
        return { event: safe, findings: f };
      }
    },
    state() {
      return {
        triggered,
        mode: triggered ? 'rules_only' : 'model',
        require_confirmation: triggered,
        signal: triggered ? 'injection_attempt' : null,
        findings: [...all],
      };
    },
  };
}
