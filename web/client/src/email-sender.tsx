// Who sent an email: its domain, looked up by the server (only the domain is sent), against what the email claims.
import { useEffect, useState } from 'react';
import { BRANDS } from '../../agent/lists.ts';
import { getSender, type SenderInfo } from './api.ts';
import type { EmailCheck, EmailWarning } from './email.ts';
import { ageWords } from './logic.ts';
import { T } from './text.ts';

const M = T.mail;

/** the brand the sender's name claims (PayPal, Microsoft), if any */
export function claimedBrand(name: string | null): string | null {
  if (!name) return null;
  const n = ` ${name.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ')} `;
  const b = BRANDS.find((x) => x.words.some((w) => n.includes(` ${w} `)));
  return b ? b.words[0]! : null;
}

/** the warnings about the sender, from what its domain is and what its name claims */
export function senderWarnings(s: SenderInfo, name: string | null): EmailWarning[] {
  const W = M.warn;
  const out: EmailWarning[] = [];
  const cap = (x: string) => x.charAt(0).toUpperCase() + x.slice(1);
  if (s.lookalike) out.push({ id: 'sender_lookalike', level: 'high', text: W.lookalike(s.domain, cap(s.lookalike)) });
  const claim = claimedBrand(name);
  if (claim && s.brand !== claim && !s.lookalike) out.push({ id: s.freemail ? 'sender_freemail_brand' : 'sender_claims_brand', level: 'high', text: s.freemail ? W.freemailBrand(cap(claim), s.domain) : W.claimsBrand(cap(claim), s.domain) });
  if (s.age_days !== null && s.age_days < 180) out.push({ id: 'sender_young', level: s.age_days < 30 ? 'high' : 'medium', text: W.youngSender(s.domain, Math.floor(s.age_days)) });
  if (!s.freemail && !s.spf && s.dmarc === null) out.push({ id: 'sender_no_policy', level: 'medium', text: W.noPolicy(s.domain) });
  return out;
}

export function SenderFacts({ mail, small }: { mail: EmailCheck; small: string }) {
  const domain = mail.from?.address?.split('@').pop() ?? null;
  const [s, setS] = useState<SenderInfo | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!domain) return;
    let live = true;
    getSender(domain).then((r) => { if (live) setS(r.sender); }, () => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [domain]);
  if (!domain || failed) return null;
  if (!s) return <p role="status" className={`${small} text-muted`}>{M.senderAsking}</p>;
  const warnings = senderWarnings(s, mail.from?.name ?? null);
  return (
    <div aria-label={M.sender} className="flex flex-col gap-1">
      <p className="font-semibold">{M.sender}</p>
      <dl className={`grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 ${small}`}>
        <dt className="text-muted">{M.senderDomain}</dt><dd className="[overflow-wrap:anywhere]">{s.domain}{s.freemail ? ` (${M.freemailIs(s.domain)})` : ''}</dd>
        <dt className="text-muted">{M.senderAge}</dt><dd>{s.age_days !== null ? ageWords(s.age_days) : '—'}</dd>
        <dt className="text-muted">{M.senderPolicy}</dt><dd>{M.policy(s.dmarc, s.spf)}</dd>
      </dl>
      {warnings.length > 0 && <ul className={`flex flex-col gap-1 ${small}`}>{warnings.map((w) => <li key={w.id} className={w.level === 'high' ? 'font-semibold text-danger' : 'text-warn'}>{w.text}</li>)}</ul>}
      <p className={`${small} text-faint`}>{M.senderNote}</p>
    </div>
  );
}
