// A second opinion from Cloudflare's URL Scanner on a page our sandbox could not read (a bot wall). Only the owner (the
// key after "#k=") can ask; anyone with the report sees the answer. Every text in the answer came from a page: text only.
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useLocation } from 'react-router';
import type { PublicReport } from '../../../agent/report-types.ts';
import { ApiError, askSecondOpinion, secondOpinionShotUrl, type SecondOpinion as Opinion } from '../api.ts';
import { fmtTime, keyFromHash } from '../logic.ts';
import { T } from '../text.ts';
import { btnPrimary, btnSecondary, Card, Fact, Facts, LevelPill, Notice } from '../ui.tsx';

export function SecondOpinion({ r, id }: { r: PublicReport; id: string }) {
  const key = keyFromHash(useLocation().hash);
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState('');
  const [got, setGot] = useState<Opinion | null>(null);
  const so = got ?? r.second_opinion;
  if (!so && r.verdict !== 'unknown') return null;

  const ask = async (publish: boolean) => {
    setBusy(true);
    setError('');
    try {
      const res = await askSecondOpinion(id, key, publish);
      setGot(res.second_opinion);
      setConsent(false);
      void qc.invalidateQueries({ queryKey: ['report', id] });
    } catch (e) {
      if (e instanceof ApiError && e.code === 'needs_consent') setConsent(true);
      else setError(e instanceof ApiError ? e.message : T.serverError);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title={T.second.title} titleId="second-opinion">
      {!so && (
        <div className="flex flex-col gap-3">
          <p className="text-muted">{T.second.intro}</p>
          {!key && <p className="text-[15px] text-muted">{T.second.ownerOnly}</p>}
          {key && !consent && <button type="button" className={`${btnPrimary} self-start`} disabled={busy} onClick={() => void ask(false)}>{T.second.ask}</button>}
          {key && consent && (
            <div role="alertdialog" aria-labelledby="consent-title" className="flex flex-col gap-3 rounded-lg border border-line p-4">
              <p id="consent-title" className="font-semibold">{T.second.consentTitle}</p>
              <p className="text-[15px] text-muted">{T.second.consentText}</p>
              <div className="flex flex-wrap gap-2">
                <button type="button" className={btnPrimary} disabled={busy} onClick={() => void ask(true)}>{T.second.consentYes}</button>
                <button type="button" className={btnSecondary} disabled={busy} onClick={() => setConsent(false)}>{T.second.consentNo}</button>
              </div>
            </div>
          )}
          {busy && <p role="status" className="text-[15px] text-muted">{T.second.asking}</p>}
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
          {so.screenshot && <img src={secondOpinionShotUrl(id)} alt={T.second.shotAlt} className="w-full rounded-lg border border-line" loading="lazy" />}
        </div>
      )}
    </Card>
  );
}
