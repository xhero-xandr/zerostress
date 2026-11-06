// The same address opened as a phone and as a tablet (collector, spec 005 3.7), compared with what the computer saw.
// A page that shows a password form, or sends the visitor to another site, only to a phone is hiding something from
// the robot that visits like a computer. One reading of the evidence, used by both the facts and the signals.

import { parseUrl, registrable } from './domain.ts';

type Ev = Record<string, unknown>;
const isObj = (v: unknown): v is Ev => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);

export type DeviceName = 'mobile' | 'tablet';
export type Difference = 'other_site' | 'password_only_here';

export interface DeviceView {
  device: DeviceName;
  /** the browser's error code if the page could not be opened as this device */
  nav_error: string | null;
  final_host: string;
  title: string;
  forms: number;
  has_password: boolean;
  action_hosts: string[];
  /** artifact name of the screenshot, if there is one */
  file: string | null;
  differs: Difference[];
  /** index of the event in the evidence */
  at: number;
}

export function deviceViews(events: readonly unknown[]): DeviceView[] {
  const evs = events.map((e, i) => [e, i] as const).filter((x): x is readonly [Ev, number] => isObj(x[0]));
  const last = (kind: string) => evs.filter(([e]) => e.kind === kind).at(-1);
  const summary = last('summary')?.[0];
  const page = last('page')?.[0];
  const desktopHost = parseUrl(summary?.final_url)?.hostname ?? parseUrl(page?.url)?.hostname ?? '';
  const forms = last('forms')?.[0];
  const desktopPassword = (Array.isArray(forms?.forms) && (forms.forms as unknown[]).some((f) => isObj(f) && f.has_password === true)) || Number(forms?.loose_password_fields) > 0;

  const seen = new Set<string>();
  const out: DeviceView[] = [];
  for (const [e, at] of evs) {
    if (e.kind !== 'device' || (e.device !== 'mobile' && e.device !== 'tablet') || seen.has(e.device)) continue;
    seen.add(e.device);
    const host = parseUrl(e.final_url)?.hostname ?? '';
    // an error code of an odd shape is still an error: it is replaced by ours, never read as success
    const navError = e.nav_error == null ? null : typeof e.nav_error === 'string' && /^[a-zA-Z0-9_]{1,60}$/.test(e.nav_error) ? e.nav_error : 'not_opened';
    const opened = navError === null && host !== '';
    const hasPassword = opened && e.has_password === true;
    const differs: Difference[] = [];
    if (opened && desktopHost !== '' && registrable(host) !== registrable(desktopHost)) differs.push('other_site');
    if (hasPassword && !desktopPassword) differs.push('password_only_here');
    out.push({
      device: e.device,
      nav_error: navError ?? (opened ? null : 'not_opened'),
      final_host: cut(host, 100),
      title: cut(str(e.title), 200),
      forms: opened && typeof e.forms === 'number' && e.forms >= 0 ? Math.min(Math.floor(e.forms), 99) : 0,
      has_password: hasPassword,
      action_hosts: (Array.isArray(e.action_origins) ? e.action_origins : []).slice(0, 5).map((o) => cut(parseUrl(o)?.host ?? '', 100)).filter(Boolean),
      file: typeof e.file === 'string' && /^[0-9a-f]{16}\.png$/.test(e.file) ? e.file : null,
      differs,
      at,
    });
  }
  return out;
}

export interface Shots { desktop: string | null; mobile: string | null; tablet: string | null }

/**
 * Which saved image is which. The computer's is the last image that is not a phone's or a tablet's (a live session may
 * take later ones); the others are named by their `device` events, and only if the supervisor really saved them.
 */
export function pickShots(events: readonly unknown[], artifacts: ReadonlyArray<{ name: string; mime: string }>): Shots {
  const saved = new Set(artifacts.filter((a) => a.mime === 'image/png').map((a) => a.name));
  const shots: Shots = { desktop: null, mobile: null, tablet: null };
  const device = new Set<string>();
  for (const v of deviceViews(events)) {
    if (v.file === null) continue;
    device.add(v.file);
    if (saved.has(v.file)) shots[v.device] = v.file;
  }
  shots.desktop = [...saved].filter((n) => !device.has(n)).at(-1) ?? null;
  return shots;
}
