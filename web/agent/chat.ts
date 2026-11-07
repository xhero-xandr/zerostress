// The talk about a finished check: "Explain" and questions (spec 011). The model gets the PUBLIC report, nothing of the
// owner, inside a block marked as data; it has no tools and cannot change anything, only say something. What it says is
// checked before a person sees it: it must cite things the report really contains, its words go through the hooks like
// any text from outside, and it is cut to a length. When the model may not be used (the page addressed the reader, the
// page was not read, no model, no budget, a bad answer) the reply is our own explanation from explain.ts, never silence
// and never a guess.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Budget } from './budget.ts';
import type { AgentConfig } from './config.ts';
import { explainPlain } from './explain.ts';
import type { Message, ModelClient, ResponseFormat } from './model.ts';
import type { PublicReport } from './report.ts';
import { scanText } from '../hooks/index.ts';

export const CHAT_SCHEMA: ResponseFormat = {
  name: 'chat_answer',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['answer', 'cites'],
    properties: { answer: { type: 'string' }, cites: { type: 'array', items: { type: 'string' } } },
  },
};

export function loadChatPrompt(path: string = fileURLToPath(new URL('./prompts/chat.md', import.meta.url))): { text: string; sha256: string } {
  const text = readFileSync(path, 'utf8');
  if (text.trim().length < 200) throw new Error('the chat prompt is missing or empty');
  return { text, sha256: createHash('sha256').update(text).digest('hex') };
}

export const MAX_QUESTION = 300;
export const MAX_ANSWER = 800;
const MAX_ANSWER_RAW = 2000;
const EXPLAIN_QUESTION = 'Explain this result in plain words: what was found, what it means, and what I should do.';

export type Turn = { q: string; a: string };
export type ChatInput = { kind: 'explain' } | { kind: 'ask'; message: string; history: readonly Turn[] };
export type ChatReason = 'hooks_fired' | 'page_not_read' | 'no_model' | 'budget' | 'model_unavailable' | 'model_output_invalid' | 'model_output_flagged' | 'question_flagged';
export interface ChatReply {
  text: string;
  source: 'model' | 'rules';
  /** why the model was not used, when it was not */
  reason: ChatReason | null;
}

export interface ChatDeps {
  cfg: AgentConfig;
  client?: ModelClient;
  budget?: Budget;
  prompt: { text: string };
  nonce?: () => string;
}

/** Control characters out, line breaks kept (at most two in a row), the ends trimmed. */
export function cleanAnswer(raw: string): string {
  return raw
    .replace(/\r\n?/g, '\n')
    .replace(/(?!\n)[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** The names an answer may cite: the report's signal ids and the top-level names of its parts. */
function citable(r: PublicReport): Set<string> {
  const ids = new Set<string>(['verdict', 'summary', 'reasons', 'signals', 'mode', 'confidence', 'second_opinion']);
  for (const s of r.signals) ids.add(s.id);
  for (const k of Object.keys(r.facts)) ids.add(`facts.${k}`);
  return ids;
}

/** "facts.domain.age_days" and "facts.servers[0].ip" cite `facts.domain` and `facts.servers`; "password_form_cross_origin" cites itself. */
export function validCite(c: string, allowed: ReadonlySet<string>): boolean {
  if (c.length === 0 || c.length > 80) return false;
  const parts = c.replace(/\[\d*\]/g, '').split('.');
  return allowed.has(parts[0] === 'facts' ? parts.slice(0, 2).join('.') : parts[0]!);
}

/**
 * The report as the model sees it: no run id, no artifact names, no owner details. Of Cloudflare's second opinion only
 * the fields of a fixed shape: its "malicious" may be why the verdict was raised; the page's title is left out.
 */
function modelView(r: PublicReport): Record<string, unknown> {
  const so = r.second_opinion;
  const second = so ? { by: 'Cloudflare URL Scanner', malicious: so.malicious, final_host: so.final_host, status: so.status, scanned_at: so.scanned_at } : null;
  return { verdict: r.verdict, confidence: r.confidence, mode: r.mode, summary: r.summary, signals: r.signals, reasons: r.reasons, facts: r.facts, second_opinion: second };
}

const NOTE: Record<ChatReason, string> = {
  hooks_fired: 'The page contains text addressed to an automated reader, so no model was used on this report.',
  page_not_read: 'The page itself was not read, so there is nothing for a model to explain.',
  no_model: 'No model is available right now.',
  budget: 'The daily limit on model use was reached.',
  model_unavailable: 'The model could not be reached.',
  model_output_invalid: 'The model did not give a usable answer.',
  model_output_flagged: 'The model repeated text from the page, so its answer was set aside.',
  question_flagged: 'I can only answer questions about this report.',
};

export function chatNote(reason: ChatReason): string {
  return NOTE[reason];
}

export async function reply(report: PublicReport, input: ChatInput, deps: ChatDeps): Promise<ChatReply> {
  const rules = (reason: ChatReason): ChatReply => ({
    text: input.kind === 'explain' || reason !== 'question_flagged' ? explainPlain(report) : NOTE.question_flagged,
    source: 'rules',
    reason,
  });
  try {
    if (input.kind === 'ask' && scanText('question', input.message).triggered) return rules('question_flagged');
    if (report.injection_attempt) return rules('hooks_fired');
    if (report.verdict === 'unknown') return rules('page_not_read');
    if (!deps.cfg.enabled || !deps.client) return rules('no_model');

    const view = JSON.stringify(modelView(report));
    // the last look before the model, as in assess.ts: the view is made of what the page and the network said
    if (scanText('chat_context', view).triggered) return rules('hooks_fired');

    const nonce = (deps.nonce ?? (() => createHash('sha256').update(`${Math.random()}${Date.now()}`).digest('hex').slice(0, 16)))();
    const question = input.kind === 'explain' ? EXPLAIN_QUESTION : input.message;
    const earlier = input.kind === 'ask' ? input.history.slice(-3) : [];
    const messages: Message[] = [
      { role: 'system', content: deps.prompt.text },
      { role: 'user', content: `The report:\n<untrusted_data id="${nonce}">\n${view}\n</untrusted_data id="${nonce}">` },
      ...earlier.flatMap((t): Message[] => [{ role: 'user', content: `Question: ${t.q}` }, { role: 'assistant', content: t.a }]),
      { role: 'user', content: `Question: ${question}` },
    ];

    if (deps.budget && !deps.budget.tryReserve()) return rules('budget');
    const r = await deps.client.complete(messages, CHAT_SCHEMA);
    if (!r.ok) return rules('model_unavailable');
    deps.budget?.record(r.usage);

    let parsed: unknown;
    try { parsed = JSON.parse(r.content); } catch { return rules('model_output_invalid'); }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return rules('model_output_invalid');
    const { answer, cites } = parsed as { answer?: unknown; cites?: unknown };
    if (typeof answer !== 'string' || answer.length > MAX_ANSWER_RAW || !Array.isArray(cites)) return rules('model_output_invalid');
    const allowed = citable(report);
    const grounded = cites.filter((c): c is string => typeof c === 'string' && validCite(c, allowed));
    const text = cleanAnswer(answer);
    if (text === '' || grounded.length === 0) return rules('model_output_invalid');
    // the model may have repeated what the page told it: its words go through the hooks like any other
    if (scanText('model', text).triggered) return rules('model_output_flagged');
    return { text: text.length > MAX_ANSWER ? `${text.slice(0, MAX_ANSWER - 1)}…` : text, source: 'model', reason: null };
  } catch {
    return rules('model_unavailable');
  }
}
