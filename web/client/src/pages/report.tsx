import { useQuery } from '@tanstack/react-query';
import { ChevronDown, Copy, FileJson, Link2, MessageCircle } from 'lucide-react';
import { DropdownMenu } from 'radix-ui';
import { useRef, useState } from 'react';
import { NavLink, useLocation } from 'react-router';
import { getReport, reportJsonUrl, type TaskStatus } from '../api.ts';
import { fmtTime } from '../logic.ts';
import { T } from '../text.ts';
import { btnPrimary, btnSecondary, Notice, Page } from '../ui.tsx';
import { Explain } from './explain.tsx';
import { Behavior, Links, Network, Security, Summary } from './tabs.tsx';
import { Message } from './task.tsx';

export const TABS = ['summary', 'security', 'network', 'links', 'behavior'] as const;
export type Tab = (typeof TABS)[number];

function CopyButton({ text, label, icon }: { text: () => string; label: string; icon: 'copy' | 'link' }) {
  const [done, setDone] = useState(false);
  const Icon = icon === 'copy' ? Copy : Link2;
  const copy = () => {
    void navigator.clipboard?.writeText(text()).then(() => { setDone(true); setTimeout(() => setDone(false), 1600); }, () => {});
  };
  return icon === 'copy' ? (
    <button type="button" onClick={copy} aria-label={done ? T.copied : label} title={done ? T.copied : label}
      className="inline-flex size-9 flex-none items-center justify-center rounded-lg border border-line bg-surface text-muted hover:text-fg">
      <Icon className="size-4" aria-hidden />
    </button>
  ) : (
    <button type="button" onClick={copy} className={btnSecondary}><Icon className="size-4" aria-hidden /> {done ? T.copied : label}</button>
  );
}

export function Report({ status, tab }: { status: TaskStatus; tab: Tab }) {
  const report = useQuery({ queryKey: ['report', status.id], queryFn: () => getReport(status.id), staleTime: Infinity });
  const explain = useRef<{ open: () => void }>(null);
  // the task key lives in the fragment (#k=...): every link between the sections carries it along
  const { hash } = useLocation();
  if (report.isPending) return <Page><p className="sr-only" role="status">Loading…</p></Page>;
  if (report.isError) return <Message title={T.failedTitle} text={T.loadFailed} />;
  const r = report.data;
  const base = `/r/${status.id}`;

  return (
    <Page header={<NavLink to="/" className={`${btnSecondary} h-10 no-underline`}>{T.newCheck}</NavLink>}>
      <section aria-label={T.checkedAddress} className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex min-w-0 flex-[999_1_520px] flex-col gap-2">
          <span className="text-[13px] font-semibold tracking-wider text-faint uppercase">{T.checkedAddress}</span>
          <div className="flex min-w-0 items-center gap-2">
            {/* the checked address is text, never a link (spec 007, 3.5) */}
            <span className="min-w-0 font-mono text-lg font-medium [overflow-wrap:anywhere]">{r.url}</span>
            <CopyButton text={() => r.url} label={T.copyAddress} icon="copy" />
          </div>
          <span className="text-sm text-muted">{T.checkedAt(fmtTime(status.checked_at))}</span>
        </div>
        <div className="flex min-w-0 flex-wrap gap-2.5 sm:flex-none sm:justify-end">
          <button type="button" onClick={() => explain.current?.open()} className={btnPrimary}>
            <MessageCircle className="size-[18px]" aria-hidden /> {T.chat.open}
          </button>
          <DropdownMenu.Root modal={false}>
            <DropdownMenu.Trigger className={btnSecondary}>{T.download} <ChevronDown className="size-4" aria-hidden /></DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content align="end" sideOffset={6} className="z-10 min-w-52 rounded-xl border border-line bg-surface p-1.5 text-fg shadow-lg">
                <DropdownMenu.Item asChild>
                  <a href={reportJsonUrl(status.id)} download={`report-${status.id.slice(0, 8)}.json`}
                    className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-[15px] text-fg no-underline outline-none data-highlighted:bg-sunken">
                    <FileJson className="size-4 text-faint" aria-hidden /> {T.downloadJson}
                  </a>
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
          <CopyButton text={() => location.origin + location.pathname} label={T.copyLink} icon="link" />
        </div>
      </section>

      {r.injection_attempt && tab !== 'security' && <Notice>{T.injection}</Notice>}

      <nav aria-label={T.tabsLabel} className="flex gap-1 overflow-x-auto border-b border-line">
        {TABS.map((t) => (
          <NavLink key={t} to={{ pathname: t === 'summary' ? base : `${base}/${t}`, hash }} end
            className={({ isActive }) => `border-b-2 px-3.5 py-3 whitespace-nowrap no-underline ${isActive ? 'border-accent font-semibold text-fg' : 'border-transparent text-muted hover:text-fg'}`}>
            {T.tabs[t]}
          </NavLink>
        ))}
      </nav>

      {tab === 'summary' && <Summary r={r} status={status} />}
      {tab === 'security' && <Security r={r} />}
      {tab === 'network' && <Network r={r} />}
      {tab === 'links' && <Links r={r} />}
      {tab === 'behavior' && <Behavior r={r} />}

      <p className="text-[13px] text-faint">{T.verdictNotGuarantee}</p>
      <Explain ref={explain} id={status.id} hasShot={status.shots.desktop} />
    </Page>
  );
}
