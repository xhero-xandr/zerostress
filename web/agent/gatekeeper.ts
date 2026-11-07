// The gatekeeper of the agent's actions (spec 008, 5). The model proposes; this code decides. It never takes an id, a
// snapshot number or a text from the proposal: it builds the command itself from the page as it stands, and it only
// lets through the small set of actions the model may ask for. Anything risky is passed on marked as needing a
// person; the agent never approves anything itself (docs/containment.md, rules 8 and 9).

import { REF, validateCommand, type Risk } from './commands.ts';

type Ev = Record<string, unknown>;
const isObj = (v: unknown): v is Ev => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The actions a model may propose, with the parameters each accepts and their limits. */
const MODEL_ACTIONS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  snapshot: [],
  scroll: ['dy'],
  wait: ['ms'],
  screenshot: [],
  open_link: ['ref'],
  back: [],
  download: ['ref'],
});
const SCROLL_MAX = 3000;
const WAIT_MAX = 3000;

export type Reason =
  | 'bad_proposal'
  | 'unknown_action'
  | 'not_allowed_for_model'
  | 'bad_params'
  | 'no_snapshot'
  | 'ref_not_in_links'
  | 'repeat'
  | 'step_limit';

export type Decision =
  | { ok: true; command: Record<string, unknown>; line: string; risk: Risk; needsApproval: boolean }
  | { ok: false; reason: Reason };

export interface GatekeeperState {
  /** the number of the latest snapshot, null before the first */
  snap: number | null;
  /** the references of the links in that snapshot */
  refs: string[];
  steps: number;
}

export interface Gatekeeper {
  /** shows the gatekeeper one evidence event (already inspected by the hooks) */
  observe(event: unknown): void;
  /** judges one proposal of the model */
  decide(proposal: unknown): Decision;
  state(): GatekeeperState;
}

export function createGatekeeper(opts: { maxSteps?: number } = {}): Gatekeeper {
  const maxSteps = opts.maxSteps ?? 5;
  let snap: number | null = null;
  let refs = new Set<string>();
  let steps = 0;
  let nextId = 1;
  const used = new Set<string>();

  return {
    observe(event) {
      if (!isObj(event)) return;
      if (event.kind === 'snapshot' && typeof event.snap === 'number' && Number.isInteger(event.snap) && event.snap >= 0) {
        if (snap === null || event.snap >= snap) {
          snap = event.snap;
          refs = new Set(); // links of an older snapshot are dead
        }
      } else if (event.kind === 'links' && snap !== null && event.snap === snap && Array.isArray(event.links)) {
        refs = new Set();
        for (const l of event.links.slice(0, 100)) {
          if (isObj(l) && typeof l.ref === 'string' && REF.test(l.ref)) refs.add(l.ref);
        }
      }
    },

    decide(proposal) {
      if (!isObj(proposal)) return { ok: false, reason: 'bad_proposal' };
      const action = proposal.action;
      if (typeof action !== 'string') return { ok: false, reason: 'bad_proposal' };
      if (!Object.hasOwn(MODEL_ACTIONS, action)) {
        // close and submit_form exist, but not for a model
        return { ok: false, reason: action === 'close' || action === 'submit_form' ? 'not_allowed_for_model' : 'unknown_action' };
      }
      const allowed = ['action', ...MODEL_ACTIONS[action]!];
      if (Object.keys(proposal).some((k) => !allowed.includes(k))) return { ok: false, reason: 'bad_params' };
      if (steps >= maxSteps) return { ok: false, reason: 'step_limit' };

      const command: Record<string, unknown> = { cmd: action, id: `a${nextId}` };
      if (action === 'scroll') {
        const dy = proposal.dy;
        if (typeof dy !== 'number' || !Number.isInteger(dy) || Math.abs(dy) > SCROLL_MAX) return { ok: false, reason: 'bad_params' };
        command.dy = dy;
      } else if (action === 'wait') {
        const ms = proposal.ms;
        if (typeof ms !== 'number' || !Number.isInteger(ms) || ms < 0 || ms > WAIT_MAX) return { ok: false, reason: 'bad_params' };
        command.ms = ms;
      } else if (action === 'open_link' || action === 'download') {
        if (snap === null) return { ok: false, reason: 'no_snapshot' };
        const ref = proposal.ref;
        if (typeof ref !== 'string' || !REF.test(ref)) return { ok: false, reason: 'bad_params' };
        if (!refs.has(ref)) return { ok: false, reason: 'ref_not_in_links' };
        if (used.has(`${action}:${snap}:${ref}`)) return { ok: false, reason: 'repeat' };
        command.snap = snap;
        command.ref = ref;
      }

      // the final word is the same check the supervisor makes: a command that fails it is never produced
      const line = JSON.stringify(command);
      const v = validateCommand(line);
      if (!v.ok) return { ok: false, reason: 'bad_params' };
      if (typeof command.ref === 'string') used.add(`${action}:${snap}:${command.ref}`);
      steps++;
      nextId++;
      return { ok: true, command, line, risk: v.risk, needsApproval: v.risk === 'risky' };
    },

    state() {
      return { snap, refs: [...refs], steps };
    },
  };
}
