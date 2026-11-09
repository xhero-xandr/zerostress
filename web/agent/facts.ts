// What the page showed, in the plain form a person can read (spec 007, 3.5): the way the link went, the page's own name,
// the forms and the certificate. Built from the evidence by listed fields, with fixed limits. Every string in it comes
// from the page or the network, so report.ts lists them as untrusted.

import { parseUrl } from './domain.ts';
import { landingView, linkVisit } from './evidence.ts';
import { asksOf, type Ask } from './fields.ts';
import { deviceViews, type DeviceView } from './devices.ts';
import { hidesText } from './hiding.ts';
import { ipv4ToInt, type GeoLookup } from './geo.ts';
import type { DomainInfo } from './rdap.ts';
import { isObj, str, list, cut } from './guard.ts';
import { formCrossesSites, isBlocked, thirdPartyHosts } from './readings.ts';


export interface Facts {
  final_host: string;
  page_title: string;
  /** hosts the browser went through, in order, with how it got there (requested, http, meta, script, commit ...) */
  chain: Array<{ via: string; host: string }>;
  /** `asks`: what the form asks a person to type, as kinds of our own (fields.ts), not the page's words */
  forms: Array<{ action_host: string; cross_origin: boolean; has_password: boolean; asks: Ask[] }>;
  tls: Array<{ host: string; issuer: string; valid_to: string }>;
  /** requests the sandbox or the browser refused */
  blocked_requests: number;
  /** other sites the page called while loading */
  third_party_hosts: number;
  /** every request the page made while loading */
  requests_total: number;
  /** the other sites it called (names only) */
  hosts: string[];
  /** links on the page: the words shown and where each goes */
  links: Array<{ text: string; host: string; other_site: boolean; goes: 'nowhere' | 'same' | 'other' }>;
  /** the machines the browser talked to: address, where the network is registered, and which sites were served from it */
  servers: Array<{ ip: string; country: string | null; asn: number | null; org: string | null; hosts: string[]; requests: number }>;
  /** how many addresses there were in all (`servers` keeps the busiest) */
  servers_total: number;
  /** the final site's registrable domain: when it was registered, and by whom (null if the registry could not be asked) */
  domain: { name: string; created: string | null; age_days: number | null; registrar: string | null } | null;
  /** the page opened as a phone and as a tablet, compared with the computer (devices.ts) */
  devices: Array<Omit<DeviceView, 'file' | 'at'> & { image: boolean }>;
  hidden_text: boolean;
  popups: number;
  dialogs: number;
  downloads: Array<{ filename: string; saved: boolean }>;
}

const IP_SHAPE = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-f:]{2,45})$/i;

export interface FactsExtra {
  /** country and network of an address; without it the servers carry no place */
  geo?: GeoLookup | null;
  domain?: DomainInfo | null;
}

export function buildFacts(events: readonly unknown[], extra: FactsExtra = {}): Facts {
  // the report describes the link's own visit and the page it led to, all from that one page (evidence.ts); what the
  // agent did afterwards in a deep check is reported as its steps, not as the site
  const evs = linkVisit(events).filter(isObj);
  const of = (kind: string) => evs.filter((e) => e.kind === kind);
  // behaviour (pop-ups, dialogs, downloads) counts for the whole check, including the agent's approved download
  const all = (kind: string) => events.filter(isObj).filter((e) => e.kind === kind);

  const summary = events.filter(isObj).filter((e) => e.kind === 'summary').at(-1);
  const land = landingView(events);
  const page = land?.page;
  const finalUrl = parseUrl(summary?.final_url) ?? parseUrl(land?.url);

  const chain: Facts['chain'] = [];
  for (const n of of('nav')) {
    if (n.via === 'commit') continue;
    const host = parseUrl(n.to)?.host ?? '';
    if (host !== '' && chain.at(-1)?.host !== host) chain.push({ via: cut(str(n.via), 20), host: cut(host, 100) });
  }
  const last = finalUrl?.host ?? '';
  if (last !== '' && chain.at(-1)?.host !== last) chain.push({ via: 'commit', host: cut(last, 100) });

  const requests = of('request');
  const blocked = requests.filter(isBlocked).length;
  const hosts = thirdPartyHosts(requests, last);

  // one entry per address: how many requests it served and for which sites (a name is only ever shown, never followed)
  const byIp = new Map<string, { requests: number; hosts: Set<string> }>();
  for (const r of requests) {
    const ip = str(r.ip).toLowerCase();
    if (!IP_SHAPE.test(ip) || (ip.includes('.') && ipv4ToInt(ip) === null)) continue;
    const e = byIp.get(ip) ?? { requests: 0, hosts: new Set<string>() };
    e.requests++;
    const h = parseUrl(r.url)?.host;
    if (h) e.hosts.add(h);
    byIp.set(ip, e);
  }
  const servers = [...byIp.entries()].sort((a, b) => b[1].requests - a[1].requests).slice(0, 20).map(([ip, e]) => {
    const g = extra.geo?.(ip) ?? { country: null, asn: null, org: null };
    return { ip, country: g.country, asn: g.asn, org: g.org === null ? null : cut(g.org, 80), hosts: [...e.hosts].slice(0, 3).map((h) => cut(h, 100)), requests: Math.min(e.requests, 99999) };
  });

  // without any page there is nothing to mix them up with, so the visit's last forms and links stand on their own
  const links = list((land?.links ?? of('links').at(-1))?.links).filter(isObj).slice(0, 30).map((l) => {
    const h = parseUrl(l.href)?.host ?? '';
    const href = str(l.href).trim();
    // an empty address, a bare # or a script call lead nowhere; a relative address stays on the site
    const goes = href === '' || href.startsWith('#') || /^javascript:/i.test(href) ? 'nowhere' : l.origin_differs === true ? 'other' : 'same';
    return { text: cut(str(l.text), 80), host: cut(h, 100), other_site: l.origin_differs === true, goes } as const;
  });

  return {
    final_host: cut(last, 100),
    page_title: cut(str(page?.title), 200),
    chain: chain.slice(0, 12),
    forms: list((land?.forms ?? of('forms').at(-1))?.forms).filter(isObj).slice(0, 5).map((f) => ({
      action_host: cut(parseUrl(f.action)?.host ?? '', 100),
      cross_origin: formCrossesSites(f, parseUrl(land?.url)),
      has_password: f.has_password === true,
      asks: asksOf(f.fields),
    })),
    tls: of('tls').slice(0, 3).map((e) => ({ host: cut(str(e.host), 100), issuer: cut(str(e.issuer), 80), valid_to: cut(str(e.valid_to), 40) })),
    blocked_requests: Math.min(blocked, 9999),
    third_party_hosts: Math.min(hosts.size, 999),
    requests_total: Math.min(requests.length, 99999),
    hosts: [...hosts].slice(0, 20).map((h) => cut(h, 100)),
    links,
    servers,
    servers_total: Math.min(byIp.size, 999),
    domain: extra.domain ? { name: cut(extra.domain.domain, 100), created: extra.domain.created, age_days: extra.domain.age_days, registrar: extra.domain.registrar === null ? null : cut(extra.domain.registrar, 80) } : null,
    devices: deviceViews(events).map(({ file, at: _at, ...v }) => ({ ...v, image: file !== null })),
    hidden_text: hidesText(page?.hidden_text),
    popups: Math.min(all('popup').length, 99),
    dialogs: Math.min(all('dialog').length, 99),
    downloads: all('download').slice(0, 5).map((e) => ({ filename: cut(str(e.filename), 100), saved: e.saved === true })),
  };
}
