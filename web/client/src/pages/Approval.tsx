// The owner's decision (spec 007, 3.6). Only someone holding the task key (after "#k=") sees the buttons; the key is
// sent in the X-Task-Key header and nowhere else.
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useLocation } from 'react-router';
import { ApiError, decide, getPending } from '../api.ts';
import { keyFromHash } from '../logic.ts';
import { T } from '../text.ts';
import { btnPrimary, btnSecondary } from '../ui.tsx';

export function Approval({ id }: { id: string }) {
  const key = keyFromHash(useLocation().hash);
  const pending = useQuery({ queryKey: ['pending', id], queryFn: () => getPending(id, key), enabled: key !== '', retry: false });
  const [result, setResult] = useState('');
  const [sent, setSent] = useState(false);
  const p = pending.data?.pending[0];

  if (!key || !p) return <p className="text-[15px] text-muted">{T.approvalOnlyOwner}</p>;
  const choose = async (allow: boolean) => {
    setSent(true);
    try {
      setResult((await decide(id, key, p, allow)).message);
    } catch (e) {
      setResult(e instanceof ApiError ? e.message : T.serverError);
    }
  };
  return (
    <section aria-labelledby="approval" className="flex flex-col gap-3 rounded-2xl border-2 border-accent bg-accent-soft p-5 sm:p-6">
      <h2 id="approval" className="text-lg font-bold">{T.approvalTitle}</h2>
      <p>{T.approvalText}</p>
      <p className="font-semibold">{p.label}</p>
      <div className="flex flex-wrap gap-2.5">
        <button type="button" disabled={sent} onClick={() => void choose(true)} className={btnPrimary}>{T.allow}</button>
        <button type="button" disabled={sent} onClick={() => void choose(false)} className={btnSecondary}>{T.deny}</button>
      </div>
      <p role="status" className="text-muted">{result}</p>
    </section>
  );
}
