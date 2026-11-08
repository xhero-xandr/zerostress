// The agent in the browser's side panel (spec 013): the extension frames this page, so it updates with the site. A
// conversation about one link at a time: the check runs on ZeroStress as from the home page, the agent log shows what
// happens in the microVM, a risky action waits for Allow / Don't allow, then the verdict, its explanation and questions.
// Text from a page or the model is rendered as text by React, never as markup.
import { Paperclip } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { LogEntry } from '../../../agent/agent-log.ts';
import type { PublicReport } from '../../../agent/report-types.ts';
import { ApiError, askChat, askSecondOpinion, decide, getPending, getReport, getStatus, reportJsonUrl, shotUrl, startEmailCheck, startFileCheck, startTask, type Pending, type TaskStatus } from '../api.ts';
import { EXTENSION_ORIGIN } from '../extension.ts';
import { asLink, asLogEntry, headline, isTaskId, linkFromQuery, logLine, logTime, mailboxOf, panelFacts, verdictLine } from '../logic.ts';
import { linksToCheck, looksLikeEmail, readEmail, type EmailCheck } from '../email.ts';
import { EmailFindings } from '../email-card.tsx';
import { EmailLinks } from '../email-links.tsx';
import { FILE_MAX, FileCard, FileRow, sizeText } from '../file-check.tsx';
import { ShotViewer } from '../shot-viewer.tsx';
import { T } from '../text.ts';
import { btnPrimary, btnSecondary } from '../ui.tsx';

type Item =
  | { kind: 'you'; text: string }
  | { kind: 'agent'; text: string }
  | { kind: 'steps'; entries: LogEntry[] }
  | { kind: 'approval'; p: Pending; done: string | null }
  | { kind: 'verdict'; r: PublicReport; id: string; key: string; shots: TaskStatus['shots'] | null }
  | { kind: 'email'; mail: EmailCheck }
  | { kind: 'file'; name: string; mime: string; data: Uint8Array }

