// An email, read in the browser and never sent (spec 012): its source is taken apart as MIME (headers, parts, base64,
// quoted-printable, charsets, attachments, forwarded messages), and a few fixed checks look at the email itself:
// what the receiving server recorded about the sender (SPF, DKIM, DMARC), where replies go, a sender name that shows
// another address, risky attachments, links whose text shows another site. The links are offered for a check.
import { linksFromEmail, type EmailLink } from './logic.ts';
import { T } from './text.ts';

export interface EmailAttachment {
  name: string;
  type: string;
  risk: 'program' | 'web_page' | 'macros' | 'archive' | null;
  /** its content, decoded, kept in this page only: sent nowhere unless the person opens it in the sandbox */
  data: Uint8Array | null;
}
export interface EmailWarning { id: string; level: 'high' | 'medium'; text: string }
export interface EmailCheck {
  /** it was the source of an email (headers and MIME parts), not just its text */
  source: boolean;
  from: { name: string | null; address: string | null } | null;
  replyTo: string | null;
  subject: string | null;
  /** what the receiving server recorded (its Authentication-Results header), per method */
  auth: { spf: string | null; dkim: string | null; dmarc: string | null } | null;
  attachments: EmailAttachment[];
  links: EmailLink[];
  warnings: EmailWarning[];
}

const MAX_EMAIL = 300_000;
const MAX_PARTS = 100;
const MAX_DEPTH = 8;

type Headers = Map<string, string[]>;

function splitHead(raw: string): { head: string; body: string } {
  const i = raw.search(/\n\n/);
  return i < 0 ? { head: raw, body: '' } : { head: raw.slice(0, i), body: raw.slice(i + 2) };
}

function parseHeaders(head: string): Headers {
  const h: Headers = new Map();
  for (const line of head.replace(/\n[ \t]+/g, ' ').split('\n')) {
    const m = /^([A-Za-z0-9-]+):[ \t]*(.*)$/.exec(line);
    if (!m) continue;
    const k = m[1]!.toLowerCase();
    h.set(k, [...(h.get(k) ?? []), m[2]!.trim()]);
  }
  return h;
}

const first = (h: Headers, k: string): string | null => h.get(k)?.[0] ?? null;

