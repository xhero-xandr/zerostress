// An email's links in its report: each one the agent opened in the same microVM, where it led, and what it was judged.
import type { PublicReport } from '../../agent/report-types.ts';
import { ShotViewer } from './shot-viewer.tsx';
import { T } from './text.ts';
import { Card, LevelPill } from './ui.tsx';

const LEVEL: Record<string, string> = { malicious: 'high', suspicious: 'medium', unknown: 'info', benign: 'low' };
const M = T.mail;

export function EmailLinks({ r, id, compact = false }: { r: PublicReport; id: string; compact?: boolean }) {
  const links = r.email?.links ?? [];
  if (links.length === 0) return null;
  const list = (
    <ol className="flex flex-col gap-2.5">
      {links.map((l, i) => {
        const shot = `/r/${id}/screenshot.png?link=${i}`;
        const notes = [l.password && M.passwordForm, l.downloads > 0 && M.downloads(l.downloads), l.redirects > 0 && M.redirectsN(l.redirects)].filter(Boolean) as string[];
        return (
          <li key={i} className="flex flex-wrap items-start gap-3 rounded-xl border border-line bg-surface p-3">
            <div className="flex min-w-0 flex-[999_1_280px] flex-col gap-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold text-muted">{i + 1}.</span>
                <LevelPill level={LEVEL[l.verdict] ?? 'info'}>{T.verdict[l.verdict]}</LevelPill>
              </div>
              <span className="font-mono text-xs text-faint [overflow-wrap:anywhere]">{l.url.length > 120 ? `${l.url.slice(0, 120)}…` : l.url}</span>
              <span className="text-sm [overflow-wrap:anywhere]">
                {l.error === 'not_reached' ? M.notReached : l.error ? M.notOpened : <>{M.leadsTo} <span className="font-mono font-semibold">{l.final_host || '—'}</span></>}
              </span>
              {notes.length > 0 && <span className={`text-sm ${l.password ? 'font-semibold text-danger' : 'text-muted'}`}>{notes.join(' · ')}</span>}
            </div>
            {l.shot && !compact && (
              <ShotViewer src={shot} alt={M.shotOf(i + 1)} className="block w-40 flex-none">
                <img src={shot} alt={M.shotOf(i + 1)} loading="lazy" className="h-24 w-40 rounded-md border border-line object-cover object-top" />
              </ShotViewer>
            )}
          </li>
        );
      })}
    </ol>
  );
  if (compact) return list;
  return (
    <Card title={M.linksTitle} titleId="email-links">
      <p className="mb-3 text-muted">{M.linksIntro(links.length)}</p>
      {list}
    </Card>
  );
}
