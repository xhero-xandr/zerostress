import { useQuery } from '@tanstack/react-query';
import { Copy, Download, Monitor, PanelRight, ShieldHalf } from 'lucide-react';
import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { ApiError, getDemos, startEmailCheck, startTask } from '../api.ts';
import { asLink, isTaskId, linkFromQuery, mailboxOf } from '../logic.ts';
import { CheckBox } from '../check-box.tsx';
import { T } from '../text.ts';
import { extensionZip, RELEASE, releasePage, STORE_URL } from '../version.ts';
import { btnPrimary, SiteFooter, SiteHeader } from '../ui.tsx';

export function Home() {
  const navigate = useNavigate();
  // "/?u=<link>" (the browser extension, a bookmark) fills the field; the person still presses the button
  const given = linkFromQuery(useLocation().search);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const demos = useQuery({ queryKey: ['demos'], queryFn: getDemos, staleTime: Infinity });

  // the whole email in one microVM: only its links are sent, never the email
  const startAll = async (urls: string[]) => {
    setError('');
    setBusy(true);
    try {
      const { id, key } = await startEmailCheck(urls);
      if (!isTaskId(id) || !/^[A-Za-z0-9_-]{20,100}$/.test(key)) throw new ApiError(500, 'server', T.serverError);
      navigate({ pathname: `/r/${id}`, hash: `k=${key}` });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : T.serverError);
      setBusy(false);
    }
  };
  const start = async (typed: string, deep: boolean) => {
    setError('');
    const target = asLink(typed);
    const mailbox = mailboxOf(target);
    if (mailbox) { setError(T.panel.mailbox(mailbox)); return; }
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

          <CheckBox busy={busy} error={error} initial={given} demos={demos.data?.demos ?? []}
            onLink={(u, d) => void start(u, d)} onEmail={(urls) => void startAll(urls)} />
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


/** Where to get the browser agent: the Chrome Web Store listing first, a release .zip (any Chromium browser, or an
 * older version) further down. */
function ExtensionSection() {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(T.ext.address).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }, () => {});
  };
  return (
    <section id="extension" aria-labelledby="extension-title" className="mx-auto max-w-6xl px-4 pb-14 sm:px-6">
      <div className="rounded-2xl border border-line bg-surface p-6 sm:p-8">
        <div className="flex flex-col items-start gap-3">
          <h2 id="extension-title" className="flex items-center gap-2.5 text-2xl font-bold tracking-tight">
            <PanelRight className="size-6 text-accent" aria-hidden /> {T.ext.title}
          </h2>
          <p className="max-w-2xl text-[15px] leading-relaxed text-muted">{T.ext.text}</p>
          <a href={STORE_URL} className={`${btnPrimary} no-underline`}>
            <PanelRight className="size-5" aria-hidden /> {T.ext.store}
          </a>
          <p className="text-sm text-faint">{T.ext.browsers}</p>
        </div>
        <details className="mt-6 border-t border-line pt-5">
          <summary className="cursor-pointer text-[15px] font-medium text-muted hover:text-fg">{T.ext.manualTitle}</summary>
          <div className="mt-4 grid gap-6 lg:grid-cols-2">
            <div className="flex flex-col gap-3">
              <a href={extensionZip()} className="inline-flex w-fit items-center gap-2 rounded-lg border border-line-strong px-4 py-2 text-[15px] font-medium text-fg no-underline hover:bg-canvas">
                <Download className="size-5" aria-hidden /> {T.ext.download(RELEASE)}
              </a>
              <p className="text-sm text-faint"><a href={releasePage()} className="text-faint">{T.ext.notes}</a></p>
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
            </div>
          </div>
        </details>
      </div>
    </section>
  );
}
