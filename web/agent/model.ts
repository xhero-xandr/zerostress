// The client of the language model and the strict reading of its answer (spec 008, 4 and 6). The client speaks the
// OpenAI-compatible protocol of Vultr Serverless Inference with plain fetch: one endpoint, nothing else is needed, and
// a service that holds the key should have as few dependencies as it can. The answer is untrusted: it is read
// field by field, and whatever does not fit the schema is dropped, not repaired.

import type { AgentConfig } from './config.ts';
import type { Usage } from './budget.ts';

export type Message = { role: 'system' | 'user' | 'assistant'; content: string | Array<Record<string, unknown>> };

export type ModelResult =
  | { ok: true; content: string; usage: Usage | null }
  | { ok: false; reason: 'timeout' | 'network' | 'rate_limited' | 'server_error' | 'rejected' | 'empty' | 'truncated' | 'bad_response' };

export interface ModelClient {
  /** `format` replaces the verdict schema (the chat asks for a different shape) */
  complete(messages: Message[], format?: ResponseFormat): Promise<ModelResult>;
  inFlight(): number;
}

export interface ResponseFormat {
  name: string;
  schema: Record<string, unknown>;
}

export interface ClientDeps {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export const NEXT_ACTIONS = ['none', 'snapshot', 'scroll', 'screenshot', 'open_link', 'back', 'wait', 'download'] as const;
export const VERDICTS = ['benign', 'suspicious', 'malicious'] as const;

/** The schema asked of the model. Our own reading below does not depend on the model keeping to it. */
export const ANSWER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'confidence', 'summary', 'reasons', 'next'],
  properties: {
    verdict: { type: 'string', enum: [...VERDICTS] },
    confidence: { type: 'number' },
    summary: { type: 'string' },
    reasons: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['claim', 'evidence'],
        properties: { claim: { type: 'string' }, evidence: { type: 'array', items: { type: 'string' } } },
      },
    },
    next: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: { action: { type: 'string', enum: [...NEXT_ACTIONS] }, ref: { type: 'string' }, dy: { type: 'integer' }, ms: { type: 'integer' } },
    },
  },
} as const;

const RETRY_AFTER_MAX_MS = 5000;

