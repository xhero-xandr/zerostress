// Signals and the verdict by the rules (spec 008, 3). Deterministic: the same evidence gives the same answer. The
// evidence comes from the collector and has passed the hooks, but the collector itself is not trusted: every field is
// read defensively, and what cannot be read is simply not a reason.

import { BRANDS, EXECUTABLE_EXTENSIONS, LOGIN_WORDS, SHORTENERS, belongsTo } from './lists.ts';
import { domainToUnicode } from 'node:url';
import { isIpHost, mixedScripts, parseUrl, registrable, sld, skeleton } from './domain.ts';

export type Level = 'info' | 'low' | 'medium' | 'high';
export type Verdict = 'benign' | 'suspicious' | 'malicious' | 'unknown';

export interface Signal {
  id: string;
  level: Level;
  /** our wording, never a quotation of the page */
  text: string;
  /** indexes into the list of events that was analysed */
  refs: number[];
}

export interface Analysis {
  signals: Signal[];
  score: number;
  verdict: Verdict;
  /** a rough measure of how much the rules had to go on, 0 to 1: not a probability */
  confidence: number;
}

export const POINTS: Readonly<Record<Level, number>> = { info: 0, low: 5, medium: 20, high: 50 };
export const MALICIOUS_AT = 70;
export const SUSPICIOUS_AT = 25;

export interface Options {
  /** the hooks (009) fired on this task */
  injection?: boolean;
  /** the time against which a certificate is judged, ms since 1970 */
  now?: number;
}

type Ev = Record<string, unknown>;
const isObj = (v: unknown): v is Ev => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const origin = (u: unknown): string => parseUrl(u)?.origin ?? '';
const hostOf = (u: unknown): string => parseUrl(u)?.hostname ?? '';

