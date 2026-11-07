// One way to read the collector's evidence as pages, shared by the rules, the report and the model's dossier, so that
// they cannot disagree about which page they describe.
//
// The collector reports a page as page, forms, snapshot, links, in that order, every time it reads one: once for where
// the link led (the scan), and again after each command in a deep check. Its summary comes last and names where the link
// led, not where the agent went. A page is only ever judged against its own address.

type Ev = Record<string, unknown>;
const isObj = (v: unknown): v is Ev => typeof v === 'object' && v !== null && !Array.isArray(v);

export interface PageView {
  page: Ev;
  /** index of the page event in the evidence */
  at: number;
  /** the address this page was read at */
  url: string;
  forms: Ev | undefined;
  formsAt: number | undefined;
  links: Ev | undefined;
  /** read after the agent took over, not by the link's own visit */
  bySession: boolean;
}

/** Index of the first event of the deep check's session; the length of the evidence when there was none. */
export function sessionStart(events: readonly unknown[]): number {
  const i = events.findIndex((e) => isObj(e) && e.kind === 'session_ready');
  return i < 0 ? events.length : i;
}

/** Every page the collector read, each with the forms and links it reported for that page. */
export function pageViews(events: readonly unknown[]): PageView[] {
  const start = sessionStart(events);
  const views: PageView[] = [];
  events.forEach((e, i) => {
    if (!isObj(e)) return;
    if (e.kind === 'page') {
      views.push({ page: e, at: i, url: typeof e.url === 'string' ? e.url : '', forms: undefined, formsAt: undefined, links: undefined, bySession: i > start });
      return;
    }
    const v = views.at(-1);
    if (!v) return;
    // a later reading of the same page replaces an earlier one; a new page starts a new view
    if (e.kind === 'forms') { v.forms = e; v.formsAt = i; }
    if (e.kind === 'links') v.links = e;
  });
  return views;
}

/** The page the link itself led to: the last one read before the agent took over. */
export function landingView(events: readonly unknown[]): PageView | undefined {
  return pageViews(events).filter((v) => !v.bySession).at(-1);
}

/** The page in front of the agent now: the last one read. */
export function currentView(events: readonly unknown[]): PageView | undefined {
  return pageViews(events).at(-1);
}

/** The events of the link's own visit, without what the agent did afterwards. */
export function linkVisit(events: readonly unknown[]): readonly unknown[] {
  return events.slice(0, sessionStart(events));
}
