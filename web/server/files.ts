// A file someone wants checked, on its way into the sandbox. It is held in this process's memory only, never
// written to disk, under a random one-time address: the microVM fetches it once and it is gone; one never fetched is
// gone after a few minutes. Nothing here reads the file: it is opened only inside the microVM (docs/containment.md,
// rules 1 and 7). Only its hash is taken here, to ask VirusTotal about it without sending it.
import { createHash, randomBytes } from 'node:crypto';

export const FILE_MAX_BYTES = 10 * 1024 * 1024;

export interface HeldFile { name: string; mime: string; bytes: number; sha256: string; html: boolean }
interface Entry extends HeldFile { data: Buffer | null; view: Buffer | null; at: number }

export interface FileDrop {
  /** keep a file for the sandbox; null when too many are held already */
  put(data: Buffer, name: string, mime: string): { token: string; file: HeldFile } | null;
  /** the file, once; afterwards (or after the time is up) null */
  take(token: string): (HeldFile & { data: Buffer }) | null;
  /** an attached page to look at, once */
  takeView(token: string): Buffer | null;
  /** forget it, whatever it was waiting for */
  drop(token: string): void;
  size(): number;
}

/** what an ordinary person would call the file: no path, no control characters, a sane length */
export function cleanName(raw: string): string {
  const base = raw.replace(/\\/g, '/').split('/').pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const name = base.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, '').trim().slice(0, 200);
  return name || 'file';
}

const HTML_EXT = /\.(?:html?|xhtml|shtml|svg)$/i;

export function createFileDrop(o: { ttlMs?: number; maxHeldBytes?: number; now?: () => number } = {}): FileDrop {
  const ttl = o.ttlMs ?? 5 * 60_000;
  const maxHeld = o.maxHeldBytes ?? 100 * 1024 * 1024;
  const now = o.now ?? Date.now;
  const held = new Map<string, Entry>();
  const sweep = () => {
    const t = now();
    for (const [k, e] of held) if (t - e.at > ttl || (e.data === null && e.view === null)) held.delete(k);
  };
  const used = () => [...held.values()].reduce((n, e) => n + (e.data?.length ?? 0) + (e.view?.length ?? 0), 0);
  return {
    put(data, name, mime) {
      sweep();
      const clean = cleanName(name);
      const html = HTML_EXT.test(clean) || /^(?:text\/html|application\/xhtml\+xml|image\/svg\+xml)$/i.test(mime.trim());
      if (used() + data.length * (html ? 2 : 1) > maxHeld) return null;
      const token = randomBytes(24).toString('base64url');
      const file: HeldFile = { name: clean, mime: mime.slice(0, 100) || 'application/octet-stream', bytes: data.length, sha256: createHash('sha256').update(data).digest('hex'), html };
      held.set(token, { ...file, data: Buffer.from(data), view: html ? Buffer.from(data) : null, at: now() });
      return { token, file };
    },
    take(token) {
      sweep();
      const e = held.get(token);
      if (!e?.data) return null;
      const data = e.data;
      e.data = null;
      if (!e.view) held.delete(token);
      return { name: e.name, mime: e.mime, bytes: e.bytes, sha256: e.sha256, html: e.html, data };
    },
    takeView(token) {
      sweep();
      const e = held.get(token);
      if (!e?.view) return null;
      const v = e.view;
      e.view = null;
      if (!e.data) held.delete(token);
      return v;
    },
    drop(token) { held.delete(token); },
    size() { sweep(); return held.size; },
  };
}
