import type { LogEntry } from '../../../agent/agent-log.ts';
import { logLine, logTime } from '../logic.ts';
import { T } from '../text.ts';

/** Which part of the system a line comes from, for the dot before it. */
function family(code: string): 'vm' | 'browser' | 'guard' | 'model' | 'human' | 'end' {
  if (code === 'submitted' || code.startsWith('vm_')) return 'vm';
  if (code.startsWith('hooks') || code.startsWith('gate_') || code === 'stopped_by_hooks') return 'guard';
  if (code.startsWith('model') || code === 'rules_only') return 'model';
  if (code.startsWith('approval')) return 'human';
  if (code === 'verdict') return 'end';
  return 'browser';
}
const DOT: Record<ReturnType<typeof family>, string> = {
  vm: 'bg-accent', browser: 'bg-line-strong', guard: 'bg-amber-500', model: 'bg-violet-500', human: 'bg-sky-500', end: 'bg-accent',
};

/** The agent's log: one line per real event of the check, with its time. Every value in it is text, never markup. */
export function AgentLog({ entries, live = false }: { entries: readonly LogEntry[]; live?: boolean }) {
  if (!entries.length) return <p className="text-muted">{T.logEmpty}</p>;
  return (
    <ol aria-label={T.logTitle} aria-live={live ? 'polite' : undefined} className="flex flex-col gap-1.5">
      {entries.map((e, i) => (
        <li key={i} className="grid grid-cols-[4.5rem_auto_1fr] items-baseline gap-2 text-[15px]">
          <span className="font-mono text-[13px] text-faint tabular-nums">{logTime(e.t)}</span>
          <span aria-hidden className={`size-2 translate-y-[-1px] rounded-full ${DOT[family(e.code)]}`} />
          <span className="[overflow-wrap:anywhere]">{logLine(e)}</span>
        </li>
      ))}
    </ol>
  );
}
