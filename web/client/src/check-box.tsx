// One field for whatever looks suspicious: a link, an email (its text or its source), or a file dropped, pasted or
// picked. What it is, is told here, in the browser, by fixed rules, never by a model: an email never leaves the browser,
// and a file leaves it only when the person opens it in the sandbox. The field says what it understood before anything
// is sent, so a wrong guess is seen before the button is pressed.
import { FileUp, ScanSearch } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { linksToCheck, looksLikeEmail, readEmail, type EmailCheck } from './email.ts';
import { EmailFindings } from './email-card.tsx';
import { FILE_MAX, FileRow, sizeText } from './file-check.tsx';
import { asLink, linkFromQuery } from './logic.ts';
import { T } from './text.ts';
import { btnPrimary, btnSecondary } from './ui.tsx';

const C = T.box;

export type Detected =
  | { kind: 'empty' }
  | { kind: 'link'; url: string }
  | { kind: 'email'; mail: EmailCheck }
  /** words without a single address in them: nothing to check */
  | { kind: 'text' };

/** What the text in the field is: one address (bare or full), an email or a message with links, or neither. */
export function detect(text: string): Detected {
  const t = text.trim();
  if (!t) return { kind: 'empty' };
  const one = linkFromQuery(`?u=${encodeURIComponent(asLink(t))}`);
  if (one && !/\s/.test(t)) return { kind: 'link', url: one };
  if (looksLikeEmail(t)) return { kind: 'email', mail: readEmail(t) };
  // one word that is not a web address (another scheme, an internal name): the gate says why it is refused
  if (!/\s/.test(t)) return { kind: 'link', url: asLink(t) };
  const mail = readEmail(t);
  return mail.links.length > 0 ? { kind: 'email', mail } : { kind: 'text' };
}

const isEml = (f: File) => /\.eml$/i.test(f.name) || f.type === 'message/rfc822';

export interface CheckBoxProps {
  busy: boolean;
  error: string;
  /** start the check of one link */
  onLink: (url: string, deep: boolean) => void;
  /** start the check of an email's links, all in one sandbox */
  onEmail: (urls: string[]) => void;
  demos?: ReadonlyArray<{ label: string; url: string; deep?: true }>;
  initial?: string;
}

