export type Logger = (level: 'info' | 'warn' | 'error', msg: string, fields?: Record<string, unknown>) => void;

export const stdoutLogger: Logger = (level, msg, fields) => {
  process.stdout.write(JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields }) + '\n');
};

export const nullLogger: Logger = () => {};

/** What may be logged about a URL: it can carry personal tokens, so never the whole string. */
export function urlInfo(url: string): { scheme?: string; host?: string; len: number } {
  try {
    const u = new URL(url);
    return { scheme: u.protocol.replace(':', ''), host: u.hostname, len: url.length };
  } catch {
    return { len: url.length };
  }
}
