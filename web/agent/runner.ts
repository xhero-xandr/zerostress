// One task from the address to the answer (spec 008, 5): submit it to the supervisor, read its events through the
// hooks, ask for the verdict, let the model's proposals through the gatekeeper into the live session, and give a result
// that says what happened. The supervisor is the one that opens the page; nothing here touches a page.

import { createLog, type LogCode, type LogEntry } from './agent-log.ts';
import type { ScanOpinion } from './urlscan.ts';

/** A second opinion as kept with the task: the title is withheld when it tripped the hooks. */
export type SecondOpinion = ScanOpinion & { title_withheld: boolean; screenshot: boolean };
import { taskHooks } from './task-hooks.ts';
import { landingView } from './evidence.ts';
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
  /** what happened, step by step, with times: our codes and values of fixed shapes only (agent-log.ts) */
  log: LogEntry[];
  /** Cloudflare's URL Scanner on a page the sandbox could not read, asked by the owner afterwards (urlscan.ts) */
  second_opinion?: SecondOpinion;
  notes: string[];
}

/** What a watcher may learn while the task runs. Our own words and names only: nothing here comes from the page. */
export type Progress =
  | { kind: 'state'; state: string; position: number | null }
  | { kind: 'artifact'; name: string; mime: string }
  | { kind: 'step'; action: string; status: string }
  /** a risky command waits for a person: the web layer shows it to the task's owner and passes their decision on */
  | { kind: 'approval'; run_id: string; command_id: string; cmd: string; sha256: string }
  /** the person decided, or the time for it ran out: the command is no longer waiting */
  | { kind: 'decided'; command_id: string; status: string }
  /** one line of the agent's log, as it happens */
  | { kind: 'log'; entry: LogEntry };

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
  limits?: { totalMs?: number; commandWaitMs?: number; approvalWaitMs?: number; maxReconnects?: number; reconnectDelayMs?: number };
}

