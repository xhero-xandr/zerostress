// What the report says, decided from its data: pure functions, tested on their own (ported from web/server/views.ts).
import type { PublicReport } from '../../agent/report-types.ts';
import type { LogEntry } from '../../agent/agent-log.ts';
import { plural, T } from './text.ts';

type Signal = PublicReport['signals'][number];

export const confidenceWord = (c: number): string => (c >= 0.8 ? T.confidence.high : c >= 0.5 ? T.confidence.medium : T.confidence.low);

const LEVEL_ORDER: Readonly<Record<string, number>> = { high: 0, medium: 1, low: 2, info: 3 };

/** Findings worth showing, most serious first; notes ("info") only when there are few findings in all. */
export function findings(r: PublicReport): Signal[] {
  return r.signals
    .filter((s) => s.level !== 'info' || r.signals.length <= 4)
    .sort((a, b) => (LEVEL_ORDER[a.level] ?? 9) - (LEVEL_ORDER[b.level] ?? 9));
}

export const seriousCount = (r: PublicReport): number => r.signals.filter((s) => s.level === 'high' || s.level === 'medium').length;

/** The one sentence under the verdict. A warning by the site's own provider and the kinds of "could not check" each get their own. */
export function verdictLine(r: PublicReport): string {
  const has = (id: string) => r.signals.some((x) => x.id === id);
  if (has('provider_warning')) return T.providerWarning;
  if (r.verdict !== 'unknown') return T.verdictLine[r.verdict];
  if (has('bot_challenge')) return T.challenge;
  if (has('http_error')) return T.refused;
  if (has('empty_page')) return T.emptyPage;
  return T.verdictLine.unknown;
}

/** "4 days ago", "3 months ago", "15 years ago": a rough age for people. */
export function ageWords(days: number): string {
  if (days < 1) return 'today';
  if (days < 60) return `${plural(days, 'day', 'days')} ago`;
  if (days < 730) return `${plural(Math.round(days / 30.4), 'month', 'months')} ago`;
  return `${plural(Math.floor(days / 365.25), 'year', 'years')} ago`;
}

const regionNames = (() => {
  try { return new Intl.DisplayNames('en', { type: 'region' }); } catch { return null; }
})();
export const countryName = (cc: string | null): string => (cc === null ? '—' : `${regionNames?.of(cc) ?? cc} (${cc})`);

export const redirects = (r: PublicReport): number => Math.max(0, r.facts.chain.length - 1);

/** The links note: at least three dead links, and at least half of all. */
export function deadLinks(r: PublicReport): { nowhere: number; total: number } | null {
  const total = r.facts.links.length;
  const nowhere = r.facts.links.filter((l) => l.goes === 'nowhere').length;
  return nowhere >= 3 && nowhere * 2 >= total ? { nowhere, total } : null;
}

export function devicesSummary(r: PublicReport): string | null {
  const ds = r.facts.devices;
  if (!ds.length) return null;
  if (ds.some((d) => d.differs.includes('password_only_here'))) return T.devicesBad;
  if (ds.some((d) => d.differs.length)) return T.devicesDiffer;
  return ds.every((d) => d.nav_error === null) ? T.devicesSame : T.devicesSome;
}

export function serversLine(r: PublicReport): string {
  const f = r.facts;
  const countries = new Set(f.servers.map((x) => x.country).filter((c) => c !== null)).size;
  return T.serversLine(f.servers_total, countries, f.servers.reduce((a, x) => a + x.hosts.length, 0), f.requests_total);
}

export function agentLines(r: PublicReport): string[] {
  const lines: string[] = [T.agent.address, T.agent.sandbox, T.agent.opened(redirects(r))];
  lines.push(r.mode === 'rules_only' ? T.agent.rules : T.agent.model);
  for (const s of r.steps) lines.push(T.agent.decided[`${s.action}:${s.status}`] ?? T.agent.action(s.action, s.status));
  // a finished check has nothing left to decide: an action still listed here waited in vain
  if (r.pending_approval > 0) lines.push(T.agent.notDecided);
  lines.push(r.status.state === 'done' ? T.agent.destroyed : T.agent.stopped);
  return lines;
}

