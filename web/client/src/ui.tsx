import { CircleAlert, CircleCheck, CircleHelp, Monitor, Moon, ShieldCheck, Sun, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import type { PublicVerdict } from '../../agent/report-types.ts';
import { T } from './text.ts';
import { BUILD, releasePage } from './version.ts';
import { setTheme, useTheme, type Theme } from './theme.ts';

export function ThemeSwitch() {
  const theme = useTheme();
  const options: Array<[Theme, string, typeof Sun]> = [['system', T.theme.system, Monitor], ['light', T.theme.light, Sun], ['dark', T.theme.dark, Moon]];
  return (
    <div role="group" aria-label={T.theme.label} className="inline-flex gap-0.5 rounded-xl bg-sunken p-[3px]">
      {options.map(([value, label, Icon]) => (
        <button
          key={value} type="button" aria-pressed={theme === value} aria-label={label} title={label} onClick={() => setTheme(value)}
          className={`inline-flex size-8 items-center justify-center rounded-lg ${theme === value ? 'bg-surface text-fg shadow-sm' : 'text-muted hover:text-fg'}`}
        >
          <Icon className="size-4" aria-hidden />
        </button>
      ))}
    </div>
  );
}

export function SiteHeader({ children }: { children?: ReactNode }) {
  return (
    <header className="border-b border-line bg-surface">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
        <Link to="/" className="flex items-center gap-2.5 text-fg no-underline">
          <ShieldCheck className="size-7 text-accent" aria-hidden />
          <span className="text-lg font-bold tracking-tight">{T.brand}</span>
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          {children}
          <ThemeSwitch />
        </div>
      </div>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="mx-auto flex max-w-6xl flex-wrap justify-between gap-3 px-4 py-6 text-[13px] text-faint sm:px-6">
      <span>{T.footerLeft} · <a href={releasePage()} className="text-faint" title={T.versionTitle}>ZeroStress {BUILD}</a> · <a href="/privacy" className="text-faint">{T.privacy}</a> · <a href="/terms" className="text-faint">{T.terms}</a></span>
      <span>{T.footerRight}</span>
    </footer>
  );
}

export function Page({ header, children }: { header?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-canvas text-fg">
      <SiteHeader>{header}</SiteHeader>
      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-5 px-4 pt-7 pb-12 sm:px-6">{children}</main>
      <SiteFooter />
    </div>
  );
}

export function Card({ title, children, className = '', titleId }: { title?: ReactNode; children: ReactNode; className?: string; titleId?: string }) {
  return (
    <section aria-labelledby={title ? titleId : undefined} className={`rounded-2xl border border-line bg-surface p-5 sm:p-6 ${className}`}>
      {title && <h2 id={titleId} className="mb-3 text-lg font-bold">{title}</h2>}
      {children}
    </section>
  );
}

export const VERDICT_STYLE: Record<PublicVerdict, { text: string; tile: string; border: string; Icon: typeof TriangleAlert }> = {
  malicious: { text: 'text-danger', tile: 'bg-danger-soft text-danger', border: 'border-danger-line', Icon: TriangleAlert },
  suspicious: { text: 'text-warn', tile: 'bg-warn-soft text-warn', border: 'border-warn-line', Icon: CircleAlert },
  benign: { text: 'text-ok', tile: 'bg-ok-soft text-ok', border: 'border-ok-line', Icon: CircleCheck },
  unknown: { text: 'text-fg', tile: 'bg-sunken text-muted', border: 'border-line-strong', Icon: CircleHelp },
};

const LEVEL_PILL: Readonly<Record<string, string>> = {
  high: 'bg-danger-soft text-danger',
  medium: 'bg-warn-soft text-warn',
  low: 'bg-sunken text-muted',
  info: 'bg-sunken text-muted',
};

/** A level written out in words, never only as a colour. */
export function LevelPill({ level, children }: { level: string; children: ReactNode }) {
  return <span className={`inline-flex h-6.5 flex-none items-center rounded-full px-2.5 text-[13px] font-bold ${LEVEL_PILL[level] ?? LEVEL_PILL.info}`}>{children}</span>;
}

export function Notice({ children }: { children: ReactNode }) {
  return <p className="rounded-xl border border-warn-line bg-warn-soft px-4 py-3 text-[15px] text-fg">{children}</p>;
}

export const Facts = ({ children }: { children: ReactNode }) => <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2">{children}</dl>;

export function Fact({ term, children, mono = false }: { term: string; children: ReactNode; mono?: boolean }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <dt className="text-[13px] text-faint">{term}</dt>
      <dd className={`text-[15px] [overflow-wrap:anywhere] ${mono ? 'font-mono font-medium' : ''}`}>{children}</dd>
    </div>
  );
}

export const TableWrap = ({ children }: { children: ReactNode }) => <div className="-mx-1 overflow-x-auto px-1"><table className="w-full border-collapse text-left text-[15px]">{children}</table></div>;
export const Th = ({ children }: { children: ReactNode }) => <th scope="col" className="border-b border-line px-3 py-2 text-[13px] font-semibold whitespace-nowrap text-faint">{children}</th>;
export const Td = ({ children, mono = false, nowrap = false }: { children: ReactNode; mono?: boolean; nowrap?: boolean }) =>
  <td className={`border-b border-line px-3 py-2.5 align-top ${nowrap ? 'whitespace-nowrap' : '[overflow-wrap:anywhere]'} ${mono ? 'font-mono text-sm' : ''}`}>{children}</td>;

export const btnPrimary = 'inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-accent px-4 font-semibold text-on-accent hover:bg-accent-hover disabled:opacity-60';
export const btnSecondary = 'inline-flex h-11 items-center justify-center gap-2 rounded-xl border border-line-strong bg-surface px-4 font-medium text-fg hover:bg-sunken disabled:opacity-60';
