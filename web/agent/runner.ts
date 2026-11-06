// One task from the address to the answer (spec 008, 5): submit it to the supervisor, read its events through the
// hooks, ask for the verdict, let the model's proposals through the gatekeeper into the live session, and give a result
// that says what happened. The supervisor is the one that opens the page; nothing here touches a page.

import { assess, type Assessment, type Prompt } from './assess.ts';
import type { Budget } from './budget.ts';
import type { AgentConfig } from './config.ts';
import { pickShots, type Shots } from './devices.ts';
import { isIpHost, parseUrl, registrable } from './domain.ts';
import { buildFacts, type Facts } from './facts.ts';
import type { GeoLookup } from './geo.ts';
import type { DomainInfo } from './rdap.ts';
import { createGatekeeper, type Reason } from './gatekeeper.ts';
import type { ModelClient } from './model.ts';
import { SupervisorError, type SupervisorClient } from './supervisor.ts';
import { createGuardedHooks, type GuardedHooks } from '../hooks/index.ts';

type Ev = Record<string, unknown>;
const isObj = (v: unknown): v is Ev => typeof v === 'object' && v !== null && !Array.isArray(v);

const TERMINAL = new Set(['done', 'failed']);
const COMMAND_END = new Set(['done', 'error', 'rejected', 'expired', 'voided', 'timeout']);
const MAX_EVIDENCE_LINE = 1_100_000;
const MAX_EVENTS = 5000;
const SHOT_MAX = 4 * 1024 * 1024;

export interface TaskInput {
  url: string;
  /** keep the page open and let the agent act (needs session slots at the supervisor) */
  session?: { idle_s?: number; max_s?: number };
}

export interface Step {
  id: string;
  action: string;
  line: string;
  risk: 'safe' | 'risky';
  /** what the supervisor reported last about it */
  status: string;
  error?: string;
}

export interface TaskResult {
  schema: 1;
  run_id: string;
  url: string;
  /** the last state of the run at the supervisor */
  state: string;
  /** why a run failed (the supervisor's reason), or why the agent gave up (agent_timeout, stream_lost) */
  failure: string | null;
  assessment: Assessment;
  evidence_events: number;
  /** what the page showed, as plain facts (every string in it comes from the page) */
  facts: Facts;
  hooks: { triggered: boolean; findings: Array<{ rule: string; category: string; strength: string; place: string; layer: number }>; ruleset: string };
  steps: Step[];
  /** actions a person has to decide; the agent never approves anything itself */
  refused: Array<{ proposal: unknown; reason: Reason }>;
  pending_approval: Array<{ command_id: string; cmd: string; sha256: string }>;
  artifacts: Array<{ name: string; bytes: number; sha256: string; mime: string }>;
  /** which of the images is the computer's, the phone's and the tablet's */
  shots: Shots;
  timeline: string[];
  notes: string[];
}

/** What a watcher may learn while the task runs. Our own words and names only: nothing here comes from the page. */
export type Progress =
  | { kind: 'state'; state: string; position: number | null }
  | { kind: 'artifact'; name: string; mime: string }
  | { kind: 'step'; action: string; status: string };

export interface RunnerDeps {
  /** called as the task moves; a failure in it never affects the task */
  onProgress?: (p: Progress) => void;
  sup: SupervisorClient;
  cfg: AgentConfig;
  prompt: Prompt;
  model?: ModelClient;
  budget?: Budget;
  hooks?: () => GuardedHooks;
  /** country and network of an address (geo.ts); without it the report names no places */
  geo?: GeoLookup | null;
  /** when a domain was registered (rdap.ts); without it the age is simply not known */
  rdap?: (domain: string) => Promise<DomainInfo | null>;
  limits?: { totalMs?: number; commandWaitMs?: number; maxReconnects?: number; reconnectDelayMs?: number };
}

