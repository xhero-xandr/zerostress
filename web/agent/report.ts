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

import { cleanLog } from './agent-log.ts';
import { raise, type Verdict } from './signals.ts';
import { ASK_CODES } from './fields.ts';
import type { PublicFacts, PublicReport, PublicVerdict } from './report-types.ts';
import type { TaskResult } from './runner.ts';

export type { PublicReport } from './report-types.ts';

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
  // an email's links, as the email gave them, and the hosts they led to
  'email.links[].url',
  'email.links[].final_host',
  // a file's name was chosen by whoever sent it; the addresses and the names inside it are its content
  'file.name',
  'file.links[]',
  'file.entries[]',
  // Cloudflare's scanner read these off the page
  'second_opinion.final_host',
  'second_opinion.title',
  // the log names hosts the page led to
  'log[].d.host',
  'log[].d.from',
  'log[].d.to',
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
  model_output_flagged: 'The model\'s answer looked like text addressed to an automated reader, so it was set aside. The verdict comes from fixed rules.',
};

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

function publicFacts(v: unknown): PublicFacts {
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

const SCAN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Only the model's answer tripped the detectors: every finding is in place 'model'. Anything else counts as the page's. */
function injectionSource(hooks: unknown): PublicReport['injection_source'] {
  const h = o(hooks);
  if (h.triggered !== true) return null;
  const findings = list<Record<string, unknown>>(h.findings, 1000);
  return findings.length > 0 && findings.every((f) => o(f).place === 'model') ? 'answer' : 'page';
}

function secondOpinion(x: unknown): PublicReport['second_opinion'] {
  const so = o(x);
  if (typeof so.uuid !== 'string' || !SCAN_ID.test(so.uuid)) return null;
  const at = typeof so.scanned_at === 'string' && !Number.isNaN(Date.parse(so.scanned_at)) ? new Date(so.scanned_at).toISOString() : '';
  let host = '';
  try { host = typeof so.final_url === 'string' && so.final_url ? new URL(so.final_url).host : ''; } catch { /* none */ }
  return {
    source: so.source === 'submitted' ? 'submitted' : 'found',
    scan_id: so.uuid,
    scanned_at: at,
    final_host: s(host, 253),
    status: typeof so.status === 'number' && Number.isInteger(so.status) && so.status >= 100 && so.status < 600 ? so.status : null,
    title: so.title_withheld === true ? '' : s(so.title, 200),
    title_withheld: so.title_withheld === true,
    malicious: typeof so.malicious === 'boolean' ? so.malicious : null,
    screenshot: so.screenshot === true,
  };
}

const VERDICTS = new Set(['benign', 'suspicious', 'malicious', 'unknown']);
const TOKEN = /^[a-z][a-z0-9_]{0,39}$/;
function reputationOf(x: unknown): PublicReport['reputation'] {
  if (typeof x !== 'object' || x === null) return null;
  const r = o(x);
  const g = Array.isArray(r.google) ? r.google.filter((t): t is string => typeof t === 'string' && /^[A-Z_]{1,40}$/.test(t)).slice(0, 4) : null;
  const sp = typeof r.spamhaus === 'string' && TOKEN.test(r.spamhaus) ? r.spamhaus : null;
  const vt = o(r.virustotal);
  const num = (v: unknown) => Math.max(0, Math.min(1000, Math.floor(n(v))));
  const v = typeof r.virustotal === 'object' && r.virustotal !== null ? { malicious: num(vt.malicious), suspicious: num(vt.suspicious), total: num(vt.total) } : null;
  const u = typeof o(r.urlscan).malicious === 'boolean' ? (o(r.urlscan).malicious as boolean) : null;
  return g === null && sp === null && v === null && u === null ? null : { google: g, spamhaus: sp, virustotal: v, urlscan: u };
}

function emailLinks(x: unknown): PublicReport['email'] {
  const links = list<Record<string, unknown>>(o(x).links, 30);
  if (links.length === 0) return null;
  return {
    links: links.map((l) => {
      let host = '';
      try { host = typeof l.final_url === 'string' ? new URL(l.final_url).host : ''; } catch { /* none */ }
      return {
        url: s(l.url, 2048),
        final_host: s(host, 253),
        verdict: (VERDICTS.has(l.verdict as string) ? l.verdict : 'unknown') as PublicVerdict,
        by: typeof l.by === 'string' && TOKEN.test(l.by) ? l.by : 'rules_only',
        signals: list<unknown>(l.signals, 30).filter((v): v is string => typeof v === 'string' && TOKEN.test(v)),
        password: l.password === true,
        downloads: Math.max(0, Math.min(100, Math.floor(n(l.downloads)))),
        redirects: Math.max(0, Math.min(100, Math.floor(n(l.redirects)))),
        error: typeof l.error === 'string' && TOKEN.test(l.error) ? l.error : null,
        shot: typeof l.shot === 'string' && l.shot !== '',
      };
    }),
  };
}

function fileOf(x: unknown): PublicReport['file'] {
  const f = o(x);
  if (typeof f.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(f.sha256)) return null;
  const vt = o(f.virustotal);
  const num = (v: unknown) => Math.max(0, Math.min(1000, Math.floor(n(v))));
  return {
    name: s(f.name, 200),
    bytes: Math.max(0, Math.min(1e9, Math.floor(n(f.bytes)))),
    sha256: f.sha256,
    type: typeof f.type === 'string' && /^[a-z0-9]{1,12}$/.test(f.type) ? f.type : null,
    read: f.read === true,
    findings: list<unknown>(f.findings, 30).filter((v): v is string => typeof v === 'string' && TOKEN.test(v)),
    links: list<unknown>(f.links, 20).filter((v): v is string => typeof v === 'string' && /^https?:\/\//i.test(v)).map((v) => s(v, 2048)),
    entries: list<unknown>(f.entries, 30).filter((v): v is string => typeof v === 'string').map((v) => s(v, 200)),
    viewed: f.viewed === true,
    virustotal: typeof f.virustotal === 'object' && f.virustotal !== null ? {
      known: vt.known === true, malicious: num(vt.malicious), suspicious: num(vt.suspicious), total: num(vt.total),
      label: typeof vt.label === 'string' && /^[\w.\/-]{1,80}$/.test(vt.label) ? vt.label : null,
      first_seen: typeof vt.first_seen === 'string' && !Number.isNaN(Date.parse(vt.first_seen)) ? new Date(vt.first_seen).toISOString() : null,
    } : null,
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
    // Cloudflare's own "malicious" may raise the verdict, never lower it (docs/containment.md, rule 8)
    verdict: raise((['benign', 'suspicious', 'malicious', 'unknown'].includes(a.verdict as string) ? a.verdict : 'unknown') as Verdict, o(r.second_opinion).malicious === true ? 'malicious' : 'unknown') as PublicVerdict,
    confidence: Math.min(1, Math.max(0, n(a.confidence))),
    status: { state: s(r.state, 20), failure: r.failure === null ? null : s(r.failure, 40) },
    mode,
    mode_reason: reason,
    log: cleanLog(r.log),
    second_opinion: secondOpinion(r.second_opinion),
    email: emailLinks(r.email),
    file: fileOf(r.file),
    reputation: reputationOf(r.reputation),
    second_opinion_state: r.file || secondOpinion(r.second_opinion) !== null || a.verdict !== 'unknown' || r.state !== 'done' ? null : r.second_opinion_error ? 'failed' : 'asking',
    mode_text: reason === null ? null : MODE_TEXT[reason]!,
    injection_attempt: o(r.hooks).triggered === true,
    injection_source: injectionSource(r.hooks),
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
