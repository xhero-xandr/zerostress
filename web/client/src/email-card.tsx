// What an email itself shows (email.ts): the sender, what the receiving server recorded about it, the warnings and the
// attachments. The links come after it, on the home page and in the side panel, each with its own button.
import type { EmailCheck } from './email.ts';
import { T } from './text.ts';
import { SenderFacts } from './email-sender.tsx';

const M = T.mail;

export function EmailFindings({ mail, compact = false }: { mail: EmailCheck; compact?: boolean }) {
  const small = compact ? 'text-[12.5px]' : 'text-sm';
  const rows: Array<[string, string]> = [];
  if (mail.from) rows.push([M.from, mail.from.name && mail.from.address ? `${mail.from.name} <${mail.from.address}>` : (mail.from.address ?? mail.from.name ?? '')]);
  if (mail.replyTo && mail.replyTo !== mail.from?.address) rows.push([M.replyTo, mail.replyTo]);
  if (mail.subject) rows.push([M.subject, mail.subject]);
  if (mail.auth) rows.push([M.auth, `SPF ${mail.auth.spf ?? 'none'} · DKIM ${mail.auth.dkim ?? 'none'} · DMARC ${mail.auth.dmarc ?? 'none'} (${M.authBy})`]);
  return (
    <section aria-label={M.title} className="flex flex-col gap-2">
      <p className={compact ? 'font-semibold' : 'text-[15px] font-semibold'}>{M.title}</p>
      {rows.length > 0 && (
        <dl className={`grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 ${small}`}>
          {rows.map(([k, v]) => [<dt key={`k${k}`} className="text-muted">{k}</dt>, <dd key={`v${k}`} className="[overflow-wrap:anywhere]">{v}</dd>])}
        </dl>
      )}
      {mail.source && !mail.auth && <p className={`${small} text-muted`}>{M.authNone}</p>}
      {mail.source && <SenderFacts mail={mail} small={small} />}
      {!mail.source && <p className={`${small} text-muted`}>{M.textOnly}</p>}
      {mail.warnings.length > 0
        ? <ul aria-label={M.warnings} className={`flex flex-col gap-1 ${small}`}>{mail.warnings.map((w) => <li key={w.id + w.text} className={w.level === 'high' ? 'font-semibold text-danger' : 'text-warn'}>{w.text}</li>)}</ul>
        : <p className={small}>{M.noWarnings}</p>}
      {mail.attachments.length > 0 && (
        <div className={small}>
          <p className="text-muted">{M.attachments}: {mail.attachments.map((a) => a.name).join(', ')}</p>
          <p className="text-faint">{M.attachmentsNote}</p>
        </div>
      )}
    </section>
  );
}
