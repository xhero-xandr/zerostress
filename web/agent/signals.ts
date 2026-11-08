// Signals and the verdict by the rules (spec 008, 3). Deterministic: the same evidence gives the same answer. The
// evidence comes from the collector and has passed the hooks, but the collector itself is not trusted: every field is
// read defensively, and what cannot be read is simply not a reason.

import { deviceViews } from './devices.ts';
import { pageViews, sessionStart } from './evidence.ts';
import { hidesText } from './hiding.ts';
import { BRANDS, EXECUTABLE_EXTENSIONS, LOGIN_WORDS, SHORTENERS, belongsTo } from './lists.ts';
import { domainToUnicode } from 'node:url';
import type { Reputation } from './reputation.ts';
import { isIpHost, mixedScripts, onSharedHost, parseUrl, registrable, sld, skeleton } from './domain.ts';

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
  /** days since the final site's domain was registered, if the registry could be asked */
  domainAgeDays?: number | null;
  /** what Google, Spamhaus and VirusTotal already know about the address and its domain (reputation.ts) */
  reputation?: Reputation | null;
}

type Ev = Record<string, unknown>;
const isObj = (v: unknown): v is Ev => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const origin = (u: unknown): string => parseUrl(u)?.origin ?? '';
const pathOf = (u: string): string => parseUrl(u)?.pathname ?? '';
const hostOf = (u: unknown): string => parseUrl(u)?.hostname ?? '';

/** Titles of the pages that stand between a visitor and the site: Cloudflare's wait page and block page, other bot walls. */
/** Addresses that belong to bot walls and captchas (Cloudflare, DataDome, hCaptcha, reCAPTCHA, PerimeterX, Imperva). */
const CHALLENGE_INFRA = /\/cdn-cgi\/challenge-platform\/|[?&]__cf_chl_|challenges\.cloudflare\.com|captcha-delivery\.com|hcaptcha\.com\/|recaptcha\/|px-cdn\.net|perimeterx|_Incapsula_Resource|geetest/i;
const CHALLENGE_TITLE = /^\s*(just a moment|attention required!? ?\|? ?cloudflare|checking your browser|verifying you are human|verify you are human|ddos protection by|one more step|please wait while|security check|security verification|are you a robot|pardon our interruption|access denied)\b/i;

/** The warning page Cloudflare puts in front of a site it has itself flagged: its own verdict, not the site's content. */
/** The same walls in other languages: Cloudflare's own "Just a moment" as it is translated, and "you are not a robot". */
const CHALLENGE_TITLE_INTL = /^\s*(один момент|einen moment|nur einen moment|un instant|un momento|um momento|solo un momento|chwileczkę|bir dakika|しばらくお待ちください|请稍候|잠시만 기다리십시오)|не робот|что вы человек|kein roboter|pas un robot|no eres un robot|não é um robô|non sei un robot|nie jesteś robotem|robot değil/i;

// a wall that moved the visitor to a page of its own: /bgn_verification.html, /captcha/, /challenge (temu.com). Only the
// path counts, and only on a page with nothing else on it: a sign-in or "verify your email" page has a form and text.
const CHALLENGE_PATH = /\/[\w-]*(?:verification|captcha|challenge)[\w-]*(?:\.html?)?(?:\/|$)/i;
// characters that take room in the text but show nothing: a wall that pads its page with them is still an empty page
const INVISIBLE = /[\u00ad\u200b-\u200f\u2060-\u2064\ufeff]/g;
const PROVIDER_WARNING_TITLE = /^\s*suspected (phishing|malware)\s*\|\s*cloudflare\b/i;

