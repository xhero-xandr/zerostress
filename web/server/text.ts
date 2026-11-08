// The sentences the server itself sends: error messages of the API, the label of each stage in the progress stream, and
// the answers to the owner's decision. Everything a page shows lives in the client (web/client/src/text.ts, spec 012).

import { GATE_TEXT, type GateReason } from './gate.ts';
import type { Stage } from './store.ts';

/** an example under the address field; `deep` also ticks "Let the agent act on the page" */
export interface Demo { label: string; url: string; deep?: true }

export const T = {
  queued: (n: number | null) => (n && n > 1 ? `Waiting in line (${n - 1} ahead of you)` : 'Waiting for a free sandbox'),
  stageNow: { queued: 'Waiting for a free sandbox', starting: 'Starting a disposable sandbox', opening: 'Opening the page and recording what it does', analysing: 'Weighing the evidence', done: 'Done', failed: 'Stopped' } as Readonly<Record<Stage, string>>,
  waitingForOwner: 'Waiting for your decision',
  approved: 'Allowed. The agent is carrying it out in the sandbox.',
  denied: 'Not allowed. The sandbox will close without taking the action.',
  expired: 'This decision is no longer possible: the action changed or the time ran out.',
  actions: { submit_form: 'Submit a form on the page', download: 'Download a file from the page', click: 'Click on the page', fill: 'Type into a field', open_link: 'Open a link on the page' } as Readonly<Record<string, string>>,
  actionOther: 'Take an action on the page',
  errors: {
    ...GATE_TEXT,
    rate_hour: 'You have reached the hourly limit for checks. Please try again a little later.',
    rate_day: 'You have reached the daily limit for checks. Please come back tomorrow.',
    too_many_active: 'You already have a check running. Wait for it to finish first.',
    daily_cap: 'The service has reached its daily limit for free checks. It resets at midnight UTC.',
    busy: 'All sandboxes are busy right now. Please try again in a minute.',
    supervisor_unavailable: 'The checking service is not available right now. Please try again shortly.',
    bad_request: 'That request could not be read. Reload the page and try again.',
    not_found: 'This report does not exist, or it has expired. Reports are kept for 24 hours.',
    bad_question: 'Please ask a question of up to 300 characters.',
    chat_rate: 'You have asked a lot of questions in the last hour. Please try again a little later.',
    chat_busy: 'Your previous question is still being answered.',
    chat_cap: 'This report has had as many questions as it can take. The explanation above is still available.',
    forbidden: 'This is not allowed from here.',
    scan_pending: 'Cloudflare is still scanning the page. Ask again in a minute.',
    scan_refused: 'Cloudflare does not scan this link.',
    scan_quota: 'Today\'s new scans at Cloudflare are used up. A recent scan of this link by someone else can still be found: ask again tomorrow for a new one.',
    file_too_large: 'That file is too large. Files of up to 10 MB can be checked.',
    server: 'Something went wrong on our side. Please try again.',
  } as Readonly<Record<string, string>>,
};

export const errorText = (code: string): string => T.errors[code] ?? T.errors.server!;
export type { GateReason };
