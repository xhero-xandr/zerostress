// A second opinion from Cloudflare's URL Scanner on a page our sandbox could not read (a bot wall). Only the owner (the
// key after "#k=") can ask; anyone with the report sees the answer. Every text in the answer came from a page: text only.
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useLocation } from 'react-router';
import type { PublicReport } from '../../../agent/report-types.ts';
import { ApiError, askSecondOpinion, secondOpinionShotUrl, type SecondOpinion as Opinion } from '../api.ts';
import { fmtTime, keyFromHash } from '../logic.ts';
import { ShotViewer } from '../shot-viewer.tsx';
import { T } from '../text.ts';
import { btnPrimary, Card, Fact, Facts, LevelPill, Notice } from '../ui.tsx';

export function SecondOpinion({ r, id }: { r: PublicReport; id: string }) {
  const key = keyFromHash(useLocation().hash);
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [got, setGot] = useState<Opinion | null>(null);
  const so = got ?? r.second_opinion;
  if (!so && r.second_opinion_state === null) return null;

  // the server asks on its own when the check ends at a wall; this is only for asking again after a failure
  const ask = async () => {
    setBusy(true);
    setError('');
    try {
      const res = await askSecondOpinion(id, key);
      setGot(res.second_opinion);
      void qc.invalidateQueries({ queryKey: ['report', id] });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : T.serverError);
    } finally {
      setBusy(false);
    }
  };
  const asking = busy || r.second_opinion_state === 'asking';

  return (
    <Card title={T.second.title} titleId="second-opinion">
      {!so && (
        <div className="flex flex-col gap-3">
          <p className="text-muted">{T.second.intro}</p>
          {asking && <p role="status" className="text-[15px] text-muted">{T.second.asking}</p>}
          {!asking && r.second_opinion_state === 'failed' && (
            <>
              <p className="text-[15px]">{T.second.failed}</p>
              {key ? <button type="button" className={`${btnPrimary} self-start`} onClick={() => void ask()}>{T.second.ask}</button> : <p className="text-[15px] text-muted">{T.second.ownerOnly}</p>}
            </>
          )}
          {error && <Notice>{error}</Notice>}
        </div>
      )}
      {so && (
        <div className="flex flex-col gap-4">
          <p className="text-muted">{so.source === 'submitted' ? T.second.submitted(fmtTime(Date.parse(so.scanned_at))) : T.second.found(fmtTime(Date.parse(so.scanned_at)))}</p>
          <p>{so.malicious === true ? <LevelPill level="high">{T.second.flagged}</LevelPill> : so.malicious === false ? T.second.notFlagged : T.second.noVerdict}</p>
          <Facts>
            <Fact term={T.second.rows.host} mono>{so.final_host || '—'}</Fact>
            <Fact term={T.second.rows.status}>{so.status ?? '—'}</Fact>
            <Fact term={T.second.rows.title}>{so.title_withheld ? T.second.withheld : so.title || '—'}</Fact>
            <Fact term={T.second.rows.scan} mono>{so.scan_id}</Fact>
          </Facts>
          {so.screenshot && <ShotViewer src={secondOpinionShotUrl(id)} alt={T.second.shotAlt} className="block w-full"><img src={secondOpinionShotUrl(id)} alt={T.second.shotAlt} className="w-full rounded-lg border border-line" loading="lazy" /></ShotViewer>}
        </div>
      )}
    </Card>
  );
}