export async function runTask(input: TaskInput, deps: RunnerDeps): Promise<TaskResult> {
  const totalMs = deps.limits?.totalMs ?? 240_000;
  const commandWaitMs = deps.limits?.commandWaitMs ?? 45_000;
  // how long a person has to decide, and the decided command to finish; the supervisor's own approval time is longer
  const approvalWaitMs = deps.limits?.approvalWaitMs ?? 150_000;
  const maxReconnects = deps.limits?.maxReconnects ?? 5;
  const reconnectDelayMs = deps.limits?.reconnectDelayMs ?? 300;

  const sub = await deps.sup.submit(input.url, input.session);
  const runId = sub.run_id;
  const hooks = (deps.hooks ?? createGuardedHooks)();
  // one latch for the whole task: the page's events and every scan the agent makes (docs/containment.md, rule 9)
  const task = taskHooks(() => hooks.state());
  const gate = createGatekeeper({ maxSteps: deps.cfg.maxSteps });

  const progress = (p: Progress): void => {
    try { deps.onProgress?.(p); } catch { /* a watcher must not break the task */ }
  };
  progress({ kind: 'state', state: sub.state, position: sub.position });
  const log = createLog();
  const note = (code: LogCode, d: Record<string, unknown> = {}) => {
    const entry = log.add(code, d);
    if (entry) progress({ kind: 'log', entry });
  };
  const hostOf = (u: unknown): string => parseUrl(u)?.host ?? '';
  note('submitted', { position: sub.position ?? 0 });
  let asked = 0;
  let hooksNoted = false;
  let inspected = 0;

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
  // the site the link led to, never a page the agent opened later in a deep check (evidence.ts)
  const finalHost = (): string => {
    const summary = [...events].reverse().find((e) => isObj(e) && e.kind === 'summary') as Record<string, unknown> | undefined;
    return parseUrl(summary?.final_url)?.hostname || parseUrl(landingView(events)?.url)?.hostname || inputHost;
  };
  // one limit for the whole task, counted from its start, so that asking again later never waits again
  const registryUntil = Date.now() + 6000;
  const domainNow = async (): Promise<DomainInfo | null> => {
    let timer: NodeJS.Timeout | undefined;
    const limit = new Promise<null>((res) => { timer = setTimeout(() => res(null), Math.max(0, registryUntil - Date.now())); });
    try { return await Promise.race([domainFor(finalHost()), limit]); } finally { clearTimeout(timer); }
  };

  const assessNow = async (): Promise<Assessment> => {
    const shot = await screenshot();
    const step = ++asked;
    const willAsk = deps.cfg.enabled && deps.model !== undefined && !task.triggered;
    if (willAsk) note('model_asked', { model: deps.cfg.model, mode: shot ? 'vision' : 'text', step });
    const t0 = Date.now();
    const a = await assess({ events: [...events], hooks: task, screenshot: shot, domainAgeDays: (await domainNow())?.age_days ?? null }, { cfg: deps.cfg, prompt: deps.prompt, client: deps.model, budget: deps.budget });
    if (a.mode === 'rules_only') note('rules_only', { reason: a.mode_reason ?? 'no_model_configured', verdict: a.rules.verdict, step });
    else note('model_answered', { ms: Date.now() - t0, tokens: a.usage?.total ?? 0, verdict: a.model?.verdict ?? a.verdict, next: a.next?.action ?? 'none', mode: a.mode, step });
    return a;
  };

  // ---- the agent's part of a session: look, decide, act, look again ----
  async function drive(): Promise<void> {
    for (let i = 0; i < deps.cfg.maxSteps && !finished; i++) {
      const a = await assessNow();
      if (a.mode === 'rules_only' || !a.next) break;
      // the page kept streaming while the model was thinking: a proposal made before the hooks fired is not carried out
      if (task.triggered) {
        note('stopped_by_hooks', { action: a.next.action });
        notes.push('the hooks fired while the model was deciding; its proposal was not carried out');
        break;
      }
      const d = gate.decide(a.next);
      if (!d.ok) {
        refused.push({ proposal: a.next, reason: d.reason });
        note('gate_refused', { action: typeof a.next.action === 'string' ? a.next.action : 'unknown', reason: d.reason });
        break;
      }
      const id = String(d.command.id);
      const step: Step = { id, action: String(d.command.cmd), line: d.line, risk: d.risk, status: 'sending' };
      steps.push(step);
      note('gate_allowed', { action: step.action, risk: d.risk });
      const done = new Promise<void>((resolve) => { waiters.set(id, resolve); });
      try {
        const receipt = await deps.sup.command(runId, d.line);
        // the result may have arrived before the receipt did: a finished command is not made unfinished again
        if (!COMMAND_END.has(step.status)) step.status = receipt.status;
        if (d.needsApproval) {
          // A person decides, at the web layer and the supervisor; the agent only waits for the outcome. The session
          // stays open meanwhile (the supervisor's idle clock stops while a command waits for approval). Whatever the
          // outcome, the agent then closes the session, so the report says what happened in it.
          const p = { command_id: receipt.command_id, cmd: step.action, sha256: receipt.command_sha256 };
          pending.push(p);
          note('approval_wait', { action: step.action });
          progress({ kind: 'approval', run_id: runId, ...p });
          if (!COMMAND_END.has(step.status)) await Promise.race([done, new Promise<void>((r) => setTimeout(r, approvalWaitMs).unref())]);
          if (!COMMAND_END.has(step.status)) notes.push(`nobody decided on command ${id} in time`);
          pending.splice(pending.indexOf(p), 1);
          progress({ kind: 'decided', command_id: p.command_id, status: COMMAND_END.has(step.status) ? step.status : 'expired' });
          note('approval_done', { result: COMMAND_END.has(step.status) ? step.status : 'expired' });
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
    if (!finished) {
      try {
        await deps.sup.command(runId, '{"cmd":"close","id":"close-1"}');
      } catch {
        notes.push('the session could not be closed by the agent; the supervisor will close it');
      }
    }
  }

  let driving: Promise<void> | null = null;

  // what the collector did, in the log: hosts and counts only, never the page's words
  function noteEvidence(ev: unknown): void {
    if (!isObj(ev)) return;
    if (ev.kind === 'nav') {
      if (ev.via === 'requested') note('nav_requested', { host: hostOf(ev.to) });
      else if (ev.via === 'http') note('redirect', { from: hostOf(ev.from), to: hostOf(ev.to), ...(typeof ev.status === 'number' ? { status: ev.status } : {}) });
      else if (ev.via === 'scheduled') note('scheduled', { to: hostOf(ev.to), ...(typeof ev.delay_s === 'number' ? { delay_s: Math.round(ev.delay_s) } : {}) });
    } else if (ev.kind === 'page') {
      note('page', { host: hostOf(ev.url), by_session: ready });
    } else if (ev.kind === 'forms') {
      const list = Array.isArray(ev.forms) ? ev.forms : [];
      if (list.length) note('forms', { count: list.length, password: list.some((f) => isObj(f) && f.has_password === true) });
    } else if (ev.kind === 'device') {
      note('device', { device: ev.device });
    } else if (ev.kind === 'download') {
      note('download', { saved: ev.saved === true });
    } else if (ev.kind === 'summary') {
      const reqs = events.filter((x): x is Ev => isObj(x) && x.kind === 'request');
      note('visit_done', { requests: reqs.length, hosts: new Set(reqs.map((q) => hostOf(q.url)).filter(Boolean)).size, blocked: reqs.filter((q) => q.blocked != null && q.blocked !== false).length });
    }
  }

  // ---- reading the run ----
  async function handle(type: string, data: string): Promise<void> {
    if (type === 'state') {
      let s: unknown;
      try { s = JSON.parse(data); } catch { return; }
      if (!isObj(s) || typeof s.state !== 'string') return;
      state = s.state;
      timeline.push(state);
      if (state === 'booting' && isObj(s.vm)) note('vm_booting', { slot: s.vm.slot, vcpu: s.vm.vcpu, mem_mib: s.vm.mem_mib, image: s.vm.image });
      else note('vm_state', { state, ...(typeof s.position === 'number' ? { position: s.position } : {}), ...(typeof s.reason === 'string' ? { reason: s.reason } : {}) });
      progress({ kind: 'state', state, position: typeof s.position === 'number' ? s.position : null });
      if (typeof s.reason === 'string' && /^[a-z_]{1,40}$/.test(s.reason)) failure ??= s.reason;
      if (TERMINAL.has(state)) finished = true;
    } else if (type === 'evidence') {
      if (data.length > MAX_EVIDENCE_LINE || events.length >= MAX_EVENTS) return;
      let o: unknown;
      try { o = JSON.parse(data); } catch { return; }
      if (!isObj(o)) return;
      const r = await hooks.inspect(o);
      inspected++;
      events.push(r.event);
      if (r.findings.length && !hooksNoted) {
        hooksNoted = true;
        note('hooks_fired');
      }
      noteEvidence(r.event);
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
        if (COMMAND_END.has(step.status) || step.status === 'sent') note('command', { action: step.action, state: step.status });
        if (COMMAND_END.has(c.status)) wake(c.command_id);
      }
    } else if (type === 'artifact') {
      let a: unknown;
      try { a = JSON.parse(data); } catch { return; }
      if (isObj(a) && a.saved === true && typeof a.name === 'string' && typeof a.sha256 === 'string' && typeof a.bytes === 'number' && typeof a.mime === 'string') {
        artifacts.push({ name: a.name, bytes: a.bytes, sha256: a.sha256, mime: a.mime });
        progress({ kind: 'artifact', name: a.name, mime: a.mime });
        if (a.mime === 'image/png') note('screenshot');
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
    const hs = { triggered: task.triggered, findings: task.findings(), ruleset: hooks.state().ruleset };
    note('verdict', { verdict: assessment.verdict, by: assessment.mode });
    note('hooks_summary', { inspected, findings: hs.findings.length });
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
      log: log.entries,
      notes: [...notes, ...(ready ? [] : input.session ? ['the session never became ready'] : [])],
    };
  } finally {
    clearTimeout(deadline);
    await hooks.close();
  }
}
