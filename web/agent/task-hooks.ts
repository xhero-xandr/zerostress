// The hooks of one task as a single latch (docs/containment.md, rule 9). The guarded hooks inspect the page's events;
// everything else the agent scans (the dossier it builds, the model's own words) goes through scan() here, so that a
// finding anywhere in the task is remembered for the rest of it: the next model call, the final assessment, the report
// and the chat all read the same `triggered`, and it never goes back to false.

import { scanText, showsInjection, type Finding, type HookState, type TextScan } from '../hooks/index.ts';

export interface TaskHooks {
  /** true once anything in this task has tripped the hooks */
  readonly triggered: boolean;
  /** true when what tripped them is text aimed at a model, not only text that could not be inspected (B5) */
  readonly injection: boolean;
  /** scans one text of ours (made from the page or by the model); resolves to whether it tripped the hooks */
  scan(place: string, text: string): Promise<boolean>;
  /** the findings of the page's events and of every scan(), in order */
  findings(): Finding[];
}

const MAX_OWN_FINDINGS = 200;

/** Where the texts are scanned: the task's guarded thread (runner.ts); tests may scan in place. */
export interface TextScanner {
  scan(place: string, text: string): Promise<TextScan>;
}
const inPlace: TextScanner = { scan: async (place, text) => scanText(place, text) };

export function taskHooks(events: () => Pick<HookState, 'triggered' | 'findings'> = () => ({ triggered: false, findings: [] }), scanner: TextScanner = inPlace): TaskHooks {
  let fired = false;
  const own: Finding[] = [];
  return {
    get triggered() { return fired || events().triggered; },
    get injection() { return showsInjection(this.triggered, this.findings()); },
    async scan(place, text) {
      const r = await scanner.scan(place, text);
      if (!r.triggered) return false;
      fired = true;
      own.push(...r.findings.slice(0, Math.max(0, MAX_OWN_FINDINGS - own.length)));
      return true;
    },
    findings: () => [...events().findings, ...own],
  };
}