export const fmtTime = (ms: number): string => new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';

/** The task key lives after "#k=", so it never reaches the server in a request line, a log or a Referer. */
export function keyFromHash(hash: string): string {
  const m = /(?:^|[#&])k=([A-Za-z0-9_-]{20,100})/.exec(hash);
  return m ? m[1]! : '';
}

export const isTaskId = (id: string | undefined): id is string => typeof id === 'string' && /^[0-9a-f]{32}$/.test(id);

/** One line of the agent's log in our words. The values have fixed shapes (agent/agent-log.ts); a host is shown as text. */
export function logLine(e: LogEntry): string {
  const d = e.d;
  const str = (k: string): string => (typeof d[k] === 'string' ? (d[k] as string) : '');
  const num = (k: string): number | null => (typeof d[k] === 'number' ? (d[k] as number) : null);
  const L = T.log;
  switch (e.code) {
    case 'submitted': return L.submitted(Math.max(0, (num('position') ?? 1) - 1));
    case 'vm_state': {
      const st = str('state');
      if (st === 'failed' && str('reason')) return L.failedBecause(str('reason'));
      return L.state[st] ?? L.stateOther(st);
    }
    case 'vm_booting': return L.booting(num('vcpu') ?? 0, num('mem_mib') ?? 0, num('slot') ?? 0, str('image'));
    case 'nav_requested': return L.navRequested(str('host'));
    case 'redirect': return L.redirect(str('from'), str('to'), num('status'));
    case 'scheduled': return L.scheduled(str('to'), num('delay_s'));
    case 'page': return d.by_session === true ? L.agentPage(str('host')) : L.page(str('host'));
    case 'forms': return L.forms(num('count') ?? 0, d.password === true);
    case 'device': return L.device(str('device'));
    case 'screenshot': return L.screenshot;
    case 'download': return L.download(d.saved === true);
    case 'visit_done': return L.visitDone(num('requests') ?? 0, num('hosts') ?? 0, num('blocked') ?? 0);
    case 'hooks_fired': return L.hooksFired;
    case 'model_asked': return L.modelAsked(str('model'), str('mode') === 'vision');
    case 'model_answered': return L.modelAnswered(((num('ms') ?? 0) / 1000).toFixed(1), num('tokens') ?? 0, str('verdict'), str('next') && str('next') !== 'none' ? str('next') : null);
    case 'rules_only': return L.rulesOnly[str('reason')] ?? L.rulesOther;
    case 'gate_allowed': return L.gateAllowed(str('action'), str('risk') === 'risky');
    case 'gate_refused': return L.gateRefused(str('action'), str('reason'));
    case 'command': return L.command(str('action'), str('state'));
    case 'approval_wait': return L.approvalWait(str('action'));
    case 'approval_done': return L.approvalDone(str('result'));
    case 'stopped_by_hooks': return L.stoppedByHooks(str('action'));
    case 'verdict': return L.verdict(str('verdict'), str('by'));
    case 'hooks_summary': return L.hooksSummary(num('inspected') ?? 0, num('findings') ?? 0);
  }
}

/** What the stream sent, if it looks like a log entry; the server has already cleaned it, this only guards the shape. */
export function asLogEntry(x: unknown): LogEntry | null {
  if (typeof x !== 'object' || x === null) return null;
  const e = x as Record<string, unknown>;
  if (typeof e.t !== 'number' || typeof e.code !== 'string' || typeof e.d !== 'object' || e.d === null || Array.isArray(e.d)) return null;
  return e as unknown as LogEntry;
}

/** Seconds since the start, for the log's left column. */
export const logTime = (t: number): string => `+${(t / 1000).toFixed(1)} s`;