export function analyze(events: readonly unknown[], opts: Options = {}): Analysis {
  const signals: Signal[] = [];
  const add = (id: string, level: Level, text: string, refs: number[] = []) => signals.push({ id, level, text, refs });
  const idx = events.map((e, i) => [e, i] as const).filter((p): p is readonly [Ev, number] => isObj(p[0]));
  const of = (kind: string) => idx.filter(([e]) => e.kind === kind);

  const navs = of('nav');
  const page = of('page').at(-1);
  const summary = of('summary').at(-1);
  const forms = of('forms').at(-1);
  const navError = summary ? str(summary[0].nav_error) : '';
  const finalUrl = str(summary?.[0].final_url) || str(page?.[0].url) || str([...navs].reverse().find(([e]) => e.via === 'commit')?.[0].to);
  const finalParsed = parseUrl(finalUrl);
  const pageOrigin = finalParsed?.origin ?? '';

  // ---- where the visit went ----
  const origins: Array<{ o: string; ref: number; via: string }> = [];
  for (const [e, i] of navs) {
    const o = origin(e.to);
    if (!o) continue;
    if (origins.at(-1)?.o !== o) origins.push({ o, ref: i, via: str(e.via) });
  }
  const hops = Math.max(0, origins.length - 1);
  if (hops >= 3) add('redirect_chain', 'medium', `The visit passed through ${origins.length} different sites before the final page.`, origins.map((x) => x.ref));
  else if (hops === 2) add('redirect_chain', 'low', 'The visit passed through three different sites before the final page.', origins.map((x) => x.ref));
  const byPage = origins.slice(1).filter((x) => x.via === 'scheduled');
  if (byPage.length) add('redirect_by_page', 'low', 'The page itself sent the visit to another site (a timer or a refresh tag).', byPage.map((x) => x.ref));

  const first = navs.find(([e]) => e.via === 'requested');
  if (first && SHORTENERS.has(registrable(hostOf(first[0].to)))) add('url_shortener', 'low', 'The address given is a link-shortening service, which hides where it leads.', [first[1]]);

  const hosts = new Map<string, number>();
  for (const [e, i] of navs) {
    const u = parseUrl(e.to);
    if (u && !hosts.has(u.host)) hosts.set(u.host, i);
  }
  const odd: number[] = [];
  for (const [host, ref] of hosts) {
    const name = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
    const u = parseUrl(`http://${host}`);
    const port = u?.port ?? '';
    // a name in the encoded form (xn--) is read as the person would see it: a whole name in one alphabet is ordinary
    // (пример.рф), a mixture of alphabets or letters that spell a known organisation are not
    const shown = domainToUnicode(name) || name;
    const spoof = /\P{ASCII}/u.test(shown) &&BRANDS.some((b) => b.slds.includes(sld(skeleton(shown))) && !b.slds.includes(sld(shown)));
    if (mixedScripts(shown) || spoof || isIpHost(name) || (port !== '' && port !== '80' && port !== '443')) odd.push(ref);
  }
  if (odd.length) add('lookalike_host', 'medium', 'A site in the chain has an address of the kind used to imitate another (encoded or mixed-alphabet name, a bare number address, an unusual port).', odd);

  if (finalParsed?.protocol === 'http:') add('no_tls', 'low', 'The final page was loaded without encryption.', page ? [page[1]] : []);

  // ---- the certificate ----
  const now = opts.now ?? Date.now();
  const tlsBad: number[] = [];
  const tlsYoung: number[] = [];
  for (const [e, i] of of('tls')) {
    const issuer = str(e.issuer);
    const subject = str(e.subject);
    if (issuer !== '' && issuer === subject) tlsBad.push(i);
    const from = Date.parse(str(e.valid_from));
    const to = Date.parse(str(e.valid_to));
    if (Number.isFinite(from) && from > now) tlsBad.push(i);
    if (Number.isFinite(to) && to < now) tlsBad.push(i);
    if (Number.isFinite(from) && now - from < 14 * 86_400_000 && from <= now) tlsYoung.push(i);
  }
  if (/^ERR_CERT|^ERR_SSL/.test(navError)) tlsBad.push(summary![1]);
  if (tlsBad.length) add('tls_problem', 'medium', 'The certificate is self-signed, not valid at this time, or the browser refused it.', [...new Set(tlsBad)]);
  if (tlsYoung.length) add('young_certificate', 'info', 'A certificate was issued less than two weeks ago (common for honest sites that renew often).', tlsYoung);

  // ---- the page ----
  const forms0 = list(forms?.[0].forms).filter(isObj);
  const passwordForms = forms0.filter((f) => f.has_password === true);
  const loose = Number(forms?.[0].loose_password_fields) > 0;
  const hasPassword = passwordForms.length > 0 || loose;
  const formRef = forms ? [forms[1]] : [];

  const cross = passwordForms.filter((f) => {
    const target = parseUrl(f.action);
    const actionOrigin = str(f.action_origin) || target?.origin || '';
    return (actionOrigin !== '' && pageOrigin !== '' && actionOrigin !== pageOrigin) || f.origin_differs === true;
  });
  if (cross.length) add('password_form_cross_origin', 'high', 'A form that asks for a password sends it to a different site than the one shown.', formRef);

  const overHttp = hasPassword && (finalParsed?.protocol === 'http:' || passwordForms.some((f) => parseUrl(f.action)?.protocol === 'http:'));
  if (overHttp) add('password_over_http', 'high', 'A password is asked for on, or sent over, an unencrypted connection.', formRef);

  if (page && finalParsed) {
    const title = str(page[0].title).toLowerCase();
    const body = str(page[0].text).slice(0, 3000).toLowerCase();
    const loginish = hasPassword || LOGIN_WORDS.test(title);
    for (const b of BRANDS) {
      const named = b.words.some((w) => new RegExp(`(?<![\\p{L}\\p{N}])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'u').test(title)) ||
        (hasPassword && b.words.some((w) => body.includes(w)));
      if (named && loginish && !belongsTo(b, finalParsed.hostname)) {
        add('brand_domain_mismatch', hasPassword ? 'high' : 'medium', `The page presents itself as ${b.words[0]!} but its address is ${sld(finalParsed.hostname)}.`, [page[1]]);
        break;
      }
    }
    const hidden = page[0].hidden_text;
    if (isObj(hidden) && hidden.present === true) add('hidden_text', 'low', 'The page contains text a person cannot see.', [page[1]]);
  }

  // ---- downloads ----
  const downloads = of('download');
  const auto = downloads.filter(([e]) => e.saved !== true);
  if (auto.length || navError === 'download') add('auto_download', 'medium', 'A file started downloading without any action by the visitor.', auto.map(([, i]) => i));
  const exec: number[] = [];
  for (const [e, i] of downloads) {
    const parts = str(e.filename).toLowerCase().split('.');
    const ext = parts.length > 1 ? parts.at(-1)! : '';
    // a disguise such as "invoice.pdf.exe" ends in the executable extension, so the last one decides
    if (EXECUTABLE_EXTENSIONS.has(ext)) exec.push(i);
  }
  if (exec.length) add('executable_download', 'high', 'A file that can run programs, or that is disguised as a document, was offered for download.', exec);

  // ---- behaviour ----
  const popups = of('popup');
  const dialogs = of('dialog');
  if (popups.length || dialogs.length) add('popups_dialogs', 'low', 'The page opened extra windows or dialogs on its own.', [...popups, ...dialogs].map(([, i]) => i));
  const reqs = of('request');
  const third = new Set(reqs.map(([e]) => origin(e.url)).filter((o) => o !== '' && o !== pageOrigin));
  if (third.size > 10) add('many_third_parties', 'info', `The page contacted ${third.size} other sites.`, []);
  const blocked = reqs.filter(([e]) => e.blocked != null && e.blocked !== false);
  if (blocked.length) add('blocked_requests', 'info', 'Some requests were blocked by the browser or the sandbox.', blocked.map(([, i]) => i));

  if (opts.injection) add('injection_attempt', 'medium', 'The page contains text aimed at an automated reader (instructions to a model).', []);

  const loaded = page !== undefined && navError === '';
  if (!loaded && navError !== 'download') add('unreachable', 'info', 'The page could not be loaded or read.', summary ? [summary[1]] : []);

  const score = signals.reduce((s, x) => s + POINTS[x.level], 0);
  const top = signals.some((s) => s.level === 'high') ? 'high' : signals.some((s) => s.level === 'medium') ? 'medium' : 'low';
  let verdict: Verdict = top === 'high' || score >= MALICIOUS_AT ? 'malicious' : top === 'medium' || score >= SUSPICIOUS_AT ? 'suspicious' : 'benign';
  if (verdict === 'benign' && !loaded && navError !== 'download') verdict = 'unknown';
  return { signals, score, verdict, confidence: confidenceOf(verdict, signals, page) };
}

function confidenceOf(verdict: Verdict, signals: Signal[], page: readonly [Ev, number] | undefined): number {
  const n = (l: Level) => signals.filter((s) => s.level === l).length;
  const round = (x: number) => Math.round(x * 100) / 100;
  switch (verdict) {
    case 'malicious': return round(Math.min(0.95, 0.6 + 0.12 * n('high') + 0.05 * n('medium')));
    case 'suspicious': return round(Math.min(0.85, 0.5 + 0.1 * n('medium') + 0.03 * n('low')));
    case 'benign': return page && page[0].text_truncated !== true ? 0.55 : 0.4;
    default: return 0;
  }
}

const RANK: Record<Verdict, number> = { unknown: 0, benign: 1, suspicious: 2, malicious: 3 };

/**
 * The verdict after the model has spoken. The model may raise the rules' verdict, never lower it (CLAUDE.md, rule 8).
 * "unknown" (the page was not read) is not something a model can turn into "benign" by opinion: only a warning counts.
 */
export function raise(rules: Verdict, model: Verdict | null): Verdict {
  if (model === null) return rules;
  if (rules === 'unknown') return model === 'suspicious' || model === 'malicious' ? model : 'unknown';
  return RANK[model] > RANK[rules] ? model : rules;
}
