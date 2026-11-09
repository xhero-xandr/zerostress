// The assessment of one task (spec 008, 2 and 4): the verdict by the rules first, then, when it is allowed and
// possible, the model's opinion, which can only raise it. Nothing here throws: the verdict by the rules exists before
// the model is asked, and any failure of the model leaves it standing.

import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Budget, Usage } from './budget.ts';
import type { AgentConfig } from './config.ts';
import { buildDossier } from './dossier.ts';
import { parseAnswer, type Answer, type Message, type ModelClient } from './model.ts';
import { analyze, raise, type Signal, type Verdict } from './signals.ts';
import type { FileVerdict, Reputation } from './reputation.ts';
import type { PopularityLookup } from './popularity.ts';
import type { TaskHooks } from './task-hooks.ts';
import { RULESET_SHA256 } from '../hooks/rules.ts';

export type Mode = 'rules_only' | 'text' | 'vision';
export type ModeReason =
  | 'hooks_fired'
  | 'inspection_failed'
  | 'page_not_read'
  | 'no_model_configured'
  | 'budget'
  | 'model_unavailable'
  | 'model_output_invalid'
  | 'model_output_flagged';

export interface Assessment {
  verdict: Verdict;
  confidence: number;
  rules: { verdict: Verdict; score: number; confidence: number; signals: Signal[] };
  /** what the model said, if it was asked and its answer was usable; `lowered` means it asked for less than the rules and was ignored */
  model: { verdict: Answer['verdict']; confidence: number; lowered: boolean } | null;
  mode: Mode;
  mode_reason: ModeReason | null;
  /** the model's words, after the hooks; null when the model did not speak */
  summary: string | null;
  reasons: Array<{ claim: string; evidence: string[] }>;
  /** what the model wants done next; still to be judged by the gatekeeper */
  next: Answer['next'] | null;
  usage: Usage | null;
  notes: string[];
  versions: { ruleset: string; prompt: string; model: string | null };
}

export interface Prompt {
  text: string;
  sha256: string;
}

export function loadPrompt(path: string = fileURLToPath(new URL('./prompts/system.md', import.meta.url))): Prompt {
  const text = readFileSync(path, 'utf8');
  if (text.trim().length < 200) throw new Error('the system prompt is missing or empty');
  return { text, sha256: createHash('sha256').update(text).digest('hex') };
}

export interface AssessDeps {
  cfg: AgentConfig;
  prompt: Prompt;
  client?: ModelClient;
  budget?: Budget;
  /** a fresh, unguessable string per request; tests fix it */
  nonce?: () => string;
  now?: () => number;
  /** how widely visited the final site is (popularity.ts) */
  popularity?: PopularityLookup | null;
}

export interface AssessInput {
  /** the evidence, already inspected by the hooks */
  events: readonly unknown[];
  /** the task's hooks: read for what fired so far, and every scan made here is remembered for the rest of the task */
  hooks: TaskHooks;
  /** the screenshot as a PNG, if there is one and the model should see it */
  screenshot?: Uint8Array | null;
  /** days since the final site's domain was registered, if known */
  domainAgeDays?: number | null;
  /** what Google, Spamhaus and VirusTotal know about the address and its domain (reputation.ts) */
  reputation?: Reputation | null;
  /** what VirusTotal knows about a file the sandbox fetched, by its hash */
  fileReputation?: { virustotal: FileVerdict | null } | null;
}

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const RANK: Record<Verdict, number> = { unknown: 0, benign: 1, suspicious: 2, malicious: 3 };

function isPng(b: Uint8Array): boolean {
  return b.length >= 8 && b.length <= MAX_IMAGE_BYTES && PNG.every((x, i) => b[i] === x);
}

