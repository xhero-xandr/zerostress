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
import type { Facts } from './facts.ts';
import { ASK_CODES } from './fields.ts';
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
  // facts are read off the page and the network
  'facts.final_host',
  'facts.page_title',
  'facts.chain[].via',
  'facts.chain[].host',
  'facts.forms[].action_host',
  'facts.tls[].host',
  'facts.tls[].issuer',
  'facts.tls[].valid_to',
  'facts.hosts[]',
  'facts.servers[].hosts[]',
  'facts.devices[].final_host',
  'facts.devices[].title',
  'facts.devices[].action_hosts[]',
  // the owner of a network and the registrar are named by third parties
  'facts.servers[].org',
  'facts.domain.name',
  'facts.domain.registrar',
  'facts.links[].text',
  'facts.links[].host',
  'facts.downloads[].filename',
];

/** Our own sentence for each reason the model was not used (or not trusted). */
export const MODE_TEXT: Readonly<Record<string, string>> = {
  hooks_fired: 'The page contains text addressed to an automated reader. The verdict comes from fixed rules only, and no model was asked.',
  page_not_read: 'The page itself was not seen, so there was nothing for a model to judge. No model was asked.',
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
  facts: Facts;
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

function publicFacts(v: unknown): Facts {
  const f = o(v);
  return {
    final_host: s(f.final_host, 100),
    page_title: s(f.page_title, 200),
    chain: list<Record<string, unknown>>(f.chain, 12).map((x) => ({ via: s(x.via, 20), host: s(x.host, 100) })),
    forms: list<Record<string, unknown>>(f.forms, 5).map((x) => ({ action_host: s(x.action_host, 100), cross_origin: x.cross_origin === true, has_password: x.has_password === true, asks: ASK_CODES.filter((c) => list<unknown>(x.asks, 20).includes(c)) })),
    tls: list<Record<string, unknown>>(f.tls, 3).map((x) => ({ host: s(x.host, 100), issuer: s(x.issuer, 80), valid_to: s(x.valid_to, 40) })),
    blocked_requests: Math.min(9999, n(f.blocked_requests)),
    third_party_hosts: Math.min(999, n(f.third_party_hosts)),
    requests_total: Math.min(99999, n(f.requests_total)),
    hosts: list<unknown>(f.hosts, 20).map((x) => s(x, 100)),
    links: list<Record<string, unknown>>(f.links, 30).map((x) => ({ text: s(x.text, 80), host: s(x.host, 100), other_site: x.other_site === true, goes: x.goes === 'nowhere' || x.goes === 'other' ? x.goes : 'same' })),
    servers: list<Record<string, unknown>>(f.servers, 20).map((x) => ({
      ip: /^(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-f:]{2,45})$/i.test(s(x.ip, 45)) ? s(x.ip, 45) : '',
      country: /^[A-Z]{2}$/.test(s(x.country, 2)) ? s(x.country, 2) : null,
      asn: typeof x.asn === 'number' && Number.isInteger(x.asn) && x.asn > 0 && x.asn < 4_294_967_296 ? x.asn : null,
      org: typeof x.org === 'string' && x.org !== '' ? s(x.org, 80) : null,
      hosts: list<unknown>(x.hosts, 3).map((h) => s(h, 100)),
      requests: Math.min(99999, n(x.requests)),
    })).filter((x) => x.ip !== ''),
    servers_total: Math.min(999, n(f.servers_total)),
    domain: (() => {
      const d = o(f.domain);
      if (typeof d.name !== 'string' || d.name === '') return null;
      const created = typeof d.created === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.]{8,12}Z$/.test(d.created) ? d.created : null;
      return { name: s(d.name, 100), created, age_days: created !== null && typeof d.age_days === 'number' && d.age_days >= 0 ? Math.min(Math.floor(d.age_days), 99999) : null, registrar: typeof d.registrar === 'string' && d.registrar !== '' ? s(d.registrar, 80) : null };
    })(),
    devices: list<Record<string, unknown>>(f.devices, 8).filter((x) => x.device === 'mobile' || x.device === 'tablet').slice(0, 2).map((x) => ({
      device: x.device as 'mobile' | 'tablet',
      nav_error: typeof x.nav_error === 'string' && /^[a-zA-Z0-9_]{1,60}$/.test(x.nav_error) ? x.nav_error : null,
      final_host: s(x.final_host, 100),
      title: s(x.title, 200),
      forms: Math.min(99, n(x.forms)),
      has_password: x.has_password === true,
      action_hosts: list<unknown>(x.action_hosts, 5).map((h) => s(h, 100)),
      differs: (['other_site', 'password_only_here'] as const).filter((d) => list<unknown>(x.differs, 4).includes(d)),
      image: x.image === true,
    })),
    hidden_text: f.hidden_text === true,
    popups: Math.min(99, n(f.popups)),
    dialogs: Math.min(99, n(f.dialogs)),
    downloads: list<Record<string, unknown>>(f.downloads, 5).map((x) => ({ filename: s(x.filename, 100), saved: x.saved === true })),
  };
}

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
    facts: publicFacts(r.facts),
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
