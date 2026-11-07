// The agent in the browser's side panel (spec 013): the extension frames this page, so it updates with the site. A
// conversation about one link at a time: the check runs on ZeroStress as from the home page, the agent log shows what
// happens in the microVM, a risky action waits for Allow / Don't allow, then the verdict, its explanation and questions.
// Text from a page or the model is rendered as text by React, never as markup.
import { useEffect, useRef, useState } from 'react';
import type { LogEntry } from '../../../agent/agent-log.ts';
import type { PublicReport } from '../../../agent/report-types.ts';
import { ApiError, askChat, askSecondOpinion, decide, getPending, getReport, getStatus, reportJsonUrl, shotUrl, startTask, type Pending, type TaskStatus } from '../api.ts';
import { EXTENSION_ORIGIN } from '../extension.ts';
import { asLogEntry, isTaskId, linkFromQuery, linksFromEmail, logLine, logTime, looksLikeEmail, mailboxOf, panelFacts, verdictLine, type EmailLink } from '../logic.ts';
import { ShotViewer } from '../shot-viewer.tsx';
import { T } from '../text.ts';
import { btnPrimary, btnSecondary } from '../ui.tsx';

type Item =
  | { kind: 'you'; text: string }
  | { kind: 'agent'; text: string }
  | { kind: 'steps'; entries: LogEntry[] }
  | { kind: 'approval'; p: Pending; done: string | null }
  | { kind: 'verdict'; r: PublicReport; id: string; key: string; shots: TaskStatus['shots'] | null }
  | { kind: 'email'; links: EmailLink[] }
  | { kind: 'consent'; id: string; key: string };

const P = T.panel;
const errText = (e: unknown) => (e instanceof ApiError ? e.message : T.serverError);
const webLink = (s: string) => linkFromQuery(`?u=${encodeURIComponent(s.trim())}`);