const sleepReal = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function createModelClient(cfg: AgentConfig, deps: ClientDeps = {}): ModelClient {
  const doFetch = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? sleepReal;
  let active = 0;
  const waiting: Array<() => void> = [];
  const acquire = async () => {
    if (active < cfg.maxConcurrent) {
      active++;
      return;
    }
    await new Promise<void>((r) => waiting.push(r));
  };
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else active--;
  };
  // the key must not travel into a log or a report even if a server echoes it back
  const scrub = (s: string) => (cfg.apiKey ? s.split(cfg.apiKey).join('***') : s);

  async function once(messages: Message[], format?: ResponseFormat): Promise<{ result: ModelResult; retryAfterMs?: number }> {
    let res: Response;
    try {
      res = await doFetch(`${cfg.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: cfg.model,
          messages,
          max_tokens: cfg.maxTokens,
          temperature: 0,
          // Models that reason spend most of their tokens on it unless told not to, and each family listens to a different
          // field: the service passes both on and ignores the one a model does not know (measured, spec 008, 8)
          ...(cfg.thinkingOff ? { reasoning_effort: 'low', chat_template_kwargs: { enable_thinking: false } } : {}),
          response_format: { type: 'json_schema', json_schema: { name: format?.name ?? 'verdict', strict: true, schema: format?.schema ?? ANSWER_SCHEMA } },
        }),
        signal: AbortSignal.timeout(cfg.timeoutMs),
        redirect: 'error',
      });
    } catch (e) {
      const name = (e as { name?: string }).name;
      return { result: { ok: false, reason: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network' } };
    }
    if (res.status === 429) {
      const ra = Number(res.headers.get('retry-after'));
      return { result: { ok: false, reason: 'rate_limited' }, retryAfterMs: Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, RETRY_AFTER_MAX_MS) : undefined };
    }
    if (res.status >= 500) return { result: { ok: false, reason: 'server_error' } };
    if (res.status !== 200) return { result: { ok: false, reason: 'rejected' } };
    let body: unknown;
    try {
      body = JSON.parse(scrub(await res.text()));
    } catch {
      return { result: { ok: false, reason: 'bad_response' } };
    }
    const choice = (body as { choices?: Array<{ finish_reason?: unknown; message?: { content?: unknown } }> })?.choices?.[0];
    const content = choice?.message?.content;
    const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map((p) => (typeof (p as { text?: unknown })?.text === 'string' ? (p as { text: string }).text : '')).join('') : '';
    // the answer was cut off (or never started: the reasoning used every token): half a JSON is not an answer
    if (choice?.finish_reason === 'length') return { result: { ok: false, reason: 'truncated' } };
    if (text.trim() === '') return { result: { ok: false, reason: 'empty' } };
    const u = (body as { usage?: Record<string, unknown> }).usage;
    const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
    const usage: Usage | null = u ? { prompt: n(u.prompt_tokens), completion: n(u.completion_tokens), total: n(u.total_tokens) || n(u.prompt_tokens) + n(u.completion_tokens) } : null;
    return { result: { ok: true, content: text, usage } };
  }

  return {
    async complete(messages, format) {
      await acquire();
      try {
        let last: ModelResult = { ok: false, reason: 'network' };
        for (let attempt = 0; attempt <= cfg.retries; attempt++) {
          const { result, retryAfterMs } = await once(messages, format);
          last = result;
          if (result.ok) return result;
          // worth another try: a limit, a server error, a broken connection; not a refusal, an empty answer or a timeout
          if (result.reason !== 'rate_limited' && result.reason !== 'server_error' && result.reason !== 'network') break;
          if (attempt < cfg.retries) await sleep(retryAfterMs ?? 500 * 2 ** attempt);
        }
        return last;
      } finally {
        release();
      }
    },
    inFlight: () => active,
  };
}

// ---- the answer ------------------------------------------------------------------------------------------------------

export interface Answer {
  verdict: (typeof VERDICTS)[number];
  confidence: number;
  summary: string;
  reasons: Array<{ claim: string; evidence: string[] }>;
  next: { action: (typeof NEXT_ACTIONS)[number]; ref?: string; dy?: number; ms?: number };
  /** reasons or evidence references that were thrown away */
  dropped: number;
}

export type ParsedAnswer = { ok: true; answer: Answer } | { ok: false; error: string };

const MAX_SUMMARY = 400;
const MAX_CLAIM = 200;
const MAX_REASONS = 8;
const MAX_EVIDENCE = 6;

/** Finds the JSON object in the model's text: a bare object, or one with a fence or words around it. */
export function extractJson(text: string): unknown {
  const t = text.trim();
  const tryParse = (s: string) => {
    try {
      return JSON.parse(s) as unknown;
    } catch {
      return undefined;
    }
  };
  const direct = tryParse(t);
  if (direct !== undefined) return direct;
  // a fenced answer, or one with words around it: the object between the first brace and the last
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  return a >= 0 && b > a ? tryParse(t.slice(a, b + 1)) : undefined;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Reads the answer. `valid` is the set of evidence references that were really shown to the model. */
const EVIDENCE_PATH = /^[a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*|\[\d{1,3}\])*$/;

export function parseAnswer(text: string, valid: ReadonlySet<string>): ParsedAnswer {
  if (text.length > 20_000) return { ok: false, error: 'too long' };
  const raw = extractJson(text);
  if (!isObj(raw)) return { ok: false, error: 'not an object' };
  const verdict = raw.verdict;
  if (typeof verdict !== 'string' || !(VERDICTS as readonly string[]).includes(verdict)) return { ok: false, error: 'verdict' };
  const confidence = raw.confidence;
  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) return { ok: false, error: 'confidence' };
  if (typeof raw.summary !== 'string') return { ok: false, error: 'summary' };
  if (!Array.isArray(raw.reasons)) return { ok: false, error: 'reasons' };

  let dropped = 0;
  const reasons: Answer['reasons'] = [];
  for (const r of raw.reasons.slice(0, MAX_REASONS)) {
    if (!isObj(r) || typeof r.claim !== 'string' || !Array.isArray(r.evidence)) {
      dropped++;
      continue;
    }
    // "forms.cross_origin" or "links[2]" point into the field "forms" or "links": the part before the first dot or bracket
    // must exist, and the rest may only be more field names and indexes, never words of the model's own
    const evidence = r.evidence.filter((e): e is string => typeof e === 'string' && e.length <= 80 && EVIDENCE_PATH.test(e) && valid.has(e.split(/[.[]/, 1)[0]!)).slice(0, MAX_EVIDENCE);
    dropped += r.evidence.length - evidence.length;
    if (evidence.length === 0) {
      dropped++; // a claim that cites nothing that exists is not a reason
      continue;
    }
    reasons.push({ claim: r.claim.slice(0, MAX_CLAIM), evidence });
  }
  dropped += Math.max(0, raw.reasons.length - MAX_REASONS);

  // "next": only an action from the list, only the parameter that action takes; anything else means "none"
  let next: Answer['next'] = { action: 'none' };
  if (isObj(raw.next) && typeof raw.next.action === 'string' && (NEXT_ACTIONS as readonly string[]).includes(raw.next.action)) {
    const action = raw.next.action as (typeof NEXT_ACTIONS)[number];
    next = { action };
    if ((action === 'open_link' || action === 'download') && typeof raw.next.ref === 'string') next.ref = raw.next.ref;
    if (action === 'scroll' && typeof raw.next.dy === 'number') next.dy = raw.next.dy;
    if (action === 'wait' && typeof raw.next.ms === 'number') next.ms = raw.next.ms;
  }
  return {
    ok: true,
    answer: { verdict: verdict as Answer['verdict'], confidence, summary: raw.summary.slice(0, MAX_SUMMARY), reasons, next, dropped },
  };
}
