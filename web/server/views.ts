// The pages (spec 007, 3.5). Server-rendered with hono/html, whose tagged template escapes every interpolated string. The
// rule here: text that came from a page, the network or the model is only ever a text node or an attribute value of ours,
// never an address, a style or a script. An id that goes into an address is checked as hex first.

import { html } from 'hono/html';
import type { HtmlEscapedString } from 'hono/utils/html';
import type { PublicReport } from '../agent/report.ts';
import { GATE_TEXT, type GateReason } from './gate.ts';
import type { Stage } from './store.ts';

type Html = HtmlEscapedString | Promise<HtmlEscapedString>;

/** Every sentence the person reads that is ours. One place, so a second language is one more table. */
export const T = {
  brand: 'ZeroStress',
  tagline: 'Is this link safe to open?',
  heroTitle: 'See what a link does before you open it',
  heroText: 'Paste a link. We open it for you in a disposable, isolated sandbox, record what the page tries to do, and give you a verdict with the evidence. Your device never touches the page.',
  inputLabel: 'Link to check',
  inputPlaceholder: 'https://example.com/…',
  check: 'Check link',
  checking: 'Starting…',
  deepLabel: 'Let the agent act on the page',
  deepHint: 'The agent can scroll and look around. Anything risky, such as sending a form, waits for your approval.',
  tryTitle: 'Or try a safe example',
  howTitle: 'How it works',
  how: [
    ['Paste a link', 'Any web address you are not sure about.'],
    ['We open it in a sandbox', 'A fresh virtual machine, cut off from our systems, loads the page and records what happens.'],
    ['You get the evidence', 'A verdict, the reasons, a screenshot and the path the link took. The sandbox is then destroyed.'],
  ] as const,
  assureTitle: 'Contained by design',
  assure: [
    ['One-time machine', 'Every check gets its own virtual machine.'],
    ['No reach into our systems', 'The sandbox cannot see our servers, our network or any keys.'],
    ['Destroyed afterwards', 'The machine and its disk are deleted when the check ends.'],
    ['You decide', 'The agent never takes a risky action without your approval.'],
  ] as const,
  another: 'Check another link',
  progressTitle: 'Checking the link',
  checkedTitle: 'Checked link',
  steps: ['Preparing the sandbox', 'Opening the page', 'Analysing the evidence', 'Done'] as const,
  queued: (n: number | null) => (n && n > 1 ? `Waiting in line (${n - 1} ahead of you)` : 'Waiting for a free sandbox'),
  stageNow: { queued: 'Waiting for a free sandbox', starting: 'Starting a disposable sandbox', opening: 'Opening the page and recording what it does', analysing: 'Weighing the evidence', done: 'Done', failed: 'Stopped' } as Readonly<Record<Stage, string>>,
  noScript: 'This page updates by itself. Turn on JavaScript, or reload it in a few seconds.',
  verdict: { benign: 'No threat found', suspicious: 'Suspicious', malicious: 'Dangerous', unknown: 'Could not check' },
  verdictLine: {
    benign: 'We saw nothing that points to a threat. That is not a guarantee, so stay careful with anything that asks for a password or a payment.',
    suspicious: 'Some things about this link are worth a second look. Do not enter passwords or open files from it.',
    malicious: 'This link shows clear signs of an attack. Do not open it on your own device.',
    unknown: 'The page could not be loaded or read, so there is no verdict.',
  },
  challenge: 'The site asked for a human check (a bot-check page), which an automated browser cannot pass. We saw the check page, not the site itself, so there is no verdict. This says nothing about whether the site is safe.',
  refused: 'The site answered our automated visit with an error instead of its page. We saw the refusal, not the site, so there is no verdict. This says nothing about whether the site is safe.',
  providerWarning: 'Cloudflare itself shows a warning that this site is suspected of phishing or malware and stops visitors from reaching the page. We saw the warning, not the site, and treat it as a serious sign: do not open this link.',
  emptyPage: 'The page loaded but showed nothing, so there was nothing to judge and there is no verdict.',
  confidence: { high: 'Our confidence: high', medium: 'Our confidence: medium', low: 'Our confidence: low' },
  findingsTitle: 'What we found',
  noFindings: 'Nothing unusual was recorded.',
  level: { high: 'Serious', medium: 'Moderate', low: 'Minor', info: 'Note' } as Readonly<Record<string, string>>,
  explainTitle: 'Explanation',
  pathTitle: 'Where the link goes',
  pathVia: { requested: 'Start', http: 'Server redirect', meta: 'Page redirect', script: 'Script redirect', commit: 'Final page' } as Readonly<Record<string, string>>,
  pathViaOther: 'Redirect',
  pageTitle: 'About the page',
  download: 'Download',
  tabsLabel: 'Report sections',
  tabs: { summary: 'Summary', security: 'Security', network: 'Network', links: 'Links', behavior: 'Behavior' } as Readonly<Record<string, string>>,
  meta: { id: 'Report ID', submitted: 'Submitted URL', finished: 'Checked', link: 'Link only' },
  none: 'None',
  yes: 'Yes',
  no: 'No',
  statsTitle: 'Statistics',
  stats: { requests: 'Requests', sites: 'Other sites', blocked: 'Blocked', forms: 'Forms', links: 'Links', redirects: 'Redirects' },
  sumLine: (sites: number, requests: number) => `This page called ${plural(sites, 'other site', 'other sites')} and made ${plural(requests, 'request', 'requests')} while loading.`,
  chat: {
    open: 'Explain',
    title: 'Ask about this result',
    close: 'Close',
    placeholder: 'Ask a question about this result',
    send: 'Send',
    explainAsk: 'Explain this result',
    thinking: 'Reading the report…',
    failed: 'The answer could not be fetched. Please try again.',
    note: 'Answers come from this report only. The assistant cannot open anything or change the verdict. It can be wrong: check the facts in the tabs.',
    fromRules: 'Written by fixed rules',
    fromModel: 'Written by an AI assistant from this report',
  },
  shotSwitch: 'Screenshot for a device',
  device: { desktop: 'Desktop', tablet: 'Tablet', mobile: 'Mobile' } as Record<string, string>,
  devicesTitle: 'On a phone and a tablet',
  devicesBad: 'This page shows a password form to a phone or a tablet that a computer does not see. That is a way of hiding from checkers like this one.',
  devicesDiffer: 'The page behaves differently on a phone or a tablet than on a computer. See below.',
  devicesSame: 'The link was also opened as a phone and as a tablet, and the page was the same site with no new sign-in form.',
  devicesSome: 'The link was also opened as a phone and as a tablet, but not every attempt loaded.',
  devicesHead: { device: 'Opened as', site: 'Ended up on', password: 'Password form', note: 'Compared with a computer' },
  devicesAlike: 'Nothing different.',
  devicesNotOpened: 'The page did not open.',
  differs: { other_site: 'It ends up on a different site.', password_only_here: 'It asks for a password only here.' } as Record<string, string>,
  serversTitle: 'Servers it talked to',
  serversLine: (ips: number, countries: number, sites: number, requests: number) => `The page connected to ${plural(ips, 'address', 'addresses')} in ${plural(countries, 'country', 'countries')}, serving ${plural(sites, 'site', 'sites')}, to make ${plural(requests, 'request', 'requests')}.`,
  serversNone: 'No server addresses were recorded for this page.',
  serversNote: 'Where an address is registered is a database guess. Big networks that answer from many places (content delivery networks) show one place only.',
  serversMore: (n: number) => `…and ${plural(n, 'more address', 'more addresses')} not listed.`,
  serversHead: { ip: 'Address', place: 'Country', net: 'Network', sites: 'Sites', req: 'Requests' },
  attribution: 'IP Geolocation by DB-IP',
  domainTitle: 'The domain',
  domainRegistered: 'Registered',
  domainRegistrar: 'Registrar',
  domainUnknown: 'The registry could not be asked, so the age of the domain is not known.',
  certsTitle: 'Certificates',
  noCerts: 'No certificate was recorded for this page.',
  formPassword: 'Asks for a password',
  formPlain: 'Form',
  formAsks: 'Asks for',
  ask: { password: 'a password', card_number: 'a card number', card_security: 'the card security code', card_expiry: 'the card expiry date', one_time_code: 'a one-time code', id_number: 'an ID or tax number', birth_date: 'a date of birth', email: 'an email address', phone: 'a phone number', address: 'a postal address', name: 'a name' } as Record<string, string>,
  otherSite: 'Sends to another site',
  sitesTitle: 'Other sites it called',
  noOtherSites: 'It did not call any other site.',
  andMore: (n: number) => `…and ${n} more.`,
  sandboxTitle: 'What the sandbox stopped',
  sandboxNote: 'Requests that the browser or the sandbox refused, for example to internal addresses.',
  linksTitle: 'Links on the page',
  linkText: 'Link text',
  linkGoes: 'Goes to',
  goesNowhere: 'Nowhere (stays on the page)',
  goesSame: 'Another page of this site',
  linksNowhere: (n: number, total: number) => `${n} of ${total} links lead nowhere. Real sites link to real pages; pages copied from another site often leave their links empty.`,
  linksNote: 'Only the first links of the page are listed. Nothing was clicked.',
  noLinks: 'No links were found on the page.',
  behaviorTitle: 'What the page did on its own',
  notSaved: 'not kept',
  rows: { title: 'Page title', host: 'Final site', domain: 'Domain', verdict: 'Verdict', findings: 'Findings', redirects: 'Redirects', forms: 'Forms', cert: 'Certificates', site: 'Site', issuer: 'Issued by', validUntil: 'Valid until', blocked: 'Blocked requests', third: 'Other sites it called', hidden: 'Hidden text', popups: 'Extra windows', dialogs: 'Dialog boxes', downloads: 'Download offers' },
  formNone: 'None',
  formsText: (n: number, pw: number, cross: number) => `${n} form${n === 1 ? '' : 's'}${pw ? `, ${pw} asking for a password` : ''}${cross ? `, ${cross} sending data to another site` : ''}`,
  screenshotTitle: 'What the page looked like',
  screenshotNote: 'Taken inside the sandbox.',
  screenshotAlt: 'Screenshot of the page, taken in the sandbox',
  injection: 'This page contains text addressed to AI assistants. We ignored it and judged the page by fixed rules only.',
  agentTitle: 'What the agent did',
  agent: {
    address: 'Checked the address',
    sandbox: 'Started a disposable sandbox',
    opened: (hops: number) => (hops > 0 ? `Opened the page and followed ${hops} redirect${hops === 1 ? '' : 's'}` : 'Opened the page and recorded what it does'),
    rules: 'Analysed the evidence with fixed rules',
    model: 'Analysed the evidence with fixed rules and an AI model',
    action: (a: string, st: string) => `Agent action: ${a} (${st})`,
    waiting: 'Waiting for your decision',
    destroyed: 'Destroyed the sandbox and its disk',
    stopped: 'The check stopped early',
  },
  approvalTitle: 'The agent needs your decision',
  approvalText: 'This action changes something on the page, so it only happens if you allow it.',
  allow: 'Allow',
  deny: 'Don’t allow',
  approvalOnlyOwner: 'The person who started this check can decide here.',
  approved: 'Allowed. The agent is carrying it out in the sandbox.',
  denied: 'Not allowed. The sandbox will close without taking the action.',
  actions: { submit_form: 'Submit a form on the page', download: 'Download a file from the page', click: 'Click on the page', fill: 'Type into a field', open_link: 'Open a link on the page' } as Readonly<Record<string, string>>,
  actionOther: 'Take an action on the page',
  copyLink: 'Copy link',
  copied: 'Copied',
  shareNote: 'Anyone with this link can read the report. Only you can make decisions.',
  failedTitle: 'The check did not finish',
  failedText: 'Something stopped the check before it had an answer. Nothing was opened on your device. You can try again.',
  notFoundTitle: 'Report not found',
  notFoundText: 'This report does not exist, or it has expired. Reports are kept for 24 hours.',
  errors: {
    ...GATE_TEXT,
    rate_hour: 'You have reached the hourly limit for checks. Please try again a little later.',
    rate_day: 'You have reached the daily limit for checks. Please come back tomorrow.',
    too_many_active: 'You already have a check running. Wait for it to finish first.',
    daily_cap: 'The service has reached its daily limit for free checks. It resets at midnight UTC.',
    busy: 'All sandboxes are busy right now. Please try again in a minute.',
    supervisor_unavailable: 'The checking service is not available right now. Please try again shortly.',
    bad_request: 'That request could not be read. Reload the page and try again.',
    bad_question: 'Please ask a question of up to 300 characters.',
    chat_rate: 'You have asked a lot of questions in the last hour. Please try again a little later.',
    chat_busy: 'Your previous question is still being answered.',
    chat_cap: 'This report has had as many questions as it can take. The explanation above is still available.',
    forbidden: 'This is not allowed from here.',
    server: 'Something went wrong on our side. Please try again.',
  } as Readonly<Record<string, string>>,
  footer: 'Links are opened only inside disposable sandboxes. Reports are kept for 24 hours.',
};

