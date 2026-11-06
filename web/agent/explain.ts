// The explanation in our own words, with no model: what the verdict is, the reasons the fixed rules found, and what
// to do. It is what "Explain" says when no model may be used (the page addressed the reader, the page was not read, the
// daily limit is reached, no model is set up), and it is always right to show: every sentence is ours or a signal's
// sentence from signals.ts. Plain text, to be shown as text.

import type { PublicReport } from './report.ts';

const HEAD: Record<string, string> = {
  malicious: 'This link looks dangerous.',
  suspicious: 'This link looks suspicious. Be careful with it.',
  benign: 'No threat was found in what the page showed. That is not a guarantee: a page can change, or show something else to someone else.',
  unknown: 'The page could not be read, so there is no verdict. It may have refused the sandbox (a bot check, an error page, an empty page).',
};
const ADVICE: Record<string, string> = {
  malicious: 'What to do: do not open it on your own device and do not type anything into it. If you already did, change the password you used there.',
  suspicious: 'What to do: do not enter passwords or card details. If it claims to be a company you use, go to that company by its own known address instead.',
  benign: 'What to do: still check that the address is the one you expect before you type anything into the page.',
  unknown: 'What to do: treat the link as unchecked. Do not enter anything into it unless you know who sent it and why.',
};
const RANK: Record<string, number> = { high: 3, medium: 2, low: 1, info: 0 };
const MAX_REASONS = 5;

export function explainPlain(r: PublicReport): string {
  const verdict = Object.hasOwn(HEAD, r.verdict) ? r.verdict : 'unknown';
  const found = [...r.signals]
    .filter((s) => (RANK[s.level] ?? 0) > 0)
    .sort((a, b) => (RANK[b.level] ?? 0) - (RANK[a.level] ?? 0))
    .slice(0, MAX_REASONS);
  const lines = [HEAD[verdict]!];
  if (found.length) lines.push('', 'What the checks found:', ...found.map((s) => `- ${s.text}`));
  else if (verdict !== 'unknown') lines.push('', 'The checks found nothing unusual.');
  lines.push('', ADVICE[verdict]!);
  return lines.join('\n');
}