export async function runTask(input: TaskInput, deps: RunnerDeps): Promise<TaskResult> {
  const totalMs = deps.limits?.totalMs ?? 240_000;
  const commandWaitMs = deps.limits?.commandWaitMs ?? 45_000;
  const maxReconnects = deps.limits?.maxReconnects ?? 5;
  const reconnectDelayMs = deps.limits?.reconnectDelayMs ?? 300;

  const sub = await deps.sup.submit(input.url, input.session);
  const runId = sub.run_id;
  const hooks = (deps.hooks ?? createGuardedHooks)();
  const gate = createGatekeeper({ maxSteps: deps.cfg.maxSteps });

  const progress = (p: Progress): void => {
    try { deps.onProgress?.(p); } catch { /* a watcher must not break the task */ }
  };
  progress({ kind: 'state', state: sub.state, position: sub.position });

  const events: unknown[] = [];
  const steps: Step[] = [];
  const refused: TaskResult['refused'] = [];
  const pending: TaskResult['pending_approval'] = [];
  const artifacts: TaskResult['artifacts'] = [];
  const timeline: string[] = [];
  const notes: string[] = [];
  let state = sub.state;
  let failure: string | null = null;
  let ready = false;
  let finished = false;
  const waiters = new Map<string, () => void>();
  const wake = (id: string) => { waiters.get(id)?.(); waiters.delete(id); };

  const total = new AbortController();
  const deadline = setTimeout(() => { if (!finished) failure ??= 'agent_timeout'; total.abort(); }, totalMs);
  const screenshots = new Map<string, Buffer>();

  const screenshot = async (): Promise<Buffer | null> => {
    if (!deps.cfg.vision) return null;
    const name = pickShots(events, artifacts).desktop;
    const last = name === null ? undefined : artifacts.find((a) => a.name === name);
    if (!last) return null;
    if (!screenshots.has(last.name)) {
      try {
        screenshots.set(last.name, await deps.sup.artifact(runId, last.name, SHOT_MAX));
      } catch {
        notes.push('the screenshot could not be fetched');
        return null;
      }
    }
    return screenshots.get(last.name)!;
  };

  // The age of the site's domain: asked once per name, started at the beginning so it is ready when the page is. The
  // registry sees only the name. A slow or failed answer means "unknown", never a delay of the task beyond a few seconds.
  const lookups = new Map<string, Promise<DomainInfo | null>>();
  const domainFor = (host: string): Promise<DomainInfo | null> => {
    const name = registrable(host);
    if (!deps.rdap || name === '' || isIpHost(name)) return Promise.resolve(null);
    let p = lookups.get(name);
    if (!p) { p = deps.rdap(name).catch(() => null); lookups.set(name, p); }
    return p;
  };
  const inputHost = parseUrl(input.url)?.hostname ?? '';
  void domainFor(inputHost);
  const finalHost = (): string => {
    for (const e of [...events].reverse()) {
      if (isObj(e) && (e.kind === 'summary' || e.kind === 'page')) {
        const h = parseUrl(e.kind === 'summary' ? e.final_url : e.url)?.hostname;
        if (h) return h;
      }
    }
    return inputHost;
  };
  // one limit for the whole task, counted from its start, so that asking again later never waits again
  const registryUntil = Date.now() + 6000;
  const domainNow = async (): Promise<DomainInfo | null> => {
    let timer: NodeJS.Timeout | undefined;
    const limit = new Promise<null>((res) => { timer = setTimeout(() => res(null), Math.max(0, registryUntil - Date.now())); });
    try { return await Promise.race([domainFor(finalHost()), limit]); } finally { clearTimeout(timer); }
  };

  const assessNow = async (): Promise<Assessment> =>
    assess({ events: [...events], hooks: hooks.state(), screenshot: await screenshot(), domainAgeDays: (await domainNow())?.age_days ?? null }, { cfg: deps.cfg, prompt: deps.prompt, client: deps.model, budget: deps.budget });

  // ---- the agent's part of a session: look, decide, act, look again ----
  async function drive(): Promise<void> {
    let closeNeeded = true;
    for (let i = 0; i < deps.cfg.maxSteps && !finished; i++) {
      const a = await assessNow();
      if (a.mode === 'rules_only' || !a.next) break;
      const d = gate.decide(a.next);
      if (!d.ok) {
        refused.push({ proposal: a.next, reason: d.reason });
        break;
      }
      const id = String(d.command.id);
      const step: Step = { id, action: String(d.command.cmd), line: d.line, risk: d.risk, status: 'sending' };
      steps.push(step);
      const done = new Promise<void>((resolve) => { waiters.set(id, resolve); });
      try {
        const receipt = await deps.sup.command(runId, d.line);
        // the result may have arrived before the receipt did: a finished command is not made unfinished again
        if (!COMMAND_END.has(step.status)) step.status = receipt.status;
        if (d.needsApproval) {
          // a person decides; the session is left open for them (the supervisor closes it when it has been idle)
          pending.push({ command_id: receipt.command_id, cmd: step.action, sha256: receipt.command_sha256 });
          closeNeeded = false;
          break;
        }
      } catch (e) {
        step.status = 'error';
        step.error = e instanceof SupervisorError ? e.code : 'unreachable';
        break;
      }
      await Promise.race([done, new Promise<void>((r) => setTimeout(r, commandWaitMs).unref())]);
      if (!COMMAND_END.has(step.status) && !finished) {
        notes.push(`command ${id} did not finish in time`);
        break;
      }
    }
    if (closeNeeded && !finished) {
      try {
        await deps.sup.command(runId, '{"cmd":"close","id":"close-1"}');
      } catch {
        notes.push('the session could not be closed by the agent; the supervisor will close it');
      }
    }
  }

  let driving: Promise<void> | null = null;

  // ---- reading the run ----
  async function handle(type: string, data: string): Promise<void> {
    if (type === 'state') {
      let s: unknown;
      try { s = JSON.parse(data); } catch { return; }
      if (!isObj(s) || typeof s.state !== 'string') return;
      state = s.state;
      timeline.push(state);
      progress({ kind: 'state', state, position: typeof s.position === 'number' ? s.position : null });
      if (typeof s.reason === 'string' && /^[a-z_]{1,40}$/.test(s.reason)) failure ??= s.reason;
      if (TERMINAL.has(state)) finished = true;
    } else if (type === 'evidence') {
      if (data.length > MAX_EVIDENCE_LINE || events.length >= MAX_EVENTS) return;
      let o: unknown;
      try { o = JSON.parse(data); } catch { return; }
      if (!isObj(o)) return;
      const r = await hooks.inspect(o);
      events.push(r.event);
      gate.observe(r.event);
      const e = r.event as Ev;
      if (e.kind === 'session_ready') {
        ready = true;
        if (input.session && !driving) driving = drive();
      }
      if (e.kind === 'cmd_result' && typeof e.id === 'string') {
        const step = steps.find((x) => x.id === e.id);
        if (step && !COMMAND_END.has(step.status)) step.status = e.ok === true ? 'done' : 'error';
        if (step && e.ok !== true && typeof e.error === 'string') step.error = e.error;
        wake(e.id);
      }
    } else if (type === 'command') {
      let c: unknown;
      try { c = JSON.parse(data); } catch { return; }
      if (!isObj(c) || typeof c.command_id !== 'string' || typeof c.status !== 'string') return;
      const step = steps.find((x) => x.id === c.command_id);
      if (step) {
        step.status = c.status;
        progress({ kind: 'step', action: step.action, status: step.status });
        if (COMMAND_END.has(c.status)) wake(c.command_id);
      }
    } else if (type === 'artifact') {
      let a: unknown;
      try { a = JSON.parse(data); } catch { return; }
      if (isObj(a) && a.saved === true && typeof a.name === 'string' && typeof a.sha256 === 'string' && typeof a.bytes === 'number' && typeof a.mime === 'string') {
        artifacts.push({ name: a.name, bytes: a.bytes, sha256: a.sha256, mime: a.mime });
        progress({ kind: 'artifact', name: a.name, mime: a.mime });
      }
    }
  }

  try {
    let lastSeq = 0;
    for (let attempt = 0; attempt <= maxReconnects && !finished && !total.signal.aborted; attempt++) {
      try {
        for await (const ev of deps.sup.events(runId, lastSeq, total.signal)) {
          if (ev.seq > lastSeq) lastSeq = ev.seq;
          await handle(ev.type, ev.data);
          if (finished) break;
        }
      } catch (e) {
        if (total.signal.aborted) break;
        if (e instanceof SupervisorError && e.code === 'frame_too_large') {
          failure ??= 'stream_refused';
          notes.push('an event was larger than the limit: the run is abandoned');
          break;
        }
        notes.push(`event stream broke: ${e instanceof SupervisorError ? e.code : (e as Error).name}`);
      }
      if (!finished && !total.signal.aborted) await new Promise((r) => setTimeout(r, reconnectDelayMs));
    }
    if (!finished) {
      failure ??= 'stream_lost';
      await deps.sup.cancel(runId).catch(() => notes.push('the run could not be cancelled'));
    }
    finished = true;
    for (const id of [...waiters.keys()]) wake(id);
    if (driving) await driving.catch(() => notes.push('the session driver failed'));
    const assessment = await assessNow();
    const hs = hooks.state();
    return {
      schema: 1,
      run_id: runId,
      url: input.url,
      state,
      failure,
      assessment,
      evidence_events: events.length,
      facts: buildFacts(events, { geo: deps.geo, domain: await domainNow() }),
      hooks: { triggered: hs.triggered, findings: hs.findings.map((f) => ({ rule: f.rule, category: String(f.category), strength: f.strength, place: f.place, layer: f.layer })), ruleset: hs.ruleset },
      steps,
      refused,
      pending_approval: pending,
      artifacts,
      shots: pickShots(events, artifacts),
      timeline,
      notes: [...notes, ...(ready ? [] : input.session ? ['the session never became ready'] : [])],
    };
  } finally {
    clearTimeout(deadline);
    await hooks.close();
  }
}