export function CheckBox({ busy, error, onLink, onEmail, demos = [], initial = '' }: CheckBoxProps) {
  const [text, setText] = useState(initial);
  const [file, setFile] = useState<{ name: string; mime: string; data: Uint8Array } | null>(null);
  const [deep, setDeep] = useState(false);
  const [over, setOver] = useState(false);
  const [note, setNote] = useState('');
  const field = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const found = useMemo(() => detect(text), [text]);

  const take = async (f: File) => {
    setNote('');
    if (isEml(f)) { setFile(null); setText(await f.text()); return; }
    if (f.size > FILE_MAX) { setFile(null); setNote(T.file.tooLarge); return; }
    setText('');
    setFile({ name: f.name, mime: f.type, data: new Uint8Array(await f.arrayBuffer()) });
  };
  const clear = () => { setText(''); setFile(null); setNote(''); field.current?.focus(); };

  const chip = file ? C.isFile(sizeText(file.data.length))
    : found.kind === 'link' ? C.isLink
      : found.kind === 'email' ? C.isEmail(found.mail.links.length, found.mail.attachments.length, found.mail.source)
        : found.kind === 'text' ? C.isText : '';
  const toCheck = found.kind === 'email' ? linksToCheck(found.mail.links) : [];
  const go = () => {
    if (found.kind === 'link') onLink(found.url, deep);
    else if (found.kind === 'email' && toCheck.length > 0) onEmail(toCheck);
  };

  return (
    <div className="flex w-full max-w-3xl flex-col gap-3 text-left">
      <label htmlFor="what" className="text-sm font-semibold text-muted">{C.label}</label>
      <div
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files[0]; if (f) void take(f); }}
        className={`flex flex-col gap-2 rounded-2xl border bg-surface p-3 focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/25 ${over ? 'border-accent ring-2 ring-accent/25' : 'border-line-strong'}`}>
        {file ? (
          <div className="flex min-h-24 items-center gap-3 px-2 py-3">
            <FileUp className="size-6 flex-none text-accent" aria-hidden />
            <span className="min-w-0 flex-1 font-mono text-[15px] font-semibold [overflow-wrap:anywhere]">{file.name}</span>
            <button type="button" onClick={clear} className="text-sm text-muted hover:text-fg">{C.clear}</button>
          </div>
        ) : (
          // a textarea: an input would drop the line breaks of a pasted email, and its source needs them
          <textarea ref={field} id="what" value={text} rows={text.includes('\n') ? 8 : 2} maxLength={300_000} spellCheck={false} autoComplete="off" autoCapitalize="off"
            placeholder={C.placeholder}
            onChange={(e) => { setText(e.target.value); setNote(''); }}
            onPaste={(e) => { const f = e.clipboardData.files[0]; if (f) { e.preventDefault(); void take(f); } }}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && found.kind === 'link') { e.preventDefault(); go(); } }}
            aria-describedby="what-said"
            className="w-full resize-y bg-transparent px-2 py-1.5 font-mono text-base text-fg outline-none placeholder:font-sans placeholder:text-faint" />
        )}
        <div className="flex flex-wrap items-center gap-2 px-1">
          <input ref={picker} type="file" className="sr-only" tabIndex={-1} aria-hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void take(f); e.target.value = ''; }} />
          <button type="button" onClick={() => picker.current?.click()} className={`${btnSecondary} h-9 px-3 text-sm`}>
            <FileUp className="size-4" aria-hidden /> {C.addFile}
          </button>
          <span id="what-said" role="status" className="min-w-0 flex-1 text-sm text-muted">{chip && <><span className="font-semibold text-fg">{C.detected}</span> {chip}</>}</span>
          {!file && (found.kind === 'link' || (found.kind === 'email' && toCheck.length > 0)) && (
            <button type="button" disabled={busy} onClick={go} className={`${btnPrimary} h-11 px-5`}>
              <ScanSearch className="size-5" aria-hidden /> {busy ? T.checking : found.kind === 'link' ? T.check : T.mail.checkAll(toCheck.length)}
            </button>
          )}
        </div>
      </div>

      {found.kind === 'link' && !file && (
        <label className="flex items-start gap-2.5 text-[15px]">
          <input type="checkbox" checked={deep} onChange={(e) => setDeep(e.target.checked)} className="mt-1 size-4 accent-[var(--zs-accent)]" />
          <span><span className="font-semibold">{T.deepLabel}</span><br /><span className="text-sm text-faint">{T.deepHint}</span></span>
        </label>
      )}
      {note && <p role="alert" className="text-[15px] text-danger">{note}</p>}
      {error && <p role="alert" className="rounded-xl border border-danger-line bg-danger-soft px-4 py-2.5 text-[15px] text-danger">{error}</p>}

      {file && <ul className="flex flex-col gap-2"><FileRow name={file.name} mime={file.mime} data={file.data} /></ul>}
      {file && <p className="text-sm text-faint">{T.file.privacy}</p>}

      {found.kind === 'email' && !file && (
        <div className="flex flex-col gap-3">
          <EmailFindings mail={found.mail} />
          {found.mail.links.length > 0 && (
            <div className="flex flex-col gap-2">
              <p className="text-[15px] text-muted">{T.emailFound(found.mail.links.length)}</p>
              <ul aria-label={T.emailFound(found.mail.links.length)} className="flex flex-col gap-2">
                {found.mail.links.map((l) => (
                  <li key={l.url} className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-surface p-3">
                    <div className="flex min-w-0 flex-[999_1_320px] flex-col gap-1">
                      <span className="font-mono text-[15px] font-semibold [overflow-wrap:anywhere]">{l.host}</span>
                      <span className="font-mono text-xs text-faint [overflow-wrap:anywhere]">{l.url.length > 140 ? `${l.url.slice(0, 140)}…` : l.url}</span>
                      {l.shown && <span className="text-sm text-danger">{T.emailShown(l.shown)}</span>}
                      {l.wrapper && <span className="text-sm text-muted">{T.emailWrapped(l.wrapper)}</span>}
                    </div>
                    <button type="button" className={`${btnSecondary} flex-[1_1_auto]`} disabled={busy} onClick={() => onLink(l.url, false)}>{T.emailCheck}</button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <p className="text-sm text-faint">{T.emailPrivacy}</p>
        </div>
      )}
      {found.kind === 'text' && !file && <p className="text-[15px] text-muted">{C.noLinks}</p>}

      {demos.length > 0 && !file && (found.kind === 'empty' || demos.some((d) => d.url === text.trim())) && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-faint">{T.tryTitle}</span>
          {demos.map((d) => (
            <button key={d.url} type="button" onClick={() => { setText(d.url); setDeep(d.deep === true); field.current?.focus(); }}
              className="h-9 rounded-full border border-line bg-surface px-3.5 text-sm text-muted hover:border-line-strong hover:text-fg">
              {d.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
