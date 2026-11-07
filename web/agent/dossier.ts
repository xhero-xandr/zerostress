// The dossier: what the model is shown (spec 008, 4). It is not the raw evidence but a summary the code writes, with
// fixed limits, so that the model reads a page's behaviour and not a page's prose. The evidence has passed the hooks
// (009); the strings in the dossier are still data, and it is delivered in a block that says so.

import { currentView, landingView, linkVisit } from './evidence.ts';
import type { Analysis } from './signals.ts';
import { parseUrl } from './domain.ts';

type Ev = Record<string, unknown>;
const isObj = (v: unknown): v is Ev => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);

export const DOSSIER_MAX_CHARS = 40_000;
const TEXT_STEPS = [6000, 2000, 500, 0];

export interface Dossier {
  json: Record<string, unknown>;
  /** the references the model may cite: signal ids and the names of the fields of the dossier it was shown */
  ids: Set<string>;
}

export function buildDossier(events: readonly unknown[], analysis: Analysis, mode: 'text' | 'vision'): Dossier {
  const evs = events.filter(isObj);
  const of = (kind: string) => evs.filter((e) => e.kind === kind);
  const ids = new Set<string>(analysis.signals.map((s) => s.id));

  // where the link led comes from its own visit; the page, its forms and links are the ones in front of the agent now,
  // with that page's own address, so the model never reads one page's title next to another page's address (evidence.ts)
  const navs = linkVisit(events).filter(isObj).filter((e) => e.kind === 'nav');
  const requested = str(navs.find((e) => e.via === 'requested')?.to);
  const summary = of('summary').at(-1);
  const now = currentView(events);
  const page = now?.page;
  const finalUrl = str(summary?.final_url) || str(landingView(events)?.url);

  const chain: Array<{ via: string; host: string }> = [];
  for (const n of navs) {
    const host = parseUrl(n.to)?.host ?? '';
    if (host !== '' && chain.at(-1)?.host !== host) chain.push({ via: cut(str(n.via), 20), host: cut(host, 100) });
  }

  const tls = of('tls').slice(0, 5).map((e) => ({ host: cut(str(e.host), 100), issuer: cut(str(e.issuer), 80), valid_from: cut(str(e.valid_from), 40), valid_to: cut(str(e.valid_to), 40) }));

  const forms = list(now?.forms?.forms).filter(isObj).slice(0, 5).map((f) => ({
    action_host: cut(parseUrl(f.action)?.host ?? '', 100),
    cross_origin: f.origin_differs === true,
    has_password: f.has_password === true,
    fields: list(f.fields).filter(isObj).slice(0, 20).map((x) => ({ type: cut(str(x.type), 20), name: cut(str(x.name), 40), label: cut(str(x.label), 80) })),
  }));

  const links = list(now?.links?.links).filter(isObj).slice(0, 30).map((l) => ({
    ref: cut(str(l.ref), 12), text: cut(str(l.text), 80), host: cut(parseUrl(l.href)?.host ?? '', 100),
  }));

  const downloads = of('download').slice(0, 5).map((e) => ({ filename: cut(str(e.filename), 100), mime: cut(str(e.mime), 60), saved: e.saved === true }));

  const pageText = str(page?.text);
  const hidden = isObj(page?.hidden_text) && page.hidden_text.present === true;
  const meta = list(page?.meta).filter(isObj).slice(0, 10).map((m) => ({ name: cut(str(m.name), 40), content: cut(str(m.content), 200) }));

  const build = (textChars: number, linkCount: number): Record<string, unknown> => ({
    mode,
    requested_url: cut(requested, 300),
    final_url: cut(finalUrl, 300),
    chain,
    ...(tls.length ? { tls } : {}),
    ...(page ? { page: { url: cut(now!.url, 300), title: cut(str(page.title), 200), lang: cut(str(page.lang), 20), text: cut(pageText, textChars), hidden_text_present: hidden, meta } } : {}),
    ...(forms.length ? { forms } : {}),
    ...(links.length ? { links: links.slice(0, linkCount) } : {}),
    ...(downloads.length ? { downloads } : {}),
    signals: analysis.signals.map((s) => ({ id: s.id, level: s.level, text: s.text })),
    rules_verdict: analysis.verdict,
  });

  // shrink the text, then the links, until it fits
  let json = build(TEXT_STEPS[0]!, 30);
  for (const chars of TEXT_STEPS) {
    json = build(chars, chars >= 2000 ? 30 : 10);
    if (JSON.stringify(json).length <= DOSSIER_MAX_CHARS) break;
  }

  // a reason may point at any field of the dossier it was shown ("final_url", "forms", "signals"), as well as at a signal
  for (const key of Object.keys(json)) if (key !== 'mode') ids.add(key);
  return { json, ids };
}
