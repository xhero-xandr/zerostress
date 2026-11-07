// The same API the site uses, called from the extension: the server lets exactly this extension's origin in
// (web/server/app.ts, EXTENSION_ORIGIN). The task key never leaves the panel except to our own server.
import { SERVICE } from './link.ts';

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

async function read<T>(res: Response): Promise<T> {
  let body: unknown = null;
  try { body = await res.json(); } catch { /* not JSON */ }
  if (!res.ok) {
    const b = (body ?? {}) as { code?: unknown; message?: unknown };
    throw new ApiError(res.status, typeof b.code === 'string' ? b.code : 'server', typeof b.message === 'string' ? b.message : 'Something went wrong on our side. Please try again.');
  }
  return body as T;
}
const JSON_HEADERS = { 'content-type': 'application/json' };
const url = (path: string) => new URL(path, SERVICE).href;

export const startTask = (link: string, deep: boolean) =>
  fetch(url('/api/tasks'), { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ url: link, deep }) }).then((r) => read<{ id: string; key: string }>(r));
export const eventsUrl = (id: string) => url(`/api/tasks/${id}/events`);
export interface Pending { command_id: string; command_sha256: string; label: string }
export const getPending = (id: string, key: string) =>
  fetch(url(`/api/tasks/${id}/pending`), { headers: { 'x-task-key': key } }).then((r) => read<{ pending: Pending[] }>(r));
export const decide = (id: string, key: string, p: Pending, allow: boolean) =>
  fetch(url(`/api/tasks/${id}/approvals`), { method: 'POST', headers: { ...JSON_HEADERS, 'x-task-key': key }, body: JSON.stringify({ command_id: p.command_id, command_sha256: p.command_sha256, allow }) }).then((r) => read<{ message: string }>(r));
export const getReport = (id: string) => fetch(url(`/r/${id}/report.json`)).then((r) => read<import('../../agent/report-types.ts').PublicReport>(r));
export const chat = (id: string, payload: { kind: 'explain' } | { kind: 'ask'; message: string }) =>
  fetch(url(`/api/reports/${id}/chat`), { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(payload) }).then((r) => read<{ text: string; source: string; note: string | null }>(r));
export const askSecondOpinion = (id: string, key: string, publish: boolean) =>
  fetch(url(`/api/tasks/${id}/second-opinion`), { method: 'POST', headers: { ...JSON_HEADERS, 'x-task-key': key }, body: JSON.stringify(publish ? { publish: true } : {}) }).then((r) => read<{ second_opinion: unknown }>(r));
export const reportPage = (id: string, key: string) => url(`/r/${id}#k=${key}`);