const P = T.panel;
const errText = (e: unknown) => (e instanceof ApiError ? e.message : T.serverError);
const webLink = (s: string) => linkFromQuery(`?u=${encodeURIComponent(asLink(s))}`);

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
  // questions typed while the check was still running: answered after its explanation, in order
  const queued = useRef<string[]>([]);

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

  async function finish(id: string, key: string, told = false) {
    let r: PublicReport;
    try { r = await getReport(id); } catch (e) { say(errText(e)); busy.current = false; return; }
    if (task.current?.id === id) task.current.report = true;
    const shots = await getStatus(id).then((st) => st.shots, () => null);
    push({ kind: 'verdict', r, id, key, shots });
    // Cloudflare may have answered about a wall before this report was read (a recent scan is found at once)
    const so = r.second_opinion;
    if (so && !told) say(T.log.second(so.source, so.status, so.malicious, so.final_host));
    busy.current = false;
    const later = queued.current.splice(0);
    const explained = answer(id, { kind: 'explain' });
    for (const q of later) void answer(id, { kind: 'ask', message: q });
    await explained;
    // a wall: the server is already asking Cloudflare on its own; wait for that answer here
    if (r.second_opinion_state === 'asking') await second(id, key);
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

  // the whole email in one microVM: its links only, never the email
  async function checkAll(urls: string[]) {
    if (busy.current) { say(P.oneAtATime); return; }
    queued.current = [];
    push({ kind: 'you', text: T.mail.checkAll(urls.length) });
    task.current?.es?.close();
    busy.current = true;
    try {
      const { id, key } = await startEmailCheck(urls);
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

  // a file: it goes to the sandbox only now, when the person asks; the check is followed here like any other
  async function checkFile(data: Uint8Array, name: string, mime: string) {
    if (busy.current) { say(P.oneAtATime); return; }
    queued.current = [];
    push({ kind: 'you', text: P.openFile(name) });
    task.current?.es?.close();
    busy.current = true;
    try {
      const { id, key } = await startFileCheck(data, name, mime);
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

  // a file dropped, pasted or picked: an email file is read as an email; anything else is offered for the sandbox
  async function takeFile(f: File) {
    if (/\.eml$/i.test(f.name) || f.type === 'message/rfc822') {
      const t = await f.text();
      push({ kind: 'you', text: P.pastedEmail(t.length) });
      push({ kind: 'email', mail: readEmail(t) });
      return;
    }
    if (f.size > FILE_MAX) { push({ kind: 'you', text: f.name }); say(T.file.tooLarge); return; }
    push({ kind: 'you', text: `${f.name} (${sizeText(f.size)})` });
    push({ kind: 'file', name: f.name, mime: f.type, data: new Uint8Array(await f.arrayBuffer()) });
  }
  const picker = useRef<HTMLInputElement>(null);

  async function check(raw: string) {
    if (busy.current) { push({ kind: 'you', text: P.checkThis(raw.trim()) }); say(P.oneAtATime); return; }
    queued.current = [];
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
      push({ kind: 'email', mail: readEmail(t) });
      return;
    }
    if (webLink(t)) { void check(t); return; }
    if (busy.current) {
      push({ kind: 'you', text: t });
      queued.current.push(t.slice(0, 300));
      say(P.afterVerdict);
      return;
    }
    if (!task.current?.report) { void check(t); return; }
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

  async function second(id: string, key: string) {
    const at = say(T.second.asking);
    try {
      const { second_opinion: so } = await askSecondOpinion(id, key);
      update(at, () => ({ kind: 'agent', text: T.log.second(so.source, so.status, so.malicious, so.final_host) }));
      await finish(id, key, true);
    } catch (e) {
      update(at, () => ({ kind: 'agent', text: errText(e) }));
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
              <EmailFindings mail={it.mail} compact onOpenFile={(d, n, m) => void checkFile(d, n, m)} />
              <p className="mt-3">{it.mail.links.length ? P.emailFound(it.mail.links.length) : `${P.emailRead} ${T.mail.noLinks}`}</p>
              {linksToCheck(it.mail.links).length > 1 && <button type="button" className={`${btnPrimary} mt-2`} onClick={() => void checkAll(linksToCheck(it.mail.links))}>{T.mail.checkAll(linksToCheck(it.mail.links).length)}</button>}
              <ul className="mt-2 flex flex-col gap-2">
                {it.mail.links.map((l, j) => (
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
          if (it.kind === 'file') return (
            <div key={i} className={`${bubble} self-start rounded-bl-sm border border-line bg-surface`}>
              <p className="mb-2">{P.fileRead}</p>
              <ul className="flex flex-col gap-2"><FileRow name={it.name} mime={it.mime} data={it.data} onOpen={(d, n, m) => void checkFile(d, n, m)} /></ul>
            </div>
          );
          const r = it.r;
          const serious = r.signals.filter((s) => s.level === 'high' || s.level === 'medium').slice(0, 4);
          return (
            <div key={i} className={`${bubble} self-start rounded-bl-sm border border-line bg-surface`}>
              <p className={`font-bold ${r.verdict === 'malicious' ? 'text-danger' : r.verdict === 'benign' ? 'text-accent' : ''}`}>{P.verdictLead} {headline(r)}</p>
              <p>{verdictLine(r)}</p>
              {serious.length > 0 && <ul className="mt-1.5 list-disc pl-5 text-[13px] text-muted">{serious.map((s) => <li key={s.id}>{s.text}</li>)}</ul>}
              {r.file && <div className="mt-2 text-[13px]"><FileCard r={r} /></div>}
              {r.email && <div className="mt-2 text-[13px]"><p className="mb-1.5 text-faint">{T.mail.linksIntro(r.email.links.length)}</p><EmailLinks r={r} id={it.id} compact /></div>}
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
                {r.second_opinion_state === 'failed' && <button type="button" className={btnPrimary} onClick={() => void second(it.id, it.key)}>{T.second.ask}</button>}
              </div>
            </div>
          );
        })}
        <div ref={end} />
      </main>
      <form onSubmit={submit} onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) void takeFile(f); }}
        className="flex flex-col gap-2 border-t border-line bg-surface px-4 pt-2.5 pb-3.5">
        <input ref={picker} type="file" className="sr-only" tabIndex={-1} aria-hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void takeFile(f); e.target.value = ''; }} />
        <label className="flex items-start gap-2 text-[12.5px] text-muted"><input type="checkbox" checked={deep} onChange={(e) => setDeep(e.target.checked)} className="mt-0.5" /> {P.deep}</label>
        <div className="flex gap-2">
          <button type="button" aria-label={P.addFile} title={P.addFile} onClick={() => picker.current?.click()}
            className="inline-flex size-10 flex-none items-center justify-center self-end rounded-xl border border-line-strong bg-canvas text-muted hover:text-fg">
            <Paperclip className="size-4" aria-hidden />
          </button>
          {/* a textarea, not an input: an input drops the line breaks of a pasted email, and its source needs them */}
          <textarea aria-label={P.message} value={text} onChange={(e) => setText(e.target.value)} autoComplete="off" spellCheck={false}
            onPaste={(e) => { const f = e.clipboardData.files[0]; if (f) { e.preventDefault(); void takeFile(f); } }}
            rows={Math.min(6, Math.max(1, text.split('\n').length))}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); e.currentTarget.form?.requestSubmit(); } }}
            placeholder={task.current?.report ? P.askPlaceholder : P.linkPlaceholder}
            className="min-w-0 flex-1 resize-none rounded-xl border border-line-strong bg-canvas px-3 py-2 font-mono text-[13px] outline-none focus:border-accent" />
          <button type="submit" className={btnPrimary}>{task.current?.report ? P.send : P.check}</button>
        </div>
      </form>
    </div>
  );
}
