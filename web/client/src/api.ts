// Every request the client makes, all to its own address (CSP connect-src 'self'). The task key only ever travels in
// the X-Task-Key header: never in an address, a parameter or storage.
import type { PublicReport } from '../../agent/report-types.ts';
import type { ChatAnswer, Demo, EmailCheckStarted, FileCheckStarted, FileHashAnswer, Pending, PendingList, SenderInfo, TaskStarted, TaskStatus } from '../../shared/api-types.ts';
import { T } from './text.ts';

export type { ChatAnswer, Demo, EmailCheckStarted, FileCheckStarted, FileHashAnswer, FileVerdict, Pending, PendingList, SenderInfo, Stage, TaskStarted, TaskStatus } from '../../shared/api-types.ts';

/** An answer of ours that is not a success: the server's code and its sentence. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function read<T>(res: Response): Promise<T> {
  let body: unknown = null;
  try { body = await res.json(); } catch { /* not JSON */ }
  if (!res.ok) {
    const b = (body ?? {}) as { code?: unknown; message?: unknown };
    throw new ApiError(res.status, typeof b.code === 'string' ? b.code : 'server', typeof b.message === 'string' ? b.message : T.serverError);
  }
  return body as T;
}

const JSON_HEADERS = { 'content-type': 'application/json' };

export const getStatus = (id: string): Promise<TaskStatus> => fetch(`/api/tasks/${id}`).then((r) => read<TaskStatus>(r));
export const getReport = (id: string): Promise<PublicReport> => fetch(`/r/${id}/report.json`).then((r) => read<PublicReport>(r));
export const getDemos = (): Promise<{ demos: Demo[] }> => fetch('/api/demos').then((r) => read<{ demos: Demo[] }>(r));

export const startTask = (url: string, deep: boolean): Promise<TaskStarted> =>
  fetch('/api/tasks', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ url, deep }) }).then((r) => read<TaskStarted>(r));

export const startEmailCheck = (links: string[]): Promise<EmailCheckStarted> =>
  fetch('/api/email-checks', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ links }) }).then((r) => read<EmailCheckStarted>(r));

/** what VirusTotal knows about a file: only its SHA-256 is sent */
export const getFileHash = (sha256: string): Promise<FileHashAnswer> =>
  fetch('/api/file-hash', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ sha256 }) }).then((r) => read<FileHashAnswer>(r));
/** the file itself, to be opened in the sandbox: held in memory until the sandbox has fetched it, then gone */
export const startFileCheck = (data: Uint8Array, name: string, mime: string): Promise<FileCheckStarted> =>
  fetch('/api/files', { method: 'POST', headers: { 'content-type': mime || 'application/octet-stream', 'x-file-name': encodeURIComponent(name) }, body: data as Uint8Array<ArrayBuffer> }).then((r) => read<FileCheckStarted>(r));

/** what is known about the domain an email came from: only the domain is sent */
export const getSender = (domain: string): Promise<{ sender: SenderInfo }> =>
  fetch('/api/sender', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ domain }) }).then((r) => read<{ sender: SenderInfo }>(r));

export const askChat = (id: string, payload: { kind: 'explain' } | { kind: 'ask'; message: string }): Promise<ChatAnswer> =>
  fetch(`/api/reports/${id}/chat`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(payload) }).then((r) => read<ChatAnswer>(r));

export const getPending = (id: string, key: string): Promise<PendingList> =>
  fetch(`/api/tasks/${id}/pending`, { headers: { 'x-task-key': key } }).then((r) => read<PendingList>(r));

export const decide = (id: string, key: string, p: Pending, allow: boolean): Promise<{ message: string }> =>
  fetch(`/api/tasks/${id}/approvals`, {
    method: 'POST',
    headers: { ...JSON_HEADERS, 'x-task-key': key },
    body: JSON.stringify({ command_id: p.command_id, command_sha256: p.command_sha256, allow }),
  }).then((r) => read<{ message: string }>(r));

export type SecondOpinion = NonNullable<PublicReport['second_opinion']>;
export const askSecondOpinion = (id: string, key: string): Promise<{ second_opinion: SecondOpinion }> =>
  fetch(`/api/tasks/${id}/second-opinion`, { method: 'POST', headers: { ...JSON_HEADERS, 'x-task-key': key }, body: '{}' })
    .then((r) => read<{ second_opinion: SecondOpinion }>(r));
export const secondOpinionShotUrl = (id: string): string => `/r/${id}/second-opinion.png`;

export const shotUrl = (id: string, device: 'desktop' | 'tablet' | 'mobile'): string => `/r/${id}/screenshot.png?device=${device}`;
export const reportJsonUrl = (id: string): string => `/r/${id}/report.json`;
