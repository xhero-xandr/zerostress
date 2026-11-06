// Explain and questions (spec 011) in the browser's own modal dialog: no injected styles, so the production CSP holds
// (spec 012, 6.3). Answers are shown as text only. The first open shows the screenshot and asks for the explanation.
import { MessageCircle, X } from 'lucide-react';
import { useImperativeHandle, useRef, useState, type Ref } from 'react';
import { ApiError, askChat, shotUrl } from '../api.ts';
import { T } from '../text.ts';

interface Msg { who: 'me' | 'bot'; text: string; source?: 'model' | 'rules'; note?: string | null; shot?: boolean; wait?: boolean }

export function Explain({ ref, id, hasShot }: { ref: Ref<{ open: () => void }>; id: string; hasShot: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const started = useRef(false);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [busy, setBusy] = useState(false);
  const [question, setQuestion] = useState('');

  const ask = async (payload: { kind: 'explain' } | { kind: 'ask'; message: string }, shown: string) => {
    setBusy(true);
    setMsgs((m) => [...m, { who: 'me', text: shown }, { who: 'bot', text: T.chat.thinking, wait: true }]);
    let reply: Msg;
    try {
      const a = await askChat(id, payload);
      reply = { who: 'bot', text: a.text, source: a.source, note: a.note };
    } catch (e) {
      reply = { who: 'bot', text: e instanceof ApiError ? e.message : T.chat.failed };
    }
    setMsgs((m) => [...m.slice(0, -1), reply]);
    setBusy(false);
    requestAnimationFrame(() => log.current?.scrollTo({ top: log.current.scrollHeight }));
  };

  useImperativeHandle(ref, () => ({
    open() {
      dialog.current?.showModal();
      if (!started.current) {
        started.current = true;
        // like a person attaching what they are looking at: the screenshot first, then the request
        if (hasShot) setMsgs([{ who: 'me', text: '', shot: true }]);
        void ask({ kind: 'explain' }, T.chat.explainAsk);
      }
      input.current?.focus();
    },
  }));

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const q = question.trim();
    if (!q || busy) return;
    setQuestion('');
    void ask({ kind: 'ask', message: q }, q);
  };

  return (
    <dialog ref={dialog} aria-labelledby="explain-title" className="m-auto w-[min(640px,calc(100vw-24px))] rounded-2xl border border-line bg-surface p-0 text-fg shadow-2xl backdrop:bg-slate-950/60">
      <div className="flex max-h-[min(720px,calc(100vh-48px))] flex-col gap-4 p-5 sm:p-6">
        <div className="flex items-start justify-between gap-4">
          <h2 id="explain-title" className="flex items-center gap-2 text-lg font-bold"><MessageCircle className="size-5 text-accent" aria-hidden /> {T.chat.title}</h2>
          <button type="button" aria-label={T.chat.close} onClick={() => dialog.current?.close()} className="inline-flex size-9 items-center justify-center rounded-lg text-muted hover:bg-sunken hover:text-fg"><X className="size-5" aria-hidden /></button>
        </div>
        <div ref={log} role="log" aria-live="polite" className="flex min-h-40 flex-col gap-3 overflow-y-auto">
          {msgs.map((m, i) => (
            <div key={i} className={`flex flex-col gap-1 ${m.who === 'me' ? 'items-end' : 'items-start'}`}>
              {m.shot ? (
                <img src={shotUrl(id, 'desktop')} alt={T.screenshotAlt(T.device.desktop!)} className="w-60 rounded-xl border border-line" />
              ) : (
                <p className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-[15px] leading-relaxed whitespace-pre-line [overflow-wrap:anywhere] ${m.who === 'me' ? 'bg-accent text-on-accent' : 'bg-sunken'} ${m.wait ? 'animate-pulse text-muted' : ''}`}>{m.text}</p>
              )}
              {m.source && <small className="text-[12px] text-faint">{m.source === 'model' ? T.chat.fromModel : T.chat.fromRules}</small>}
              {m.note && <small className="text-[12px] text-faint">{m.note}</small>}
            </div>
          ))}
        </div>
        <form className="flex gap-2.5" onSubmit={submit} autoComplete="off">
          <label htmlFor="chat-q" className="sr-only">{T.chat.placeholder}</label>
          <input ref={input} id="chat-q" value={question} onChange={(e) => setQuestion(e.target.value)} maxLength={300} placeholder={T.chat.placeholder}
            className="h-11 min-w-0 flex-1 rounded-xl border border-line-strong bg-surface px-3.5 text-fg outline-none placeholder:text-faint focus:border-accent focus:ring-2 focus:ring-accent/25" />
          <button type="submit" disabled={busy} className="h-11 rounded-xl bg-accent px-4 font-semibold text-on-accent hover:bg-accent-hover disabled:opacity-60">{T.chat.send}</button>
        </form>
        <p className="text-[13px] text-faint">{T.chat.note}</p>
      </div>
    </dialog>
  );
}