export function analyze(events: readonly unknown[], opts: Options = {}): Analysis {
  const signals: Signal[] = [];
  const add = (id: string, level: Level, text: string, refs: number[] = []) => signals.push({ id, level, text, refs });
  const idx = events.map((e, i) => [e, i] as const).filter((p): p is readonly [Ev, number] => isObj(p[0]));
  const of = (kind: string) => idx.filter(([e]) => e.kind === kind);

  // the link's own visit decides the chain, the walls and the landing page; pages the agent opened afterwards in a deep
  // check are judged too, each against its own address (evidence.ts)
  const visitEnd = sessionStart(events);
  const navs = of('nav').filter(([, i]) => i < visitEnd);
  const pages = pageViews(events);
  const land = pages.filter((v) => !v.bySession).at(-1);
  const page = land ? ([land.page, land.at] as const) : undefined;
  const summary = of('summary').at(-1);
  const forms = land?.forms !== undefined ? ([land.forms, land.formsAt!] as const) : undefined;
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
  // a brand's name in a name of one's own on a hosting service (instagram-clone.vercel.app, paypal-verify.netlify.app):
  // the brand does not live there, and the name is chosen to look like it. One name alone on a code host
  // (microsoft.github.io) is how an organisation's own project pages are named, so it does not count.
  const onHost: number[] = [];
  let hostBrand = '';
  for (const [host, ref] of hosts) {
    const name = host.replace(/:\d+$/, '').toLowerCase();
    if (!onSharedHost(name)) continue;
    const parts = sld(name).split(/[-_]+/).filter(Boolean);
    const codeHost = /\.(?:github|gitlab)\.io$/.test(name);
    const b = BRANDS.find((x) => x.slds.some((s) => s.length >= 3 && parts.includes(s)) || x.words.some((w) => !w.includes(' ') && w.length >= 3 && parts.includes(w)));
    if (b && (parts.length > 1 || !codeHost)) { onHost.push(ref); hostBrand ||= b.words[0]!; }
  }
  if (onHost.length) add('brand_on_shared_host', 'medium', `The address puts the name ${hostBrand} on a free hosting service, where anyone can pick any name; ${hostBrand} does not run its site there.`, onHost);
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

  // ---- the same address as a phone and as a tablet ----
  const views = deviceViews(events);
  const names = (d: string) => views.filter((v) => v.differs.includes(d as never)).map((v) => (v.device === 'mobile' ? 'a phone' : 'a tablet'));
  // A sign-in form only a phone or a tablet sees is cloaking when something else about it is off: the form sends the
  // password to another site, the phone lands on another site, or the domain is young. On an old domain, with the form
  // on the site itself, it is what many big sites do (TikTok, Instagram ask phones to sign in): told, not counted.
  const pw = views.filter((v) => v.differs.includes('password_only_here'));
  const age = opts.domainAgeDays;
  const known = typeof age === 'number' && Number.isFinite(age) && age >= 0;
  const foreign = (v: (typeof views)[number]) => v.differs.includes('other_site') || v.action_hosts.some((h) => registrable(h.replace(/:\d+$/, '')) !== registrable(v.final_host));
  const who = (vs: typeof views) => vs.map((v) => (v.device === 'mobile' ? 'a phone' : 'a tablet')).join(' and ');
  const young = known && (age as number) < 90;
  const off = pw.filter((v) => foreign(v) || young);
  if (off.length) add('device_cloaking', 'high', `The page asks for a password only when opened as ${who(off)}; as a computer it shows no such form. Pages that hide from computers usually have a reason.`, off.map((v) => v.at));
  else if (pw.length && !known) add('device_cloaking', 'medium', `The page asks for a password only when opened as ${who(pw)}; as a computer it shows no such form. The age of the domain is not known.`, pw.map((v) => v.at));
  else if (pw.length) add('mobile_sign_in', 'info', `Opened as ${who(pw)}, the page shows a sign-in form that a computer does not see. Many large sites do this; here the form stays on the site itself, and the domain is not new.`, pw.map((v) => v.at));
  // vk.com on a computer and vk.ru on a phone: the same name under another top-level domain, one of them the domain that
  // was asked for, is one owner's sites, not a phone sent elsewhere
  const askedSite = registrable(hostOf(first?.[0].to ?? ''));
  const sameOwner = (v: (typeof views)[number]) => {
    const desk = parseUrl(summary?.[0].final_url)?.hostname ?? '';
    return sld(v.final_host) !== '' && sld(v.final_host) === sld(desk) && [registrable(v.final_host), registrable(desk)].includes(askedSite);
  };
  const elsewhereViews = views.filter((v) => v.differs.includes('other_site') && !sameOwner(v));
  const elsewhere = elsewhereViews.map((v) => (v.device === 'mobile' ? 'a phone' : 'a tablet'));
  if (elsewhere.length) add('device_redirect', 'medium', `Opened as ${elsewhere.join(' and ')}, the link ends up on a different site than it does on a computer.`, elsewhereViews.map((v) => v.at));

  // ---- what others already know: each listing can only add to what we saw ----
  const rep = opts.reputation;
  if (rep?.google?.length) add('listed_by_google', 'high', `Google Safe Browsing lists this address as ${rep.google.map((t) => t.toLowerCase().replace(/_/g, ' ')).join(' and ')}.`);
  if (rep?.spamhaus && rep.spamhaus !== 'clean') {
    const why = rep.spamhaus.replace(/^abused_/, '');
    const abused = rep.spamhaus.startsWith('abused_');
    add('listed_by_spamhaus', why === 'spam' || why === 'redirector' ? 'medium' : 'high', `Spamhaus lists this domain for ${why === 'phish' ? 'phishing' : why}${abused ? ' (a legitimate site that has been abused)' : ''}.`);
  }
  const vt = rep?.virustotal;
  if (vt && vt.malicious + vt.suspicious > 0) {
    const n = vt.malicious + vt.suspicious;
    add('flagged_by_virustotal', vt.malicious >= 3 ? 'high' : n >= 2 ? 'medium' : 'low', `${n} of ${vt.total} antivirus engines on VirusTotal flag this domain.`);
  }

  if (rep?.urlscan?.malicious === true) add('flagged_by_urlscan', 'medium', 'urlscan.io marked its latest scan of this domain as malicious.');

  // ---- the domain ----
  if (typeof age === 'number' && Number.isFinite(age) && age >= 0 && age < 90) {
    const n = Math.floor(age);
    const when = n === 0 ? 'today' : n === 1 ? '1 day ago' : `${n} days ago`;
    add('young_domain', age < 30 ? 'medium' : 'low', `The site's domain was registered ${when}. Honest sites can be new too, but most scam sites are.`);
  }

  // ---- the pages: each one against its own address ----
  const once = new Set<string>();
  const addOnce = (id: string, level: Level, text: string, refs: number[]) => {
    if (once.has(id)) return;
    once.add(id);
    add(id, level, text, refs);
  };
  for (const v of pages) {
    const here = parseUrl(v.url) ?? (v === land ? finalParsed : null);
    const vForms = list(v.forms?.forms).filter(isObj);
    const passwordForms = vForms.filter((f) => f.has_password === true);
    const hasPassword = passwordForms.length > 0 || Number(v.forms?.loose_password_fields) > 0;
    const formRef = v.formsAt !== undefined ? [v.formsAt] : [];

    // another SITE, not another origin: a bank's sign-in form posting to connect.secure.bank.example from
    // www.bank.example sends the password to the bank itself
    const cross = passwordForms.filter((f) => {
      const stated = parseUrl(str(f.action_origin));
      // the collector read where the form really goes: compare sites
      if (stated && here) return registrable(stated.hostname) !== registrable(here.hostname);
      const target = parseUrl(str(f.action));
      if (target && here) return registrable(target.hostname) !== registrable(here.hostname);
      // no address to compare: the collector's own flag decides
      return f.origin_differs === true;
    });
    if (cross.length) addOnce('password_form_cross_origin', 'high', 'A form that asks for a password sends it to a different site than the one shown.', formRef);

    const overHttp = hasPassword && (here?.protocol === 'http:' || passwordForms.some((f) => parseUrl(f.action)?.protocol === 'http:'));
    if (overHttp) addOnce('password_over_http', 'high', 'A password is asked for on, or sent over, an unencrypted connection.', formRef);

    if (here) {
      const title = str(v.page.title).toLowerCase();
      const body = str(v.page.text).slice(0, 3000).toLowerCase();
      const loginish = hasPassword || LOGIN_WORDS.test(title);
      // a brand's own site names other brands (Apple Pay, PayPal): only a site that is no brand's can pretend to be one
      const ownBrand = BRANDS.some((b) => belongsTo(b, here.hostname));
      const word = (w: string, text: string) => new RegExp(`(?<![\\p{L}\\p{N}])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'u').test(text);
      for (const b of ownBrand ? [] : BRANDS) {
        // whole words in the text too: "purchase" does not name Chase
        const named = b.words.some((w) => word(w, title)) || (hasPassword && b.words.some((w) => word(w, body)));
        if (named && loginish && !belongsTo(b, here.hostname)) {
          addOnce('brand_domain_mismatch', hasPassword ? 'high' : 'medium', `The page presents itself as ${b.words[0]!} but its address is ${sld(here.hostname)}.`, [v.at]);
          break;
        }
      }
    }
    if (hidesText(v.page.hidden_text)) addOnce('hidden_text', 'low', 'The page hides text from visitors (invisible, zero-size or the colour of the background).', [v.at]);
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
  const reqs = of('request').filter(([, i]) => i < visitEnd);
  const third = new Set(reqs.map(([e]) => origin(e.url)).filter((o) => o !== '' && o !== pageOrigin));
  if (third.size > 10) add('many_third_parties', 'info', `The page contacted ${third.size} other sites.`, []);
  const blocked = reqs.filter(([e]) => e.blocked != null && e.blocked !== false);
  if (blocked.length) add('blocked_requests', 'info', 'Some requests were blocked by the browser or the sandbox.', blocked.map(([, i]) => i));

  if (opts.injection) add('injection_attempt', 'medium', 'The page contains text aimed at an automated reader (instructions to a model).', []);

  // Nothing was read of the site itself when the visit ended on a wall: a bot-check page, an error the site answered
  // with instead of its page, or a page with nothing on it. A verdict of "no threat found" on such a visit would be a lie.
  // A real page that merely carries a captcha widget has content, so the widget alone does not count.
  const title = str(page?.[0].title);
  const textLen = str(page?.[0].text).replace(INVISIBLE, '').trim().length;
  const linkCount = (land?.links?.links as unknown[] | undefined)?.length ?? 0;
  const formCount = (forms?.[0].forms as unknown[] | undefined)?.length ?? 0;
  const thin = textLen < 300 && linkCount < 3;
  // the status of the page that was asked for (the first document), not of a captcha frame loaded after it
  const asked = Number(reqs.filter(([e]) => e.resource_type === 'document').map(([e]) => e.status)[0]);
  const refusedStatus = [401, 403, 404, 410, 429, 451].includes(asked) || asked >= 500;
  const challengeInfra = reqs.some(([e]) => CHALLENGE_INFRA.test(str(e.url)));
  const warned = PROVIDER_WARNING_TITLE.test(title);
  if (warned) add('provider_warning', 'medium', 'Cloudflare shows a warning that this site is suspected of phishing or malware, and does not let a visitor reach the page. The real page was not seen.', page ? [page[1]] : []);
  const challenged = !warned && (CHALLENGE_TITLE.test(title) || CHALLENGE_TITLE_INTL.test(title) || (challengeInfra && (refusedStatus || thin)) || (thin && formCount === 0 && CHALLENGE_PATH.test(pathOf(str(page?.[0].url)))));
  if (challenged) add('bot_challenge', 'info', 'The site showed a bot-check page instead of its own content, so the real page was not seen.', page ? [page[1]] : []);
  const httpError = !challenged && !warned && refusedStatus && page !== undefined;
  if (httpError) add('http_error', 'info', `The site answered with an error (HTTP ${asked}) instead of its page, so the real page was not seen.`, page ? [page[1]] : []);
  const empty = !challenged && !warned && !httpError && page !== undefined && navError === '' && title === '' && textLen < 10 && linkCount === 0 && formCount === 0;
  if (empty) add('empty_page', 'info', 'The page loaded but showed nothing, so there was nothing to judge.', page ? [page[1]] : []);

  const loaded = page !== undefined && navError === '' && !warned && !challenged && !httpError && !empty;
  if (!loaded && !warned && !challenged && !httpError && !empty && navError !== 'download') add('unreachable', 'info', 'The page could not be loaded or read.', summary ? [summary[1]] : []);

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
 * The verdict after the model has spoken. The model may raise the rules' verdict, never lower it (docs/containment.md, rule 8).
 * "unknown" (the page was not read) is not something a model can turn into "benign" by opinion: only a warning counts.
 */
export function raise(rules: Verdict, model: Verdict | null): Verdict {
  if (model === null) return rules;
  if (rules === 'unknown') return model === 'suspicious' || model === 'malicious' ? model : 'unknown';
  return RANK[model] > RANK[rules] ? model : rules;
}
