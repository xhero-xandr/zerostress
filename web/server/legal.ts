// The privacy policy and the terms, one source each: docs/privacy.md and docs/terms.md, shown on GitHub as they are
// and here as a plain page. Only the Markdown those files use is understood: headings, paragraphs, lists, bold,
// inline code and links; everything else is text, and all text is escaped.
import { readFileSync } from 'node:fs';

export const LEGAL_CSP = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function inline(raw: string): string {
  return esc(raw)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\(((?:https:\/\/|mailto:|\/)[^)\s]*)\)/g, '<a href="$2">$1</a>')
    .replace(/(^|[\s(])(https:\/\/[^\s<)]+[^\s<).,;:])/g, '$1<a href="$2">$2</a>')
    .replace(/(^|[\s(])([\w.+-]+@[\w-]+(?:\.[\w-]+)+)(?=[\s.,;:)]|$)/g, '$1<a href="mailto:$2">$2</a>');
}

export function markdownPage(md: string): string {
  const out: string[] = [];
  let title = 'ZeroStress';
  for (const block of md.replace(/\r/g, '').split(/\n{2,}/)) {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    if (lines.length === 0) continue;
    if (lines.every((l) => l.startsWith('- '))) {
      out.push('<ul>', ...lines.map((l) => `<li>${inline(l.slice(2))}</li>`), '</ul>');
      continue;
    }
    const h = /^(#{1,3}) (.*)$/.exec(lines[0]!);
    if (h && lines.length === 1) {
      const n = h[1]!.length;
      if (n === 1) title = h[2]!;
      out.push(`<h${n}>${inline(h[2]!)}</h${n}>`);
      continue;
    }
    out.push(`<p>${inline(lines.join(' '))}</p>`);
  }
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · ZeroStress</title>
<style>
  :root { color-scheme: light dark; --bg: #f8fafc; --fg: #0f172a; --muted: #475569; --link: #0f766e; --card: #fff; --line: #e2e8f0; }
  @media (prefers-color-scheme: dark) { :root { --bg: #0b1220; --fg: #e2e8f0; --muted: #94a3b8; --link: #5eead4; --card: #111a2c; --line: #1e293b; } }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 760px; margin: 0 auto; padding: 32px 16px 64px; }
  nav { margin-bottom: 24px; font-weight: 600; }
  a { color: var(--link); }
  h1 { font-size: 30px; line-height: 1.2; margin: 0 0 16px; }
  h2 { font-size: 20px; margin: 32px 0 8px; }
  p, li { color: var(--fg); }
  code { font-size: 14px; background: var(--card); border: 1px solid var(--line); border-radius: 4px; padding: 0 4px; }
  footer { margin-top: 40px; padding-top: 16px; border-top: 1px solid var(--line); color: var(--muted); font-size: 14px; }
</style>
</head>
<body>
<main>
<nav><a href="/">ZeroStress</a></nav>
${out.join('\n')}
<footer><a href="/privacy">Privacy policy</a> · <a href="/terms">Terms of use</a></footer>
</main>
</body>
</html>
`;
}

/** both pages, rendered once from the files in docs/ */
export function loadLegal(docsDir: string): { privacy: string; terms: string } {
  return {
    privacy: markdownPage(readFileSync(`${docsDir}/privacy.md`, 'utf8')),
    terms: markdownPage(readFileSync(`${docsDir}/terms.md`, 'utf8')),
  };
}
