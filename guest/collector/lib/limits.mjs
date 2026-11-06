// Limits of spec 005. Everything that comes from a page is cut to these sizes before it leaves the guest.
export const LIMITS = Object.freeze({
  urlChars: 2048,
  textBytes: 20 * 1024,
  hiddenTextBytes: 4 * 1024,
  metaItems: 20,
  metaChars: 300,
  snapshotBytes: 64 * 1024,
  snapshotLines: 1500,
  links: 100,
  linkTextChars: 200,
  requests: 300,
  consoleLines: 100,
  consoleChars: 500,
  dialogChars: 500,
  popups: 3,
  forms: 20,
  fieldsPerForm: 40,
  tlsHosts: 20,
  errorChars: 300,
  // The guest agent forwards at most 1 MiB of output per run (spec 004, 8c); stay well below it.
  outputBudgetBytes: 900 * 1024,
  navTimeoutDefaultS: 30,
  navTimeoutMaxS: 60,
  settleMs: 3000,
  // A frame that never finishes loading (for example a blocked file: iframe) makes ariaSnapshot wait for its full default
  // timeout of 30 s; with an explicit timeout it returns the main frame's snapshot instead.
  snapshotTimeoutMs: 3000,
  sessionMaxDefaultS: 300,
  sessionMaxCapS: 600,
});

/** Cuts a string to at most `max` UTF-16 code units without leaving half of a surrogate pair. */
export function cut(value, max) {
  const s = typeof value === 'string' ? value : value == null ? '' : String(value);
  if (s.length <= max) return s;
  let end = max;
  const code = s.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return s.slice(0, end);
}

/** Cuts a string to at most `max` UTF-8 bytes on a character boundary. */
export function cutBytes(value, max) {
  const s = typeof value === 'string' ? value : value == null ? '' : String(value);
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= max) return s;
  let end = max;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1;
  return buf.subarray(0, end).toString('utf8');
}
