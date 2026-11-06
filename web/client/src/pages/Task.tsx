import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { ApiError, getStatus, type TaskStatus } from '../api.ts';
import { isTaskId } from '../logic.ts';
import { T } from '../text.ts';
import { btnPrimary, Card, Page } from '../ui.tsx';
import { Report, TABS, type Tab } from './Report.tsx';

export function Message({ title, text }: { title: string; text: string }) {
  return (
    <Page>
      <Card className="mx-auto mt-6 flex w-full max-w-xl flex-col items-center gap-3 text-center">
        <h1 className="text-2xl font-bold">{title}</h1>
        <p className="text-muted">{text}</p>
        <Link to="/" className={`${btnPrimary} mt-2 no-underline`}>{T.another}</Link>
      </Card>
    </Page>
  );
}

export const NotFound = () => <Message title={T.notFoundTitle} text={T.notFoundText} />;

/** The steps while the check runs, live from the server's stream; when it ends, the status is asked again. */
function Progress({ status }: { status: TaskStatus }) {
  const qc = useQueryClient();
  const [live, setLive] = useState({ label: status.label, at: status.at });
  useEffect(() => {
    const es = new EventSource(`/api/tasks/${status.id}/events`);
    es.addEventListener('stage', (e) => {
      try {
        const d = JSON.parse((e as MessageEvent<string>).data) as { label?: unknown; at?: unknown };
        setLive((cur) => ({ label: typeof d.label === 'string' ? d.label : cur.label, at: typeof d.at === 'number' ? d.at : cur.at }));
      } catch { /* not ours */ }
    });
    es.addEventListener('final', () => {
      es.close();
      void qc.invalidateQueries({ queryKey: ['status', status.id] });
    });
    return () => es.close();
  }, [status.id, qc]);

  return (
    <Page>
      <Card className="mx-auto mt-6 flex w-full max-w-2xl flex-col gap-5">
        <div className="flex flex-col gap-1">
          <p className="text-sm text-faint">{T.progressTitle}</p>
          <h1 className="font-mono text-xl font-semibold [overflow-wrap:anywhere]">{status.host}</h1>
        </div>
        <ol aria-label={T.progressTitle} className="flex flex-col gap-3">
          {T.steps.map((s, i) => {
            const state = i < live.at ? 'done' : i === live.at ? 'now' : 'next';
            return (
              <li key={s} className="flex items-center gap-3" aria-current={state === 'now' ? 'step' : undefined}>
                <span aria-hidden className={`size-3 flex-none rounded-full ${state === 'done' ? 'bg-accent' : state === 'now' ? 'animate-pulse bg-accent ring-4 ring-accent/20' : 'bg-line-strong'}`} />
                <span className={state === 'next' ? 'text-faint' : state === 'now' ? 'font-semibold' : 'text-muted'}>{s}</span>
              </li>
            );
          })}
        </ol>
        <p aria-live="polite" className="text-[15px] text-muted">{live.label}</p>
      </Card>
    </Page>
  );
}

export function Task() {
  const { id, tab = 'summary' } = useParams();
  const status = useQuery({
    queryKey: ['status', id],
    queryFn: () => getStatus(id!),
    enabled: isTaskId(id),
    retry: (n, e) => !(e instanceof ApiError && e.status === 404) && n < 2,
  });
  if (!isTaskId(id) || !(TABS as readonly string[]).includes(tab)) return <NotFound />;
  if (status.isPending) return <Page><p className="sr-only" role="status">Loading…</p></Page>;
  if (status.isError) return status.error instanceof ApiError && status.error.status === 404 ? <NotFound /> : <Message title={T.failedTitle} text={T.loadFailed} />;
  const s = status.data;
  if (s.has_report) return <Report status={s} tab={tab as Tab} />;
  if (s.stage === 'failed') return <Message title={T.failedTitle} text={T.failedText} />;
  return <Progress status={s} />;
}
