// A safe demo for Pattern B: a page that offers a file, so that a deep check has a risky step to ask about (the
// model may propose `download`, which waits for the owner's Allow). The file is plain text and harmless, and the page
// says it is a ZeroStress demo. No script runs on it: it is served under its own policy, sandboxed, no script source.

import type { Demo } from './text.ts';

/** The examples under the address field: WEB_DEMOS, `label|url` or `label|url|deep`, separated by `;`. */
export const DEFAULT_DEMOS = 'A harmless page|https://example.com/;A phishing test page|https://testsafebrowsing.appspot.com/s/phishing.html;A file to approve|https://zerostress.space/demo/shared-file|deep';
export function parseDemos(spec: string): Demo[] {
  return spec.split(';').map((x) => x.split('|').map((p) => p.trim()))
    .filter((x) => (x.length === 2 || (x.length === 3 && x[2] === 'deep')) && x[0] && /^https?:\/\//.test(x[1]!))
    .map(([label, url, deep]) => ({ label: label!, url: url!, ...(deep ? { deep: true as const } : {}) }));
}

export const DEMO_FILE_NAME = 'Invoice-2026-11.txt';

export const DEMO_FILE = `ZeroStress demo file.

This is plain text and harmless. It exists so that a deep check has a download to ask you about:
the agent proposes it, and nothing is fetched into the sandbox until you press Allow.
`;

export const DEMO_CSP = "sandbox; default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export const DEMO_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>A document was shared with you</title>
<style>
  body { margin: 0; font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; background: #f3f4f6; color: #111827; }
  main { max-width: 560px; margin: 64px auto; background: #fff; border: 1px solid #e5e7eb; border-radius: 12px; padding: 32px; }
  h1 { font-size: 22px; margin: 0 0 8px; }
  .from { color: #6b7280; margin: 0 0 24px; }
  .file { display: flex; align-items: center; justify-content: space-between; gap: 16px; border: 1px solid #e5e7eb; border-radius: 10px; padding: 16px; }
  .name { font-weight: 600; }
  .size { color: #6b7280; font-size: 14px; }
  a.button { background: #2563eb; color: #fff; text-decoration: none; padding: 10px 18px; border-radius: 8px; font-weight: 600; }
  footer { max-width: 560px; margin: 0 auto 48px; color: #6b7280; font-size: 13px; text-align: center; }
</style>
</head>
<body>
<main>
  <h1>A document was shared with you</h1>
  <p class="from">Billing team · Northwind Supplies</p>
  <div class="file">
    <div><div class="name">${DEMO_FILE_NAME}</div><div class="size">Text document · 1 KB</div></div>
    <a class="button" href="/demo/files/${DEMO_FILE_NAME}" download>Download</a>
  </div>
  <p>Please review the invoice before the end of the month.</p>
</main>
<footer>A ZeroStress demo page: the file is a harmless text file, here to show that a download waits for your approval.</footer>
</body>
</html>
`;
