import { useQuery } from '@tanstack/react-query';
import { Monitor, ScanSearch, ShieldHalf } from 'lucide-react';
import { useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { ApiError, getDemos, startTask } from '../api.ts';
import { isTaskId } from '../logic.ts';
import { T } from '../text.ts';
import { btnPrimary, SiteFooter, SiteHeader } from '../ui.tsx';

export function Home() {
  const navigate = useNavigate();
  const input = useRef<HTMLInputElement>(null);
  const [url, setUrl] = useState('');
  const [deep, setDeep] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const demos = useQuery({ queryKey: ['demos'], queryFn: getDemos, staleTime: Infinity });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const { id, key } = await startTask(url, deep);
      if (!isTaskId(id) || !/^[A-Za-z0-9_-]{20,100}$/.test(key)) throw new ApiError(500, 'server', T.serverError);
      navigate({ pathname: `/r/${id}`, hash: `k=${key}` });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : T.serverError);
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen flex-col bg-canvas text-fg">
      <SiteHeader>
        <nav aria-label="Main" className="hidden gap-6 text-[15px] sm:flex">
          <a href="#how" className="text-muted no-underline hover:text-fg">How it works</a>
          <a href="#sandbox" className="text-muted no-underline hover:text-fg">The sandbox</a>
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

          <form className="mt-3 flex w-full max-w-3xl flex-col gap-2.5 text-left" onSubmit={submit} noValidate>
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
          </form>

          {(demos.data?.demos.length ?? 0) > 0 && (
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
