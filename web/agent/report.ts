// The report the web layer shows (spec 008, 7 and spec 009, 3.7). Two views of one result:
//
//   public: what the person who submitted the address sees. It says what was found and how sure we are, in our words
//           and with the model's explanation, but not WHICH of the hooks' rules fired or where: whoever can read that
//           can try pages until one gets past (spec 009, 3.7), and the submitter may well be the author of the page.
//   owner:  what the owner of the service sees, for debugging: the rule names and places, the commands as sent, the
//           tokens, the versions, the notes.
//
// Both are built by copying listed fields, never by deleting the unwanted ones: a field added to the result later does
// not appear in a report until someone puts it here. UNTRUSTED lists the fields whose text comes from the page, the
// submitter or the model; the web layer must escape them and may never put them where the browser would read them as
// markup, script or an instruction (spec 007).

import type { Assessment } from './assess.ts';
import type { TaskResult } from './runner.ts';

export const REPORT_SCHEMA = 1;

/** Fields (paths in the report) whose text is not ours. */
export const UNTRUSTED: readonly string[] = [
  'url',
  'summary',
  'reasons[].claim',
  // a path into a field of the dossier can end in text the model chose ("forms.<anything>")
  'reasons[].evidence[]',
  // our sentence, but it may carry a label taken from the address ("... its address is <label>")
  'signals[].text',
  'owner.steps[].error',
  'owner.hook_findings[].place',
  'owner.notes[]',
];

/** Our own sentence for each reason the model was not used (or not trusted). */
export const MODE_TEXT: Readonly<Record<string, string>> = {
  hooks_fired: 'The page contains text addressed to an automated reader. The verdict comes from fixed rules only, and no model was asked.',
  no_model_configured: 'No model was used. The verdict comes from fixed rules.',
  budget: 'The daily limit on model use was reached. The verdict comes from fixed rules.',
  model_unavailable: 'The model could not be reached. The verdict comes from fixed rules.',
  model_output_invalid: 'The model did not give a usable answer. The verdict comes from fixed rules.',
  model_output_flagged: 'The model repeated text from the page, so its opinion was set aside. The verdict comes from fixed rules.',
};

export interface PublicReport {
  schema: 1;
  run_id: string;
  url: string;
  verdict: Assessment['verdict'];
  confidence: number;
  status: { state: string; failure: string | null };
  /** how the verdict was reached */
  mode: Assessment['mode'];
  mode_reason: string | null;
  mode_text: string | null;
  /** the page tried to address an automated reader (and nothing more is said about it) */
  injection_attempt: boolean;
  signals: Array<{ id: string; level: string; text: string }>;
  summary: string | null;
  reasons: Array<{ claim: string; evidence: string[] }>;
  steps: Array<{ action: string; status: string }>;
  /** actions waiting for a person; the details are for whoever may decide */
  pending_approval: number;
  artifacts: Array<{ name: string; mime: string }>;
}

export interface OwnerReport extends PublicReport {
  owner: {
    rules: { verdict: string; score: number; confidence: number };
    model: { verdict: string; confidence: number; lowered: boolean } | null;
    versions: { ruleset: string; prompt: string; model: string | null };
    usage: { prompt: number; completion: number; total: number } | null;
    hook_findings: Array<{ rule: string; category: string; strength: string; place: string; layer: number }>;
    steps: Array<{ id: string; action: string; line: string; risk: string; status: string; error: string | null }>;
    refused: Array<{ action: string; reason: string }>;
    pending_approval: Array<{ command_id: string; cmd: string; command_sha256: string }>;
    artifacts: Array<{ name: string; bytes: number; sha256: string; mime: string }>;
    timeline: string[];
    evidence_events: number;
    notes: string[];
  };
}

const s = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '');
const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const list = <T>(v: unknown, max: number): T[] => (Array.isArray(v) ? (v.slice(0, max) as T[]) : []);
const o = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

