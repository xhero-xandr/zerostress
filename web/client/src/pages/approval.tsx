// The owner's decision (spec 007, 3.6). Only someone holding the task key (task-key.ts) sees the buttons; the key is
// sent in the X-Task-Key header and nowhere else.
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError, decide, getPending } from '../api.ts';
import { useTaskKey } from '../task-key.ts';
import { T } from '../text.ts';
import { btnPrimary, btnSecondary } from '../ui.tsx';

export function Approval({ id }: { id: string }) {
  const key = useTaskKey(id);
  const pending = useQuery({ queryKey: ['pending', id], queryFn: () => getPending(id, key), enabled: key !== '', retry: false });
  const [result, setResult] = useState('');
  const [sending, setSending] = useState(false);
  // answered questions stay hidden even while the list still carries them; the next one waiting is shown in turn
  const [answered, setAnswered] = useState<ReadonlySet<string>>(new Set());
  const p = pending.data?.pending.find((x) => !answered.has(x.command_id));

  if (!key) return <p className="text-[15px] text-muted">{T.approvalOnlyOwner}</p>;
  // nothing is waiting now: the last answer stays
  if (!p) return result ? <p role="status" className="rounded-2xl border border-line bg-surface p-5 text-muted">{result}</p> : null;
  const choose = async (allow: boolean) => {
    setSending(true);
    try {
      const done = await decide(id, key, p, allow);
      setAnswered((cur) => new Set(cur).add(p.command_id));
      setResult(done.message);
    } catch (e) {
      // nothing was decided: the buttons come back so the owner can try again
      setResult(e instanceof ApiError ? e.message : T.serverError);
    } finally {
      setSending(false);
    }
  };
  return (
    <section aria-labelledby="approval" className="flex flex-col gap-3 rounded-2xl border-2 border-accent bg-accent-soft p-5 sm:p-6">
      <h2 id="approval" className="text-lg font-bold">{T.approvalTitle}</h2>
      <p>{T.approvalText}</p>
      <p className="font-semibold">{p.label}</p>
      <div className="flex flex-wrap gap-2.5">
        <button type="button" disabled={sending} onClick={() => void choose(true)} className={btnPrimary}>{T.allow}</button>
        <button type="button" disabled={sending} onClick={() => void choose(false)} className={btnSecondary}>{T.deny}</button>
      </div>
      <p role="status" className="text-muted">{result}</p>
    </section>
  );
}