export interface Demo { label: string; url: string }

function layout(title: string, body: Html, opts: { taskId?: string; live?: boolean; refresh?: boolean } = {}): Html {
  const taskAttr = opts.taskId && /^[0-9a-f]{32}$/.test(opts.taskId) ? opts.taskId : '';
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="referrer" content="no-referrer">
<title>${title}</title>
<link rel="stylesheet" href="/static/style.css">
${opts.refresh ? html`<noscript><meta http-equiv="refresh" content="4"></noscript>` : ''}
<script src="/static/app.js" defer></script>
</head>
<body data-task="${taskAttr}" data-live="${opts.live ? '1' : ''}">
<header class="top"><div class="wrap top-in">
<a class="brand" href="/"><span class="mark" aria-hidden="true"></span>${T.brand}</a>
<span class="tag">${T.tagline}</span>
</div></header>
<main class="wrap">${body}</main>
<footer class="wrap foot">${T.footer}</footer>
</body>
</html>`;
}

export function homePage(demos: readonly Demo[]): Html {
  const body = html`
<section class="hero">
<h1>${T.heroTitle}</h1>
<p class="lead">${T.heroText}</p>
<form id="check-form" class="check" autocomplete="off" novalidate>
<label class="sr" for="url">${T.inputLabel}</label>
<div class="check-row">
<input id="url" name="url" type="text" inputmode="url" spellcheck="false" autocapitalize="off" placeholder="${T.inputPlaceholder}" maxlength="2048" required>
<button id="go" type="submit" class="btn primary" data-busy="${T.checking}">${T.check}</button>
</div>
<label class="deep"><input id="deep" type="checkbox" name="deep"><span><b>${T.deepLabel}</b><br><small>${T.deepHint}</small></span></label>
<p id="form-error" class="error" role="alert" hidden></p>
</form>
${demos.length ? html`<div class="demos"><span class="muted">${T.tryTitle}</span>${demos.map((d) => html`<button type="button" class="chip" data-fill="${d.url}">${d.label}</button>`)}</div>` : ''}
</section>
<section class="cols3">
${T.how.map(([h, p], i) => html`<div class="card step"><span class="num">${i + 1}</span><h3>${h}</h3><p>${p}</p></div>`)}
</section>
<section class="assure card">
<h2>${T.assureTitle}</h2>
<ul class="ticks">${T.assure.map(([h, p]) => html`<li><b>${h}</b><span>${p}</span></li>`)}</ul>
</section>`;
  return layout(`${T.brand}: ${T.heroTitle}`, body);
}

function trackerIndex(stage: Stage): number {
  return stage === 'queued' || stage === 'starting' ? 0 : stage === 'opening' ? 1 : stage === 'analysing' ? 2 : 3;
}

export function progressPage(p: { id: string; host: string; stage: Stage; position: number | null }): Html {
  const at = trackerIndex(p.stage);
  const body = html`
<section class="card progress">
<p class="muted">${T.progressTitle}</p>
<h1 class="host">${p.host}</h1>
<ol class="tracker" aria-label="${T.progressTitle}">
${T.steps.map((s, i) => html`<li class="${i < at ? 'done' : i === at ? 'now' : ''}" data-step="${i}"><span class="dot"></span>${s}</li>`)}
</ol>
<p id="stage-label" class="stage" aria-live="polite">${p.stage === 'queued' ? T.queued(p.position) : T.stageNow[p.stage]}</p>
<noscript><p class="muted">${T.noScript}</p></noscript>
</section>`;
  return layout(`${p.host} — ${T.brand}`, body, { taskId: p.id, live: true, refresh: true });
}

const confidenceWord = (c: number): string => (c >= 0.8 ? T.confidence.high : c >= 0.5 ? T.confidence.medium : T.confidence.low);
const LEVEL_ORDER: Readonly<Record<string, number>> = { high: 0, medium: 1, low: 2, info: 3 };

function agentLine(r: PublicReport): string[] {
  const lines: string[] = [T.agent.address, T.agent.sandbox, T.agent.opened(Math.max(0, r.facts.chain.length - 1))];
  lines.push(r.mode === 'rules_only' ? T.agent.rules : T.agent.model);
  for (const s of r.steps) lines.push(T.agent.action(s.action, s.status));
  if (r.pending_approval > 0) lines.push(T.agent.waiting);
  lines.push(r.status.state === 'done' ? T.agent.destroyed : T.agent.stopped);
  return lines;
}

export const TABS = ['summary', 'security', 'network', 'links', 'behavior'] as const;
export type Tab = (typeof TABS)[number];
export const isTab = (v: string): v is Tab => (TABS as readonly string[]).includes(v);

export interface ReportMeta { id: string; shots: { desktop: boolean; mobile: boolean; tablet: boolean }; device: 'desktop' | 'mobile' | 'tablet'; checkedAt: number }

const fmtTime = (ms: number): string => new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

function findingsList(r: PublicReport): Html {
  const findings = [...r.signals].filter((s) => s.level !== 'info' || r.signals.length <= 4).sort((a, b) => (LEVEL_ORDER[a.level] ?? 9) - (LEVEL_ORDER[b.level] ?? 9));
  return findings.length
    ? html`<ul class="findings">${findings.map((s) => html`<li><span class="pill l-${s.level}">${T.level[s.level] ?? T.level.info}</span><span>${s.text}</span></li>`)}</ul>`
    : html`<p class="muted">${T.noFindings}</p>`;
}

const seriousCount = (r: PublicReport): number => r.signals.filter((s) => s.level === 'high' || s.level === 'medium').length;

function verdictBlock(r: PublicReport): Html {
  const has = (id: string) => r.signals.some((x) => x.id === id);
  const line = has('provider_warning') ? T.providerWarning : r.verdict !== 'unknown' ? T.verdictLine[r.verdict] : has('bot_challenge') ? T.challenge : has('http_error') ? T.refused : has('empty_page') ? T.emptyPage : T.verdictLine.unknown;
  return html`<section class="card verdict v-${r.verdict}">
<h2>${T.verdict[r.verdict]}</h2>
<p class="conf">${r.verdict === 'unknown' ? '' : confidenceWord(r.confidence)}</p>
<p>${line}</p>
</section>`;
}

function explanationBlock(r: PublicReport): Html {
  const explanation = r.summary ?? r.mode_text;
  if (!explanation) return html``;
  return html`<section class="card"><h2>${T.explainTitle}</h2><p class="explain">${explanation}</p>${r.reasons.length ? html`<ul class="plain">${r.reasons.map((x) => html`<li>${x.claim}</li>`)}</ul>` : ''}</section>`;
}

function chip(label: string, kind: 'ok' | 'bad' | 'warn' | 'none'): Html {
  return html`<span class="chip-state c-${kind}">${label}</span>`;
}

const SHOT_SIZE = { desktop: [1280, 800], mobile: [412, 839], tablet: [820, 1180] } as const;

/** Desktop / tablet / mobile, as plain links to the same page (no script needed). */
function shotSwitch(m: ReportMeta): Html {
  const have = (['desktop', 'tablet', 'mobile'] as const).filter((d) => m.shots[d]);
  if (have.length < 2) return html``;
  return html`<nav class="shot-switch" aria-label="${T.shotSwitch}">${have.map((d) => html`<a href="/r/${m.id}?shot=${d}"${d === m.device ? html` aria-current="true"` : ''}>${T.device[d]}</a>`)}</nav>`;
}

function devicesCard(r: PublicReport): Html {
  const ds = r.facts.devices;
  if (!ds.length) return html``;
  const worst = ds.some((d) => d.differs.includes('password_only_here'));
  return html`<section class="card"><h2>${T.devicesTitle}</h2>
<p>${worst ? T.devicesBad : ds.some((d) => d.differs.length) ? T.devicesDiffer : ds.every((d) => d.nav_error === null) ? T.devicesSame : T.devicesSome}</p>
<div class="tablewrap"><table class="table"><thead><tr><th>${T.devicesHead.device}</th><th>${T.devicesHead.site}</th><th>${T.devicesHead.password}</th><th>${T.devicesHead.note}</th></tr></thead><tbody>
${ds.map((d) => html`<tr><td>${T.device[d.device]}</td><td class="mono">${d.nav_error ? '—' : d.final_host}${d.title ? html`<br><span class="muted small">${d.title}</span>` : ''}</td><td>${d.nav_error ? '—' : d.has_password ? T.yes : T.no}</td><td>${d.nav_error ? T.devicesNotOpened : d.differs.length ? d.differs.map((x) => T.differs[x]).join(' ') : T.devicesAlike}</td></tr>`)}
</tbody></table></div></section>`;
}

const regionNames = (() => {
  try { return new Intl.DisplayNames('en', { type: 'region' }); } catch { return null; }
})();
const countryName = (cc: string | null): string => (cc === null ? '—' : `${regionNames?.of(cc) ?? cc} (${cc})`);

/** "4 days", "3 months", "15 years": a rough age for people. */
export function ageWords(days: number): string {
  if (days < 1) return 'today';
  if (days < 60) return `${plural(days, 'day', 'days')} ago`;
  if (days < 730) return `${plural(Math.round(days / 30.4), 'month', 'months')} ago`;
  return `${plural(Math.floor(days / 365.25), 'year', 'years')} ago`;
}

function domainCard(r: PublicReport): Html {
  const d = r.facts.domain;
  if (!d) return html`<section class="card"><h2>${T.domainTitle}</h2><p class="muted">${T.domainUnknown}</p></section>`;
  return html`<section class="card"><h2>${T.domainTitle}</h2>
<dl class="facts"><dt>${T.rows.domain}</dt><dd class="mono">${d.name}</dd>
<dt>${T.domainRegistered}</dt><dd>${d.created ? html`${d.created.slice(0, 10)}${d.age_days !== null ? html` <span class="muted">(${ageWords(d.age_days)})</span>` : ''}${d.age_days !== null && d.age_days < 30 ? html` <span class="pill l-medium">new</span>` : ''}` : '—'}</dd>
${d.registrar ? html`<dt>${T.domainRegistrar}</dt><dd>${d.registrar}</dd>` : ''}</dl></section>`;
}

function summaryTab(r: PublicReport, m: ReportMeta): Html {
  const f = r.facts;
  const serious = seriousCount(r);
  return html`
<section class="card sum">
<div class="sum-grid">
<dl class="facts sum-facts">
<dt>${T.rows.title}</dt><dd>${f.page_title || '—'}</dd>
<dt>${T.rows.domain}</dt><dd><b>${f.final_host || '—'}</b></dd>
<dt>${T.rows.verdict}</dt><dd><span class="badge v-${r.verdict}">${T.verdict[r.verdict]}</span></dd>
<dt>${T.rows.findings}</dt><dd>${serious ? chip(`${serious} found`, 'bad') : chip(T.none, 'ok')}</dd>
<dt>${T.rows.cert}</dt><dd>${f.tls.length ? chip(`${f.tls.length} found`, 'ok') : chip(T.none, 'none')}</dd>
<dt>${T.rows.redirects}</dt><dd>${Math.max(0, f.chain.length - 1)}</dd>
${f.domain?.created ? html`<dt>${T.domainRegistered}</dt><dd>${f.domain.age_days !== null ? ageWords(f.domain.age_days) : f.domain.created.slice(0, 10)}</dd>` : ''}
</dl>
<figure class="shot">
${shotSwitch(m)}
${m.shots[m.device] ? html`<a class="shot-link" href="/r/${m.id}/screenshot.png?device=${m.device}"><img class="shot-${m.device}" src="/r/${m.id}/screenshot.png?device=${m.device}" alt="${T.screenshotAlt}" width="${SHOT_SIZE[m.device][0]}" height="${SHOT_SIZE[m.device][1]}" loading="lazy"></a>` : html`<p class="muted">—</p>`}
<figcaption class="muted small">${T.screenshotNote}</figcaption>
</figure>
</div>
<p class="sumline">${T.sumLine(f.third_party_hosts, f.requests_total)}</p>
</section>
${verdictBlock(r)}
<section class="card"><h2>${T.findingsTitle}</h2>${findingsList(r)}</section>
${explanationBlock(r)}
<section class="card"><h2>${T.statsTitle}</h2>
<div class="stats">
${[[T.stats.requests, f.requests_total], [T.stats.sites, f.third_party_hosts], [T.stats.blocked, f.blocked_requests], [T.stats.forms, f.forms.length], [T.stats.links, f.links.length], [T.stats.redirects, Math.max(0, f.chain.length - 1)]].map(([k, v]) => html`<div class="stat"><span class="n">${v}</span><span class="k">${k}</span></div>`)}
</div></section>`;
}

function securityTab(r: PublicReport): Html {
  const f = r.facts;
  const pw = f.forms.filter((x) => x.has_password).length;
  const cross = f.forms.filter((x) => x.cross_origin).length;
  return html`
${verdictBlock(r)}
<section class="card"><h2>${T.findingsTitle}</h2>${findingsList(r)}</section>
${domainCard(r)}
${devicesCard(r)}
<section class="card"><h2>${T.certsTitle}</h2>
${f.tls.length ? html`<dl class="facts">${f.tls.map((c) => html`<dt>${T.rows.site}</dt><dd>${c.host || '—'}</dd><dt>${T.rows.issuer}</dt><dd>${c.issuer || '—'}</dd><dt>${T.rows.validUntil}</dt><dd>${c.valid_to ? c.valid_to.slice(0, 10) : '—'}</dd>`)}</dl>` : html`<p class="muted">${T.noCerts}</p>`}
</section>
<section class="card"><h2>${T.rows.forms}</h2>
${f.forms.length ? html`<p>${T.formsText(f.forms.length, pw, cross)}</p><ul class="plain">${f.forms.map((x) => html`<li>${x.has_password ? T.formPassword : T.formPlain}${x.action_host ? html` → <span class="mono">${x.action_host}</span>` : ''}${x.cross_origin ? html` <span class="pill l-high">${T.otherSite}</span>` : ''}${x.asks.length ? html`<br><span class="muted small">${T.formAsks}: ${x.asks.map((a) => T.ask[a] ?? a).join(', ')}</span>` : ''}</li>`)}</ul>` : html`<p class="muted">${T.formNone}</p>`}
</section>
${r.injection_attempt ? html`<p class="notice">${T.injection}</p>` : ''}`;
}

function networkTab(r: PublicReport): Html {
  const f = r.facts;
  return html`
<section class="card"><h2>${T.pathTitle}</h2>
${f.chain.length ? html`<ol class="path">${f.chain.map((c) => html`<li><span class="via">${T.pathVia[c.via] ?? T.pathViaOther}</span><span class="h">${c.host}</span></li>`)}</ol>` : html`<p class="muted">—</p>`}
</section>
<section class="card"><h2>${T.serversTitle}</h2>
${f.servers.length ? html`<p>${T.serversLine(f.servers_total, new Set(f.servers.map((x) => x.country).filter((c) => c !== null)).size, f.servers.reduce((a, x) => a + x.hosts.length, 0), f.requests_total)}</p>
<div class="tablewrap"><table class="table"><thead><tr><th>${T.serversHead.ip}</th><th>${T.serversHead.place}</th><th>${T.serversHead.net}</th><th>${T.serversHead.sites}</th><th>${T.serversHead.req}</th></tr></thead><tbody>
${f.servers.map((x) => html`<tr><td class="mono">${x.ip}</td><td>${countryName(x.country)}</td><td>${x.asn !== null ? html`AS${x.asn}` : '—'}${x.org ? html`<br><span class="muted small">${x.org}</span>` : ''}</td><td class="mono small">${x.hosts.join(', ') || '—'}</td><td>${x.requests}</td></tr>`)}
</tbody></table></div>
${f.servers_total > f.servers.length ? html`<p class="muted small">${T.serversMore(f.servers_total - f.servers.length)}</p>` : ''}
<p class="muted small">${T.serversNote} ${f.servers.some((x) => x.country !== null) ? T.attribution : ''}</p>` : html`<p class="muted">${T.serversNone}</p>`}
</section>
<section class="card"><h2>${T.sitesTitle}</h2>
<p>${T.sumLine(f.third_party_hosts, f.requests_total)}</p>
${f.hosts.length ? html`<ul class="hostlist">${f.hosts.map((h) => html`<li class="mono">${h}</li>`)}</ul>` : html`<p class="muted">${T.noOtherSites}</p>`}
${f.third_party_hosts > f.hosts.length ? html`<p class="muted small">${T.andMore(f.third_party_hosts - f.hosts.length)}</p>` : ''}
</section>
<section class="card"><h2>${T.sandboxTitle}</h2>
<dl class="facts"><dt>${T.rows.blocked}</dt><dd>${f.blocked_requests}</dd></dl>
<p class="muted">${T.sandboxNote}</p>
</section>`;
}

function linksTab(r: PublicReport): Html {
  const f = r.facts;
  const nowhere = f.links.filter((l) => l.goes === 'nowhere').length;
  return html`<section class="card"><h2>${T.linksTitle}</h2>
${f.links.length ? html`<div class="tablewrap"><table class="table"><thead><tr><th>${T.linkText}</th><th>${T.linkGoes}</th></tr></thead><tbody>${f.links.map((l) => html`<tr><td>${l.text || '—'}</td><td class="mono">${l.goes === 'nowhere' ? T.goesNowhere : l.goes === 'same' ? T.goesSame : l.host || '—'}${l.other_site ? html` <span class="pill l-medium">${T.otherSite}</span>` : ''}</td></tr>`)}</tbody></table></div>${nowhere >= 3 && nowhere * 2 >= f.links.length ? html`<p class="notice">${T.linksNowhere(nowhere, f.links.length)}</p>` : ''}<p class="muted small">${T.linksNote}</p>` : html`<p class="muted">${T.noLinks}</p>`}
</section>`;
}

function behaviorTab(r: PublicReport): Html {
  const f = r.facts;
  return html`
<section class="card"><h2>${T.behaviorTitle}</h2>
<dl class="facts">
<dt>${T.rows.hidden}</dt><dd>${f.hidden_text ? chip(T.yes, 'warn') : T.no}</dd>
<dt>${T.rows.popups}</dt><dd>${f.popups ? chip(String(f.popups), 'warn') : T.no}</dd>
<dt>${T.rows.dialogs}</dt><dd>${f.dialogs ? chip(String(f.dialogs), 'warn') : T.no}</dd>
<dt>${T.rows.downloads}</dt><dd>${f.downloads.length ? html`<ul class="plain tight">${f.downloads.map((d) => html`<li class="mono">${d.filename || '—'}${d.saved ? '' : ` (${T.notSaved})`}</li>`)}</ul>` : T.no}</dd>
</dl></section>
<section class="card"><h2>${T.agentTitle}</h2>
<ol class="timeline">${agentLine(r).map((l) => html`<li>${l}</li>`)}</ol>
</section>
`;
}

function approvalBlock(r: PublicReport): Html {
  return r.pending_approval > 0
    ? html`<section id="approval" class="card approval" data-pending="1" hidden><h2>${T.approvalTitle}</h2><p>${T.approvalText}</p><p id="approval-what" class="what"></p><div class="row"><button id="allow" class="btn primary" type="button">${T.allow}</button><button id="deny" class="btn" type="button">${T.deny}</button></div><p id="approval-result" class="muted" role="status"></p></section>
<p id="approval-guest" class="muted">${T.approvalOnlyOwner}</p>`
    : html``;
}

function chatPanel(m: ReportMeta): Html {
  return html`
<button class="explain-btn" type="button" id="explain-open" aria-controls="chat" aria-expanded="false">${T.chat.open}</button>
<aside class="chat" id="chat" hidden aria-label="${T.chat.title}"${m.shots.desktop ? html` data-shot="1"` : ''} data-explain="${T.chat.explainAsk}" data-thinking="${T.chat.thinking}" data-failed="${T.chat.failed}" data-rules="${T.chat.fromRules}" data-model="${T.chat.fromModel}" data-alt="${T.screenshotAlt}">
<header class="chat-head"><b>${T.chat.title}</b><button type="button" class="chat-x" id="chat-close" aria-label="${T.chat.close}">×</button></header>
<div class="chat-log" id="chat-log" role="log" aria-live="polite"></div>
<form class="chat-form" id="chat-form" autocomplete="off">
<input id="chat-input" name="q" maxlength="300" placeholder="${T.chat.placeholder}" aria-label="${T.chat.placeholder}">
<button class="btn primary" type="submit" id="chat-send">${T.chat.send}</button>
</form>
<p class="muted small chat-note">${T.chat.note}</p>
</aside>`;
}

export function reportPage(r: PublicReport, m: ReportMeta, tab: Tab = 'summary'): Html {
  const f = r.facts;
  const id = m.id;
  const body = ({ summary: summaryTab, security: securityTab, network: networkTab, links: linksTab, behavior: behaviorTab }[tab])(r, m);
  const base = `/r/${id}`;
  const page = html`
<section class="card head">
<div class="head-url">
<p class="muted">${T.checkedTitle}</p>
<h1 class="host">${f.final_host || r.url}</h1>
<dl class="meta">
<dt>${T.meta.id}</dt><dd class="mono">${id}</dd>
<dt>${T.meta.submitted}</dt><dd class="mono">${r.url}</dd>
<dt>${T.meta.finished}</dt><dd>${fmtTime(m.checkedAt)} <span class="chip-state c-none">${T.meta.link}</span></dd>
</dl>
</div>
<div class="head-actions">
<a class="btn" href="${base}/report.json" download="report-${id.slice(0, 8)}.json">${T.download}</a>
<button class="btn" type="button" id="copy" data-done="${T.copied}">${T.copyLink}</button>
</div>
</section>
${approvalBlock(r)}
${r.injection_attempt && tab !== 'security' ? html`<p class="notice">${T.injection}</p>` : ''}
<nav class="tabs" aria-label="${T.tabsLabel}">${TABS.map((t) => html`<a href="${t === 'summary' ? base : `${base}/${t}`}" ${t === tab ? html`aria-current="page"` : ''}>${T.tabs[t]}</a>`)}</nav>
<div class="stack">${body}</div>
<section class="row actions">
<a class="btn primary" href="/">${T.another}</a>
<span class="muted small">${T.shareNote}</span>
</section>
${chatPanel(m)}`;
  return layout(`${f.final_host || r.url} — ${T.verdict[r.verdict]} — ${T.brand}`, page, { taskId: id });
}

export function failedPage(id: string): Html {
  return layout(`${T.failedTitle} — ${T.brand}`, html`<section class="card center"><h1>${T.failedTitle}</h1><p>${T.failedText}</p><a class="btn primary" href="/">${T.another}</a></section>`, { taskId: id });
}

export function notFoundPage(): Html {
  return layout(`${T.notFoundTitle} — ${T.brand}`, html`<section class="card center"><h1>${T.notFoundTitle}</h1><p>${T.notFoundText}</p><a class="btn primary" href="/">${T.another}</a></section>`);
}

export const errorText = (code: string): string => T.errors[code] ?? T.errors.server!;
export type { GateReason };