/** a header parameter (boundary, charset, name, filename), plain, quoted or in RFC 2231 form (name*=utf-8''...) */
function param(value: string | null, name: string): string | null {
  if (!value) return null;
  const ext = new RegExp(`;\\s*${name}\\*=([^;]*)`, 'i').exec(value);
  if (ext) {
    const m = /^([^']*)'[^']*'(.*)$/.exec(ext[1]!.trim().replace(/^"|"$/g, ''));
    try { return m ? decodeText(percentBytes(m[2]!), m[1]!) : ext[1]!.trim(); } catch { /* fall through */ }
  }
  const m = new RegExp(`;\\s*${name}=("([^"]*)"|[^;\\s]*)`, 'i').exec(value);
  return m ? (m[2] ?? m[1]!) : null;
}

function percentBytes(s: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '%' && /^[0-9a-f]{2}$/i.test(s.slice(i + 1, i + 3))) { out.push(parseInt(s.slice(i + 1, i + 3), 16)); i += 2; }
    else out.push(s.charCodeAt(i) & 0xff);
  }
  return new Uint8Array(out);
}

function decodeText(bytes: Uint8Array, charset: string | null): string {
  try { return new TextDecoder((charset || 'utf-8').trim().toLowerCase()).decode(bytes); } catch { return new TextDecoder('utf-8').decode(bytes); }
}

function base64Bytes(s: string): Uint8Array {
  // the padding may be missing or damaged: drop it, then pad again (a single dangling character carries no byte)
  let clean = s.replace(/[^A-Za-z0-9+/]/g, '');
  if (clean.length % 4 === 1) clean = clean.slice(0, -1);
  try {
    const bin = atob(clean + '='.repeat((4 - (clean.length % 4)) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch { return new Uint8Array(); }
}

function qpBytes(s: string): Uint8Array {
  const t = s.replace(/=\n/g, '');
  const out: number[] = [];
  for (let i = 0; i < t.length; i++) {
    if (t[i] === '=' && /^[0-9A-F]{2}$/i.test(t.slice(i + 1, i + 3))) { out.push(parseInt(t.slice(i + 1, i + 3), 16)); i += 2; }
    else { const c = t.charCodeAt(i); if (c < 0x80) out.push(c); else out.push(...new TextEncoder().encode(t[i]!)); }
  }
  return new Uint8Array(out);
}

/** RFC 2047 encoded words in a header (=?utf-8?B?...?= and =?utf-8?Q?...?=) */
function decodeWords(v: string): string {
  return v.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=(\s+(?==\?))?/g, (_, cs: string, enc: string, data: string) =>
    decodeText(enc.toUpperCase() === 'B' ? base64Bytes(data) : qpBytes(data.replace(/_/g, ' ')), cs));
}

/** "Name" <a@b.c>, Name <a@b.c>, a@b.c */
function mailbox(v: string | null): { name: string | null; address: string | null } | null {
  if (!v) return null;
  const s = decodeWords(v);
  const m = /^(.*?)<([^<>@\s]+@[^<>\s]+)>\s*$/.exec(s);
  if (m) return { name: m[1]!.trim().replace(/^"|"$/g, '').trim() || null, address: m[2]!.toLowerCase() };
  const a = /([^\s<>"]+@[^\s<>"]+)/.exec(s);
  return { name: null, address: a ? a[1]!.toLowerCase() : null };
}

const domainOf = (address: string | null): string | null => address?.split('@').pop()?.replace(/[>\]]+$/, '') ?? null;
/** the same organisation, roughly: equal, or one is a subdomain of the other (mail.paypal.com and paypal.com) */
const sameSite = (a: string, b: string) => a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);

const PROGRAM = /\.(exe|scr|com|bat|cmd|pif|msi|msp|js|jse|vbs|vbe|wsf|wsh|hta|ps1|jar|lnk|iso|img|vhdx?|apk|dll|reg|cpl|msc|appx|msix|scf|url)$/i;
const WEB_PAGE = /\.(html?|shtml|xhtml|svg|mht|mhtml)$/i;
const MACROS = /\.(docm|xlsm|pptm|dotm|xltm|xlam|ppam)$/i;
const ARCHIVE = /\.(zip|rar|7z|tar|gz|tgz|cab|ace|arj)$/i;

function attachmentRisk(name: string, type: string): EmailAttachment['risk'] {
  if (PROGRAM.test(name) || /x-msdownload|x-msdos|x-dosexec|java-archive|x-ms-shortcut/i.test(type)) return 'program';
  if (WEB_PAGE.test(name) || /^text\/html$|svg/i.test(type)) return 'web_page';
  if (MACROS.test(name) || /macroenabled/i.test(type)) return 'macros';
  if (ARCHIVE.test(name) || /zip|rar|7z|compressed/i.test(type)) return 'archive';
  return null;
}

interface Walk { html: string[]; text: string[]; attachments: EmailAttachment[]; parts: number }

function walk(h: Headers, body: string, w: Walk, depth: number): void {
  if (depth > MAX_DEPTH || ++w.parts > MAX_PARTS) return;
  const ct = first(h, 'content-type') ?? 'text/plain';
  const type = ct.split(';')[0]!.trim().toLowerCase();
  if (type.startsWith('multipart/')) {
    const boundary = param(ct, 'boundary');
    if (!boundary) return;
    const pieces = body.split(new RegExp(`^--${boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:--)?[ \t]*$`, 'm'));
    for (const piece of pieces.slice(1)) {
      const p = piece.replace(/^\n/, '');
      if (!p.trim()) continue;
      const { head, body: b } = splitHead(p);
      walk(parseHeaders(head), b, w, depth + 1);
    }
    return;
  }
  const disposition = first(h, 'content-disposition');
  const name = param(disposition, 'filename') ?? param(ct, 'name');
  const enc = (first(h, 'content-transfer-encoding') ?? '').toLowerCase();
  const bytes = () => (enc === 'base64' ? base64Bytes(body) : enc === 'quoted-printable' ? qpBytes(body) : null);
  if (type === 'message/rfc822' && !name) {
    const raw = bytes();
    const inner = raw ? decodeText(raw, 'utf-8') : body;
    const { head, body: b } = splitHead(inner);
    walk(parseHeaders(head), b, w, depth + 1);
    return;
  }
  const attached = /^attachment/i.test(disposition ?? '') || (name !== null && !/^text\/(plain|html)$/.test(type));
  if (attached || !/^text\/(plain|html)$/.test(type)) {
    if (name || attached) {
      const n = decodeWords(name ?? '(no name)').slice(0, 200);
      const raw = bytes() ?? (enc === '' || enc === '7bit' || enc === '8bit' || enc === 'binary' ? new TextEncoder().encode(body) : null);
      w.attachments.push({ name: n, type, risk: attachmentRisk(n, type), data: raw && raw.length > 0 ? raw : null });
    }
    return;
  }
  const raw = bytes();
  const text = raw ? decodeText(raw, param(ct, 'charset')) : body;
  (type === 'text/html' ? w.html : w.text).push(text);
}

/** It is the source of an email: it starts with headers such as Received, From, Subject, MIME-Version. */
export function isEmailSource(raw: string): boolean {
  const { head } = splitHead(raw.replace(/\r\n?/g, '\n').trimStart().slice(0, 64_000));
  const names = [...head.matchAll(/^([A-Za-z0-9-]+):/gm)].map((m) => m[1]!.toLowerCase());
  return names.length >= 2 && names.some((n) => ['received', 'from', 'subject', 'mime-version', 'message-id', 'return-path', 'delivered-to'].includes(n));
}

/** Text pasted into the chat that reads as an email (or its source), not as a question. */
export function looksLikeEmail(text: string): boolean {
  const t = text.trim();
  if (isEmailSource(t)) return true;
  const links = linksFromEmail(t);
  if (links.length === 0) return false;
  return t.length > 200 || /\n/.test(t) || /<a\s|<html/i.test(t) || links.length > 1;
}

function authOf(h: Headers): EmailCheck['auth'] {
  // the topmost header is the one the receiving server (Gmail, Outlook) added; lower ones came with the email
  const v = first(h, 'authentication-results');
  if (!v) return null;
  const get = (k: string) => new RegExp(`\\b${k}=([a-z]+)`, 'i').exec(v)?.[1]?.toLowerCase() ?? null;
  return { spf: get('spf'), dkim: get('dkim'), dmarc: get('dmarc') };
}

const PASS = (v: string | null) => v === 'pass';
const FAIL = (v: string | null) => v === 'fail' || v === 'permerror';

function warningsOf(c: Omit<EmailCheck, 'warnings'>): EmailWarning[] {
  const W = T.mail.warn;
  const out: EmailWarning[] = [];
  const a = c.auth;
  if (a) {
    const forged = FAIL(a.dmarc) || ((FAIL(a.spf) || a.spf === 'softfail') && !PASS(a.dkim)) || (FAIL(a.dkim) && !PASS(a.spf));
    if (forged) out.push({ id: 'auth_failed', level: 'high', text: W.authFailed });
    else if (!PASS(a.spf) && !PASS(a.dkim) && !PASS(a.dmarc)) out.push({ id: 'auth_unconfirmed', level: 'medium', text: W.authUnconfirmed });
  }
  const fromDomain = domainOf(c.from?.address ?? null);
  const replyDomain = domainOf(c.replyTo);
  if (fromDomain && replyDomain && !sameSite(fromDomain, replyDomain)) out.push({ id: 'reply_elsewhere', level: 'medium', text: W.replyElsewhere(c.replyTo!, fromDomain) });
  const shown = c.from?.name ? /([a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,})\b/i.exec(c.from.name.replace(/^.*@/, ''))?.[1]?.toLowerCase() : null;
  if (shown && fromDomain && !sameSite(shown, fromDomain)) out.push({ id: 'name_shows_other_address', level: 'high', text: W.nameShowsOther(c.from!.name!, c.from!.address!) });
  for (const x of c.attachments) {
    if (x.risk === 'program') out.push({ id: 'attachment_program', level: 'high', text: W.attProgram(x.name) });
    if (x.risk === 'web_page') out.push({ id: 'attachment_web_page', level: 'high', text: W.attWebPage(x.name) });
    if (x.risk === 'macros') out.push({ id: 'attachment_macros', level: 'high', text: W.attMacros(x.name) });
    if (x.risk === 'archive') out.push({ id: 'attachment_archive', level: 'medium', text: W.attArchive(x.name) });
  }
  const lying = c.links.filter((l) => l.shown).length;
  if (lying) out.push({ id: 'link_text_elsewhere', level: 'high', text: W.linkText(lying) });
  return out;
}

/**
 * The links worth opening for the whole email: not an unsubscribe or a preferences link, which would act on the
 * person's mailing list just by being opened, and at most ten.
 */
export function linksToCheck(links: readonly EmailLink[]): string[] {
  return links.map((l) => l.url).filter((u) => !/unsubscri|opt[-_]?out|optout|manage[-_]?preferences|email[-_]?preferences/i.test(u)).slice(0, 10);
}

/** Read an email (its text or its source) in the browser. Nothing is sent anywhere. */
export function readEmail(input: string): EmailCheck {
  const raw = input.slice(0, MAX_EMAIL).replace(/\r\n?/g, '\n');
  if (!isEmailSource(raw)) {
    const links = linksFromEmail(raw);
    const base = { source: false, from: null, replyTo: null, subject: null, auth: null, attachments: [], links };
    return { ...base, warnings: warningsOf(base) };
  }
  const { head, body } = splitHead(raw.trimStart());
  const h = parseHeaders(head);
  const w: Walk = { html: [], text: [], attachments: [], parts: 0 };
  walk(h, body, w, 0);
  const seen = new Set<string>();
  const links = [...w.html, ...w.text].flatMap((t) => linksFromEmail(t, { decoded: true })).filter((l) => !seen.has(l.url) && seen.add(l.url));
  const base = {
    source: true,
    from: mailbox(first(h, 'from')),
    replyTo: mailbox(first(h, 'reply-to'))?.address ?? null,
    subject: first(h, 'subject') ? decodeWords(first(h, 'subject')!).slice(0, 300) : null,
    auth: authOf(h),
    attachments: w.attachments.slice(0, 20),
    links: links.slice(0, 30),
  };
  return { ...base, warnings: warningsOf(base) };
}
