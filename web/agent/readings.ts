// The few things the rules, the report and the model's dossier all state about a visit, each defined once, so that the
// signal "contacted N other sites", the report's "other sites" and the dossier cannot give three answers (review A2).
import { parseUrl, registrable } from './domain.ts';
import { type Ev, str } from './guard.ts';

/** A request the browser or the sandbox refused: the collector gives the reason as text, or null (guest/collector tracker). */
export const isBlocked = (r: Ev): boolean => typeof r.blocked === 'string' && r.blocked !== '';

/** The other sites a visit contacted: the distinct hosts of its requests, except the page's own host. */
export function thirdPartyHosts(requests: readonly Ev[], pageHost: string): Set<string> {
  const hosts = new Set<string>();
  for (const r of requests) {
    const h = parseUrl(r.url)?.host;
    if (h && h !== pageHost) hosts.add(h);
  }
  return hosts;
}

/**
 * Does a form send what is typed into it to another SITE than the page it is on? Another site, not another origin: a
 * bank's sign-in form posting to connect.secure.bank.example from www.bank.example sends the password to the bank itself.
 * The collector read where the form really goes (action_origin), else the action decides; with no address to compare,
 * the collector's own flag does.
 */
export function formCrossesSites(f: Ev, here: URL | null): boolean {
  const stated = parseUrl(str(f.action_origin));
  if (stated && here) return registrable(stated.hostname) !== registrable(here.hostname);
  const target = parseUrl(str(f.action));
  if (target && here) return registrable(target.hostname) !== registrable(here.hostname);
  return f.origin_differs === true;
}