export function publicReport(r: TaskResult): PublicReport {
  const a = o(r.assessment);
  const reason = typeof a.mode_reason === 'string' && Object.hasOwn(MODE_TEXT, a.mode_reason) ? a.mode_reason : null;
  const mode = a.mode === 'text' || a.mode === 'vision' ? a.mode : 'rules_only';
  return {
    schema: REPORT_SCHEMA,
    run_id: s(r.run_id, 40),
    url: s(r.url, 2048),
    verdict: (['benign', 'suspicious', 'malicious', 'unknown'].includes(a.verdict as string) ? a.verdict : 'unknown') as Assessment['verdict'],
    confidence: Math.min(1, Math.max(0, n(a.confidence))),
    status: { state: s(r.state, 20), failure: r.failure === null ? null : s(r.failure, 40) },
    mode,
    mode_reason: reason,
    mode_text: reason === null ? null : MODE_TEXT[reason]!,
    injection_attempt: o(r.hooks).triggered === true,
    signals: list<Record<string, unknown>>(o(a.rules).signals, 40).map((x) => ({ id: s(x.id, 40), level: s(x.level, 10), text: s(x.text, 300) })),
    summary: typeof a.summary === 'string' ? a.summary.slice(0, 400) : null,
    reasons: list<Record<string, unknown>>(a.reasons, 8).map((x) => ({ claim: s(x.claim, 200), evidence: list<unknown>(x.evidence, 6).map((e) => s(e, 80)) })),
    steps: list<Record<string, unknown>>(r.steps, 20).map((x) => ({ action: s(x.action, 20), status: s(x.status, 20) })),
    pending_approval: list(r.pending_approval, 20).length,
    artifacts: list<Record<string, unknown>>(r.artifacts, 16).map((x) => ({ name: s(x.name, 40), mime: s(x.mime, 60) })),
  };
}

export function ownerReport(r: TaskResult): OwnerReport {
  const a = o(r.assessment);
  const rules = o(a.rules);
  const model = a.model === null ? null : o(a.model);
  const usage = a.usage === null || a.usage === undefined ? null : o(a.usage);
  const v = o(a.versions);
  return {
    ...publicReport(r),
    owner: {
      rules: { verdict: s(rules.verdict, 12), score: n(rules.score), confidence: n(rules.confidence) },
      model: model === null ? null : { verdict: s(model.verdict, 12), confidence: n(model.confidence), lowered: model.lowered === true },
      versions: { ruleset: s(v.ruleset, 64), prompt: s(v.prompt, 64), model: typeof v.model === 'string' ? s(v.model, 100) : null },
      usage: usage === null ? null : { prompt: n(usage.prompt), completion: n(usage.completion), total: n(usage.total) },
      hook_findings: list<Record<string, unknown>>(o(r.hooks).findings, 200).map((f) => ({ rule: s(f.rule, 60), category: s(f.category, 20), strength: s(f.strength, 10), place: s(f.place, 200), layer: n(f.layer) })),
      steps: list<Record<string, unknown>>(r.steps, 20).map((x) => ({ id: s(x.id, 64), action: s(x.action, 20), line: s(x.line, 4096), risk: s(x.risk, 10), status: s(x.status, 20), error: typeof x.error === 'string' ? s(x.error, 40) : null })),
      refused: list<Record<string, unknown>>(r.refused, 20).map((x) => ({ action: s(o(x.proposal).action, 30), reason: s(x.reason, 30) })),
      pending_approval: list<Record<string, unknown>>(r.pending_approval, 20).map((x) => ({ command_id: s(x.command_id, 64), cmd: s(x.cmd, 20), command_sha256: s(x.sha256, 64) })),
      artifacts: list<Record<string, unknown>>(r.artifacts, 16).map((x) => ({ name: s(x.name, 40), bytes: n(x.bytes), sha256: s(x.sha256, 64), mime: s(x.mime, 60) })),
      timeline: list<unknown>(r.timeline, 40).map((x) => s(x, 20)),
      evidence_events: n(r.evidence_events),
      notes: list<unknown>(r.notes, 40).map((x) => s(x, 300)),
    },
  };
}
