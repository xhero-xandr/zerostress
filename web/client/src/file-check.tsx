// A file to check: an email's attachment or one picked from the computer. Its SHA-256 is computed here, in the browser,
// and only that hash is sent to ask VirusTotal; the file itself is sent only when the person asks to open it in the
// sandbox, and then it lives only until the sandbox has fetched it. Also the file's card in its report.
import { useQuery } from '@tanstack/react-query';
import { FileSearch } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import type { PublicReport } from '../../agent/report-types.ts';
import { ApiError, getFileHash, startFileCheck, type FileVerdict } from './api.ts';
import { isTaskId } from './logic.ts';
import { T } from './text.ts';
import { btnPrimary, Card, Fact, Facts, LevelPill } from './ui.tsx';

const F = T.file;
export const FILE_MAX = 10 * 1024 * 1024;

export async function sha256Hex(data: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', data as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export const sizeText = (n: number): string => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/** what VirusTotal's answer means to a person */
export function vtText(v: FileVerdict | null | undefined): { text: string; level: 'high' | 'medium' | 'low' | 'info' } {
  if (!v) return { text: F.vtNotAsked, level: 'info' };
  if (!v.known) return { text: F.vtUnknown, level: 'info' };
  const n = v.malicious + v.suspicious;
  if (n === 0) return { text: F.vtClean(v.total), level: 'low' };
  return { text: F.vtFlagged(n, v.total, v.label), level: v.malicious >= 3 ? 'high' : 'medium' };
}

/** One file, before it is checked: what VirusTotal knows of its hash, and the button that opens it in the sandbox. */
export function FileRow({ name, mime, data, note, onOpen }: { name: string; mime: string; data: Uint8Array | null; note?: string; onOpen?: (data: Uint8Array, name: string, mime: string) => void }) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const tooLarge = data !== null && data.length > FILE_MAX;
  const hash = useQuery({ queryKey: ['sha', name, data?.length], queryFn: () => sha256Hex(data!), enabled: data !== null && data.length > 0, staleTime: Infinity });
  const vt = useQuery({ queryKey: ['vt', hash.data], queryFn: () => getFileHash(hash.data!), enabled: !!hash.data, staleTime: Infinity, retry: false });
  const said = vt.isSuccess ? vtText(vt.data.virustotal) : null;
  const open = async () => {
    if (!data) return;
    // in the side panel the check is followed there, not on another page
    if (onOpen) { onOpen(data, name, mime); return; }
    setError('');
    setBusy(true);
    try {
      const { id, key } = await startFileCheck(data, name, mime);
      if (!isTaskId(id) || !/^[A-Za-z0-9_-]{20,100}$/.test(key)) throw new ApiError(500, 'server', T.serverError);
      navigate({ pathname: `/r/${id}`, hash: `k=${key}` });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : T.serverError);
      setBusy(false);
    }
  };
  return (
    <li className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-surface p-3">
      <div className="flex min-w-0 flex-[999_1_300px] flex-col gap-1">
        <span className="font-mono text-[15px] font-semibold [overflow-wrap:anywhere]">{name}</span>
        <span className="text-xs text-faint">{data ? sizeText(data.length) : F.noContent}{mime ? ` · ${mime}` : ''}</span>
        {note && <span className="text-sm text-warn">{note}</span>}
        {said && <span className={`text-sm ${said.level === 'high' ? 'font-semibold text-danger' : said.level === 'medium' ? 'text-warn' : 'text-muted'}`}>{said.text}</span>}
        {vt.isError && <span className="text-sm text-faint">{F.vtNotAsked}</span>}
        {error && <span role="alert" className="text-sm text-danger">{error}</span>}
      </div>
      {data && data.length > 0 && (
        <button type="button" className={`${btnPrimary} flex-[1_1_auto]`} disabled={busy || tooLarge} onClick={() => void open()}>
          <FileSearch className="size-4" aria-hidden /> {tooLarge ? F.tooLarge : busy ? T.checking : F.open}
        </button>
      )}
    </li>
  );
}

const FINDING_LEVEL: Readonly<Record<string, 'high' | 'medium' | 'low'>> = {
  executable: 'high', script_file: 'high', shortcut: 'high', auto_exec: 'high', external_template: 'high', dde: 'high', pdf_launch: 'high',
  archive_executable: 'high', html_smuggling: 'high', svg_script: 'high', html_password_form: 'high',
  macros: 'medium', ole_object: 'medium', 'pdf_javascript': 'medium', pdf_open_action: 'medium', pdf_embedded_file: 'medium', pdf_submit_form: 'medium',
  archive_encrypted: 'medium', disk_image: 'medium', html_form_elsewhere: 'medium', html_obfuscated_script: 'medium', html_redirect: 'medium',
  nested_archive: 'low', pdf_encrypted: 'low',
};

/** The file in its report: what it is, what was found inside it in the sandbox, and what VirusTotal knows of it. */
export function FileCard({ r }: { r: PublicReport }) {
  const f = r.file;
  if (!f) return null;
  const said = vtText(f.virustotal);
  return (
    <Card title={F.cardTitle} titleId="file">
      <p className="mb-3 text-muted">{f.read ? (f.viewed ? F.readAndViewed : F.read) : F.notRead}</p>
      <Facts>
        <Fact term={F.name} mono>{f.name}</Fact>
        <Fact term={F.size}>{sizeText(f.bytes)}</Fact>
        <Fact term={F.type}>{f.type ? f.type.toUpperCase() : '—'}</Fact>
        <Fact term="SHA-256" mono>{f.sha256}</Fact>
        <Fact term="VirusTotal">{said.text}</Fact>
      </Facts>
      {f.read && (
        <div className="mt-4 flex flex-col gap-2">
          <p className="font-semibold">{F.found}</p>
          {f.findings.length === 0 ? <p className="text-muted">{F.nothingFound}</p> : (
            <ul className="flex flex-col gap-1.5">
              {f.findings.map((id) => (
                <li key={id} className="flex items-start gap-2"><LevelPill level={FINDING_LEVEL[id] ?? 'low'}>{T.level[FINDING_LEVEL[id] ?? 'low']}</LevelPill><span>{F.finding[id] ?? id}</span></li>
              ))}
            </ul>
          )}
        </div>
      )}
      {f.entries.length > 0 && (
        <div className="mt-4">
          <p className="font-semibold">{F.entries(f.entries.length)}</p>
          <ul className="mt-1 font-mono text-sm [overflow-wrap:anywhere]">{f.entries.map((e, i) => <li key={i}>{e}</li>)}</ul>
        </div>
      )}
      {f.links.length > 0 && (
        <div className="mt-4">
          <p className="font-semibold">{F.links(f.links.length)}</p>
          {/* addresses from the file are text, never links (spec 007, 3.5) */}
          <ul className="mt-1 font-mono text-xs text-muted [overflow-wrap:anywhere]">{f.links.map((u, i) => <li key={i}>{u.length > 160 ? `${u.slice(0, 160)}…` : u}</li>)}</ul>
          <p className="mt-1 text-sm text-faint">{F.linksHint}</p>
        </div>
      )}
    </Card>
  );
}
