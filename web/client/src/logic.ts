// What the report says, decided from its data: pure functions, tested on their own (ported from web/server/views.ts).
import type { PublicReport } from '../../agent/report-types.ts';
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