export async function assess(input: AssessInput, deps: AssessDeps): Promise<Assessment> {
  const nowMs = (deps.now ?? Date.now)();
  const rules = analyze(input.events, { injection: input.hooks.injection, now: nowMs, domainAgeDays: input.domainAgeDays, reputation: input.reputation ?? null, fileReputation: input.fileReputation ?? null, popularity: deps.popularity ?? null });
  const notes: string[] = [];
  const result: Assessment = {
    verdict: rules.verdict,
    confidence: rules.confidence,
    rules: { verdict: rules.verdict, score: rules.score, confidence: rules.confidence, signals: rules.signals },
    model: null,
    mode: 'rules_only',
    mode_reason: null,
    summary: null,
    reasons: [],
    next: null,
    usage: null,
    notes,
    versions: { ruleset: RULESET_SHA256, prompt: deps.prompt.sha256, model: deps.cfg.enabled ? deps.cfg.model : null },
  };
  const degrade = (reason: ModeReason, note?: string): Assessment => {
    result.mode = 'rules_only';
    result.mode_reason = reason;
    if (note) notes.push(note);
    return result;
  };

  try {
    const fired = (): ModeReason => (input.hooks.injection ? 'hooks_fired' : 'inspection_failed');
    if (input.hooks.triggered) return degrade(fired());
    // nothing of the site was read (a wall, an error, an empty page): the model would only guess, and a guess must not
    // turn "we could not see" into "suspicious"
    if (rules.verdict === 'unknown') return degrade('page_not_read');
    if (!deps.cfg.enabled || !deps.client) return degrade('no_model_configured');

    const wantsImage = deps.cfg.vision && input.screenshot != null && isPng(input.screenshot);
    if (deps.cfg.vision && input.screenshot != null && !wantsImage) notes.push('screenshot not sent: not a PNG, or too large');
    const mode: 'text' | 'vision' = wantsImage ? 'vision' : 'text';
    const dossier = buildDossier(input.events, rules, mode);
    const text = JSON.stringify(dossier.json);

    // the last look before the model: the dossier is built by us, but it is made of what the page said
    if (await input.hooks.scan('dossier', text)) return degrade(fired(), 'the dossier itself tripped the hooks');

    const nonce = (deps.nonce ?? (() => randomBytes(8).toString('hex')))();
    const body = `Review this dossier.\n<untrusted_data id="${nonce}">\n${text}\n</untrusted_data id="${nonce}">`;
    const messages: Message[] = [
      { role: 'system', content: deps.prompt.text },
      { role: 'user', content: wantsImage ? [{ type: 'text', text: body }, { type: 'image_url', image_url: { url: `data:image/png;base64,${Buffer.from(input.screenshot!).toString('base64')}` } }] : body },
    ];

    let parsed: ReturnType<typeof parseAnswer> | null = null;
    let usage: Usage | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (deps.budget && !deps.budget.tryReserve()) return degrade('budget');
      const r = await deps.client.complete(attempt === 0 ? messages : [...messages, { role: 'user', content: 'Your previous answer did not match the schema. Answer again with only the JSON object.' }]);
      if (!r.ok) {
        notes.push(`model call failed: ${r.reason}`);
        return degrade('model_unavailable');
      }
      deps.budget?.record(r.usage);
      if (r.usage) usage = usage ? { prompt: usage.prompt + r.usage.prompt, completion: usage.completion + r.usage.completion, total: usage.total + r.usage.total } : r.usage;
      parsed = parseAnswer(r.content, dossier.ids);
      if (parsed.ok) break;
      notes.push(`model answer rejected: ${parsed.error}`);
    }
    result.usage = usage;
    if (!parsed || !parsed.ok) return degrade('model_output_invalid');
    const answer = parsed.answer;

    // the model may have repeated what the page told it: its words go through the hooks like any other
    const outputs = [answer.summary, ...answer.reasons.flatMap((x) => [x.claim, ...x.evidence])];
    let flagged = false;
    for (const t of outputs) if (await input.hooks.scan('model', t)) flagged = true;
    if (flagged) return degrade(input.hooks.injection ? 'model_output_flagged' : 'inspection_failed', 'the model\'s own words tripped the hooks; its opinion is ignored');

    result.mode = mode;
    result.mode_reason = null;
    const lowered = RANK[answer.verdict] < RANK[rules.verdict];
    result.model = { verdict: answer.verdict, confidence: answer.confidence, lowered };
    if (lowered) notes.push(`the model proposed "${answer.verdict}", below the rules' "${rules.verdict}": ignored`);
    result.verdict = raise(rules.verdict, answer.verdict);
    if (result.verdict !== rules.verdict) result.confidence = Math.round(Math.min(answer.confidence, 0.9) * 100) / 100;
    result.summary = answer.summary;
    result.reasons = answer.reasons;
    result.next = answer.next.action === 'none' ? null : answer.next;
    if (answer.dropped > 0) notes.push(`${answer.dropped} reason(s) or reference(s) dropped: they cited nothing that was shown`);
    return result;
  } catch (e) {
    // nothing may escape: the verdict by the rules is already in `result`
    notes.push(`internal error: ${(e as Error).name}`);
    return degrade('model_unavailable');
  }
}
