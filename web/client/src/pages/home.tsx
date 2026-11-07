import { useQuery } from '@tanstack/react-query';
import { Copy, Download, Monitor, PanelRight, ScanSearch, ShieldHalf } from 'lucide-react';
import { useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { ApiError, getDemos, startTask } from '../api.ts';
import { isTaskId, linkFromQuery, linksFromEmail, type EmailLink } from '../logic.ts';
import { T } from '../text.ts';
import { btnPrimary, SiteFooter, SiteHeader } from '../ui.tsx';

export function Home() {
  const navigate = useNavigate();
  const input = useRef<HTMLInputElement>(null);
  // "/?u=<link>" (the browser extension, a bookmark) fills the field; the person still presses the button
  const given = linkFromQuery(useLocation().search);
  const [url, setUrl] = useState(given);
  const [mode, setMode] = useState<'link' | 'email'>('link');
  const [email, setEmail] = useState('');
  const [links, setLinks] = useState<EmailLink[] | null>(null);
  const [deep, setDeep] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const demos = useQuery({ queryKey: ['demos'], queryFn: getDemos, staleTime: Infinity });

  const start = async (target: string) => {
    setError('');
    setBusy(true);
    try {
      const { id, key } = await startTask(target, deep);
      if (!isTaskId(id) || !/^[A-Za-z0-9_-]{20,100}$/.test(key)) throw new ApiError(500, 'server', T.serverError);
      navigate({ pathname: `/r/${id}`, hash: `k=${key}` });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : T.serverError);
      setBusy(false);
    }
  };
  const submit = (e: React.FormEvent) => { e.preventDefault(); void start(url); };

  return (
    <div className="flex min-h-screen flex-col bg-canvas text-fg">
      <SiteHeader>
        <nav aria-label="Main" className="hidden gap-6 text-[15px] sm:flex">
          <a href="#how" className="text-muted no-underline hover:text-fg">How it works</a>
          <a href="#sandbox" className="text-muted no-underline hover:text-fg">The sandbox</a>
          <a href="#extension" className="text-muted no-underline hover:text-fg">{T.ext.nav}</a>
          <a href="https://github.com/xhero-xandr/zerostress" className="text-muted no-underline hover:text-fg">{T.github}</a>
        </nav>
      </SiteHeader>
      <main className="flex-1">
        <section aria-labelledby="hero" className="mx-auto flex max-w-6xl flex-col items-center gap-5 px-4 pt-14 pb-12 text-center sm:px-6 sm:pt-20">
          <span className="inline-flex items-center gap-2 rounded-full bg-accent-soft px-3 py-1.5 text-sm font-medium text-accent-ink">
            <Monitor className="size-4" aria-hidden /> {T.heroBadge}
          </span>
          <h1 id="hero" className="max-w-3xl text-4xl font-extrabold tracking-tight sm:text-5xl">{T.heroTitle}</h1>
          <p className="max-w-2xl text-lg leading-relaxed text-muted">{T.heroText}</p>

          <div role="tablist" aria-label={T.modeLabel} className="mt-3 inline-flex rounded-xl border border-line bg-surface p-1">
            {(['link', 'email'] as const).map((m) => (
              <button key={m} type="button" role="tab" aria-selected={mode === m} onClick={() => { setMode(m); setError(''); }}
                className={`h-9 rounded-lg px-4 text-[15px] ${mode === m ? 'bg-accent text-white' : 'text-muted hover:text-fg'}`}>
                {m === 'link' ? T.modeLink : T.modeEmail}
              </button>
            ))}
          </div>

          {mode === 'email' && (
            <div className="flex w-full max-w-3xl flex-col gap-2.5 text-left">
              <label htmlFor="email" className="text-sm font-semibold text-muted">{T.emailLabel}</label>
              <textarea id="email" value={email} onChange={(e) => { setEmail(e.target.value); setLinks(null); }} rows={8} maxLength={300_000}
                spellCheck={false} placeholder={T.emailPlaceholder}
                className="min-h-40 w-full rounded-xl border border-line-strong bg-surface p-4 font-mono text-sm text-fg outline-none placeholder:text-faint focus:border-accent focus:ring-2 focus:ring-accent/25" />
              <p className="text-sm text-faint">{T.emailPrivacy}</p>
              <button type="button" className={`${btnPrimary} self-start`} disabled={!email.trim()} onClick={() => setLinks(linksFromEmail(email))}>{T.emailFind}</button>
              {links !== null && (links.length === 0 ? <p className="text-muted">{T.emailNone}</p> : (
                <div className="flex flex-col gap-2">
                  <p className="text-[15px] text-muted">{T.emailFound(links.length)}</p>
                  <ul aria-label={T.emailFound(links.length)} className="flex flex-col gap-2">
                    {links.map((l) => (
                      <li key={l.url} className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-surface p-3">
                        <div className="flex min-w-0 flex-[999_1_320px] flex-col gap-1">
                          <span className="font-mono text-[15px] font-semibold [overflow-wrap:anywhere]">{l.host}</span>
                          <span className="font-mono text-xs text-faint [overflow-wrap:anywhere]">{l.url.length > 140 ? `${l.url.slice(0, 140)}…` : l.url}</span>
                          {l.shown && <span className="text-sm text-danger">{T.emailShown(l.shown)}</span>}
                          {l.wrapper && <span className="text-sm text-muted">{T.emailWrapped(l.wrapper)}</span>}
                        </div>
                        <button type="button" className={`${btnPrimary} flex-[1_1_auto]`} disabled={busy} onClick={() => void start(l.url)}>{busy ? T.checking : T.emailCheck}</button>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
              <label className="flex items-start gap-2.5 text-[15px]">
                <input type="checkbox" checked={deep} onChange={(e) => setDeep(e.target.checked)} className="mt-1 size-4 accent-[var(--zs-accent)]" />
                <span><span className="font-semibold">{T.deepLabel}</span><br /><span className="text-sm text-faint">{T.deepHint}</span></span>
              </label>
              {error && <p role="alert" className="rounded-xl border border-danger-line bg-danger-soft px-4 py-2.5 text-[15px] text-danger">{error}</p>}
            </div>
          )}

          {mode === 'link' && <form className="flex w-full max-w-3xl flex-col gap-2.5 text-left" onSubmit={submit} noValidate>
            <label htmlFor="url" className="text-sm font-semibold text-muted">{T.inputLabel}</label>
            <div className="flex flex-wrap gap-2.5">
              <input
                ref={input} id="url" name="url" type="text" inputMode="url" autoComplete="off" autoCapitalize="off" spellCheck={false}
                maxLength={2048} required placeholder={T.inputPlaceholder} value={url} onChange={(e) => setUrl(e.target.value)}
                aria-invalid={error !== '' || undefined} aria-describedby={error ? 'url-error' : undefined}
                className="h-13 min-w-0 flex-[999_1_420px] rounded-xl border border-line-strong bg-surface px-4 font-mono text-base text-fg outline-none placeholder:text-faint focus:border-accent focus:ring-2 focus:ring-accent/25"
              />
              <button type="submit" disabled={busy} className={`${btnPrimary} h-13 flex-[1_1_160px] px-6`}>
                <ScanSearch className="size-5" aria-hidden /> {busy ? T.checking : T.check}
              </button>
            </div>
            <label className="flex items-start gap-2.5 text-[15px]">
              <input type="checkbox" checked={deep} onChange={(e) => setDeep(e.target.checked)} className="mt-1 size-4 accent-[var(--zs-accent)]" />
              <span><span className="font-semibold">{T.deepLabel}</span><br /><span className="text-sm text-faint">{T.deepHint}</span></span>
            </label>
            {error && <p id="url-error" role="alert" className="rounded-xl border border-danger-line bg-danger-soft px-4 py-2.5 text-[15px] text-danger">{error}</p>}
          </form>}

          {mode === 'link' && (demos.data?.demos.length ?? 0) > 0 && (
            <div className="flex flex-wrap items-center justify-center gap-2">
              <span className="text-sm text-faint">{T.tryTitle}</span>
              {demos.data!.demos.map((d) => (
                <button key={d.url} type="button" onClick={() => { setUrl(d.url); input.current?.focus(); }}
                  className="h-9 rounded-full border border-line bg-surface px-3.5 text-sm text-muted hover:border-line-strong hover:text-fg">
                  {d.label}
                </button>
              ))}
            </div>
          )}
        </section>

        <section id="how" aria-labelledby="how-title" className="mx-auto max-w-6xl px-4 pb-14 sm:px-6">
          <h2 id="how-title" className="mb-6 text-2xl font-bold tracking-tight">{T.howTitle}</h2>
          <ol className="grid gap-4 sm:grid-cols-3">
            {T.how.map(([title, text], i) => (
              <li key={title} className="flex flex-col gap-2.5 rounded-2xl border border-line bg-surface p-6">
                <span className="flex size-9 items-center justify-center rounded-xl bg-accent-soft font-bold text-accent-ink" aria-hidden>{i + 1}</span>
                <h3 className="text-[17px] font-semibold">{title}</h3>
                <p className="text-[15px] leading-relaxed text-muted">{text}</p>
              </li>
            ))}
          </ol>
        </section>

        <ExtensionSection />

        <section id="sandbox" aria-labelledby="sandbox-title" className="bg-band text-band-fg">
          <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-12 sm:px-6">
            <h2 id="sandbox-title" className="flex items-center gap-2.5 text-2xl font-bold">
              <ShieldHalf className="size-6 text-accent" aria-hidden /> {T.assureTitle}
            </h2>
            <ul className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
              {T.assure.map(([title, text]) => (
                <li key={title} className="flex flex-col gap-1.5">
                  <span className="text-[15px] font-semibold">{title}</span>
                  <span className="text-sm leading-relaxed text-band-muted">{text}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}

export const EXTENSION_ZIP = 'https://github.com/xhero-xandr/zerostress/releases/latest/download/zerostress-extension.zip';

/** Where to get the browser agent and how to install it (an unpacked extension until the Chrome Web Store has it). */
function ExtensionSection() {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(T.ext.address).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }, () => {});
  };
  return (
    <section id="extension" aria-labelledby="extension-title" className="mx-auto max-w-6xl px-4 pb-14 sm:px-6">
      <div className="grid gap-6 rounded-2xl border border-line bg-surface p-6 sm:p-8 lg:grid-cols-2">
        <div className="flex flex-col gap-3">
          <h2 id="extension-title" className="flex items-center gap-2.5 text-2xl font-bold tracking-tight">
            <PanelRight className="size-6 text-accent" aria-hidden /> {T.ext.title}
          </h2>
          <p className="text-[15px] leading-relaxed text-muted">{T.ext.text}</p>
          <a href={EXTENSION_ZIP} className={`${btnPrimary} self-start no-underline`}>
            <Download className="size-5" aria-hidden /> {T.ext.download}
          </a>
          <p className="text-sm text-faint">{T.ext.browsers}</p>
        </div>
        <div className="flex flex-col gap-3">
          <h3 className="text-[17px] font-semibold">{T.ext.stepsTitle}</h3>
          <ol className="flex flex-col gap-2.5">
            {T.ext.steps.map((s, i) => (
              <li key={s} className="flex gap-3 text-[15px]">
                <span className="flex size-7 flex-none items-center justify-center rounded-lg bg-accent-soft text-sm font-bold text-accent-ink" aria-hidden>{i + 1}</span>
                <span className="pt-0.5">{s}</span>
              </li>
            ))}
          </ol>
          <div className="flex items-center gap-2 self-start rounded-xl border border-line-strong bg-canvas px-3 py-2">
            <code className="font-mono text-[15px]">{T.ext.address}</code>
            <button type="button" onClick={copy} className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-sm text-muted hover:text-fg">
              <Copy className="size-4" aria-hidden /> {copied ? T.ext.copied : T.ext.copy}
            </button>
          </div>
          <p className="text-sm text-faint">{T.ext.later}</p>
        </div>
      </div>
    </section>
  );
}