export function Panel() {
  const [items, setItems] = useState<Item[]>([{ kind: 'agent', text: P.hello }]);
  const [text, setText] = useState(linkFromQuery(location.search));
  const [deep, setDeep] = useState(false);
  // read when a check starts: the extension's link arrives through a listener set up once, which would see only the first value
  const deepNow = useRef(false);
  deepNow.current = deep;
  const task = useRef<{ id: string; key: string; report: boolean; es: EventSource | null } | null>(null);
  const busy = useRef(false);
  const end = useRef<HTMLDivElement>(null);
  const asked = useRef(new Set<string>());

  // the place of each new message is known when it is added (a counter), not when React gets to the update
  const count = useRef(1);
  const push = (it: Item) => { const at = count.current++; setItems((cur) => [...cur, it]); return () => at; };
  const say = (t: string) => push({ kind: 'agent', text: t });
  const update = (where: () => number, f: (it: Item) => Item) => setItems((cur) => cur.map((it, i) => (i === where() ? f(it) : it)));
  useEffect(() => { end.current?.scrollIntoView?.({ block: 'end' }); }, [items]);

  // the server answers one question at a time per person: a question asked while the agent is still explaining waits
  // its turn here instead of being refused as "still being answered"
  const talking = useRef<Promise<void>>(Promise.resolve());
  function answer(id: string, payload: { kind: 'explain' } | { kind: 'ask'; message: string }): Promise<void> {
    const at = say(P.thinking);
    talking.current = talking.current.then(async () => {
      let reply: string;
      try { reply = (await askChat(id, payload)).text; } catch (e) { reply = errText(e); }
      update(at, () => ({ kind: 'agent', text: reply }));
    });
    return talking.current;
  }

  async function finish(id: string, key: string) {
    let r: PublicReport;
    try { r = await getReport(id); } catch (e) { say(errText(e)); busy.current = false; return; }
    if (task.current?.id === id) task.current.report = true;
    const shots = await getStatus(id).then((st) => st.shots, () => null);
    push({ kind: 'verdict', r, id, key, shots });
    busy.current = false;
    await answer(id, { kind: 'explain' });
  }

  async function askOwner(id: string, key: string) {
    let pending: Pending[] = [];
    try { pending = (await getPending(id, key)).pending; } catch (e) { say(errText(e)); return; }
    for (const p of pending) {
      if (asked.current.has(p.command_id)) continue;
      asked.current.add(p.command_id);
      push({ kind: 'approval', p, done: null });
    }
  }

  function follow(id: string, key: string) {
    const steps = push({ kind: 'steps', entries: [] });
    const es = new EventSource(`/api/tasks/${id}/events`);
    task.current!.es = es;
    es.addEventListener('log', (ev) => {
      let entry: LogEntry | null = null;
      try { entry = asLogEntry(JSON.parse((ev as MessageEvent<string>).data)); } catch { /* not ours */ }
      if (entry) update(steps, (it) => (it.kind === 'steps' && it.entries.length < 200 ? { ...it, entries: [...it.entries, entry!] } : it));
    });
    es.addEventListener('approval', (ev) => {
      let waiting = false;
      try { waiting = (JSON.parse((ev as MessageEvent<string>).data) as { waiting?: unknown }).waiting === true; } catch { /* not ours */ }
      if (waiting) void askOwner(id, key);
    });
    es.addEventListener('final', () => { es.close(); void finish(id, key); });
    es.onerror = () => { if (es.readyState === EventSource.CLOSED) { say(P.lost); busy.current = false; } };
  }

  async function check(raw: string) {
    if (busy.current) return;
    push({ kind: 'you', text: P.checkThis(raw.trim()) });
    const link = webLink(raw);
    if (!link) { say(P.notALink); return; }
    const mailbox = mailboxOf(link);
    if (mailbox) { say(P.mailbox(mailbox)); return; }
    task.current?.es?.close();
    busy.current = true;
    try {
      const { id, key } = await startTask(link, deepNow.current);
      if (!isTaskId(id) || !/^[A-Za-z0-9_-]{20,100}$/.test(key)) throw new ApiError(500, 'server', T.serverError);
      task.current = { id, key, report: false, es: null };
      asked.current = new Set();
      say(P.starting);
      follow(id, key);
    } catch (e) {
      say(errText(e));
      busy.current = false;
    }
  }

  // a link chosen with a right-click: only from the extension that frames this page
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== window.parent || e.origin !== EXTENSION_ORIGIN) return;
      const d = e.data as { type?: unknown; link?: unknown };
      if (d?.type === 'zs-check' && typeof d.link === 'string') void check(d.link);
    };
    window.addEventListener('message', onMessage);
    if (window.parent !== window) window.parent.postMessage({ type: 'zs-ready' }, EXTENSION_ORIGIN);
    return () => window.removeEventListener('message', onMessage);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    setText('');
    // a pasted email is read here and never sent: its links are offered, as on the home page
    if (!webLink(t) && looksLikeEmail(t)) {
      push({ kind: 'you', text: P.pastedEmail(t.length) });
      const links = linksFromEmail(t);
      if (links.length) push({ kind: 'email', links }); else say(P.emailNone);
      return;
    }
    if (webLink(t) || !task.current?.report) { void check(t); return; }
    push({ kind: 'you', text: t });
    void answer(task.current.id, { kind: 'ask', message: t.slice(0, 300) });
  };

  async function decideOn(at: number, p: Pending, allow: boolean) {
    const t = task.current;
    if (!t) return;
    update(() => at, (it) => (it.kind === 'approval' ? { ...it, done: '…' } : it));
    let done: string;
    try { await decide(t.id, t.key, p, allow); done = allow ? P.allowed : P.denied; } catch (e) { done = errText(e); }
    update(() => at, (it) => (it.kind === 'approval' ? { ...it, done } : it));
  }

  async function second(id: string, key: string, publish: boolean) {
    const at = say(T.second.asking);
    try {
      const { second_opinion: so } = await askSecondOpinion(id, key, publish);
      update(at, () => ({ kind: 'agent', text: T.log.second(so.source, so.status, so.malicious, so.final_host) }));
      await finish(id, key);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'needs_consent') update(at, () => ({ kind: 'consent', id, key }));
      else update(at, () => ({ kind: 'agent', text: errText(e) }));
    }
  }

  const bubble = 'max-w-[92%] rounded-2xl px-3.5 py-2.5 [overflow-wrap:anywhere]';
  return (
    <div className="flex h-screen flex-col bg-canvas text-fg">
      <header className="flex items-center gap-2.5 border-b border-line bg-surface px-4 py-3">
        <div className="flex flex-col"><strong>{P.title}</strong><span className="text-xs text-muted">{P.tagline}</span></div>
      </header>
      <main aria-live="polite" className="flex flex-1 flex-col gap-2.5 overflow-y-auto p-4 text-[14px]">
        {items.map((it, i) => {
          if (it.kind === 'you') return <div key={i} className={`${bubble} self-end rounded-br-sm bg-accent text-white`}>{it.text}</div>;
          if (it.kind === 'agent') return <div key={i} className={`${bubble} self-start rounded-bl-sm border border-line bg-surface`}>{it.text}</div>;
          if (it.kind === 'steps') return (
            <div key={i} className={`${bubble} self-start rounded-bl-sm border border-line bg-surface`}>
              <p>{P.working}</p>
              <ol aria-label={T.logTitle} className="mt-1.5 flex flex-col gap-1 text-[12.5px] text-muted">
                {it.entries.map((e, j) => <li key={j} className="grid grid-cols-[3.6rem_1fr] gap-1.5"><span className="font-mono text-faint">{logTime(e.t)}</span><span>{logLine(e)}</span></li>)}
              </ol>
            </div>
          );
          if (it.kind === 'approval') return (
            <div key={i} role="alertdialog" aria-label={P.needYou} className={`${bubble} self-start rounded-bl-sm border-2 border-amber-500 bg-surface`}>
              <p>{P.needYou}</p>
              <p className="mt-1 font-semibold">{it.p.label}</p>
              {it.done === null
                ? <div className="mt-2 flex gap-2"><button type="button" className={btnPrimary} onClick={() => void decideOn(i, it.p, true)}>{P.allow}</button><button type="button" className={btnSecondary} onClick={() => void decideOn(i, it.p, false)}>{P.deny}</button></div>
                : <p className="mt-2 text-muted">{it.done}</p>}
            </div>
          );
          if (it.kind === 'email') return (
            <div key={i} className={`${bubble} self-start rounded-bl-sm border border-line bg-surface`}>
              <p>{P.emailFound(it.links.length)}</p>
              <ul className="mt-2 flex flex-col gap-2">
                {it.links.map((l, j) => (
                  <li key={j} className="flex flex-col gap-1 rounded-lg border border-line p-2">
                    <span className="font-mono text-[12.5px] [overflow-wrap:anywhere]">{l.url}</span>
                    {l.shown && <span className="text-[12.5px] font-semibold text-danger">{T.emailShown(l.shown)}</span>}
                    {l.wrapper && <span className="text-[12.5px] text-muted">{T.emailWrapped(l.wrapper)}</span>}
                    <button type="button" className={`${btnSecondary} self-start`} onClick={() => void check(l.url)}>{T.emailCheck}</button>
                  </li>
                ))}
              </ul>
            </div>
          );
          if (it.kind === 'consent') return (
            <div key={i} className={`${bubble} self-start rounded-bl-sm border border-line bg-surface`}>
              <p>{T.second.consentText}</p>
              <div className="mt-2 flex gap-2"><button type="button" className={btnPrimary} onClick={() => { update(() => i, () => ({ kind: 'agent', text: T.second.consentTitle })); void second(it.id, it.key, true); }}>{T.second.consentYes}</button></div>
            </div>
          );
          const r = it.r;
          const serious = r.signals.filter((s) => s.level === 'high' || s.level === 'medium').slice(0, 4);
          return (
            <div key={i} className={`${bubble} self-start rounded-bl-sm border border-line bg-surface`}>
              <p className={`font-bold ${r.verdict === 'malicious' ? 'text-danger' : r.verdict === 'benign' ? 'text-accent' : ''}`}>{P.verdictLead} {T.verdict[r.verdict]}</p>
              <p>{verdictLine(r)}</p>
              {serious.length > 0 && <ul className="mt-1.5 list-disc pl-5 text-[13px] text-muted">{serious.map((s) => <li key={s.id}>{s.text}</li>)}</ul>}
              <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[12.5px]">
                {panelFacts(r).map(([k, v]) => [<dt key={`${k}-t`} className="text-faint">{k}</dt>, <dd key={`${k}-d`} className="[overflow-wrap:anywhere]">{v}</dd>])}
              </dl>
              {it.shots && (it.shots.desktop || it.shots.tablet || it.shots.mobile) && (
                <div className="mt-2.5">
                  <p className="text-[12px] text-faint">{P.shotsTitle}</p>
                  <div className="mt-1 flex items-start gap-2">
                    {(['desktop', 'tablet', 'mobile'] as const).filter((d) => it.shots![d]).map((d) => (
                      <ShotViewer key={d} src={shotUrl(it.id, d)} alt={T.screenshotAlt(T.device[d]!)} className={d === 'desktop' ? 'w-[150px]' : 'w-[62px]'}>
                        <img src={shotUrl(it.id, d)} alt={T.screenshotAlt(T.device[d]!)} loading="lazy" className="w-full rounded-md border border-line object-cover object-top" />
                      </ShotViewer>
                    ))}
                  </div>
                </div>
              )}
              <div className="mt-2 flex flex-wrap gap-2">
                <a className={`${btnSecondary} no-underline`} href={`/r/${it.id}#k=${it.key}`} target="_blank" rel="noopener noreferrer">{P.openReport}</a>
                <a className={`${btnSecondary} no-underline`} href={reportJsonUrl(it.id)} download={`report-${it.id.slice(0, 8)}.json`}>{P.downloadJson}</a>
                {r.verdict === 'unknown' && !r.second_opinion && <button type="button" className={btnPrimary} onClick={() => void second(it.id, it.key, false)}>{T.second.ask}</button>}
              </div>
            </div>
          );
        })}
        <div ref={end} />
      </main>
      <form onSubmit={submit} className="flex flex-col gap-2 border-t border-line bg-surface px-4 pt-2.5 pb-3.5">
        <label className="flex items-start gap-2 text-[12.5px] text-muted"><input type="checkbox" checked={deep} onChange={(e) => setDeep(e.target.checked)} className="mt-0.5" /> {P.deep}</label>
        <div className="flex gap-2">
          <input aria-label={P.message} value={text} onChange={(e) => setText(e.target.value)} autoComplete="off" spellCheck={false}
            placeholder={task.current?.report ? P.askPlaceholder : P.linkPlaceholder}
            className="min-w-0 flex-1 rounded-xl border border-line-strong bg-canvas px-3 py-2 font-mono text-[13px] outline-none focus:border-accent" />
          <button type="submit" className={btnPrimary}>{task.current?.report ? P.send : P.check}</button>
        </div>
      </form>
    </div>
  );
}
