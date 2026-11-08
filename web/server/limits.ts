// Limits on who may start what (spec 007, 5). Access is open to everyone, so cost is held down here and in the daily cap.
// The clock is passed in so the edges can be tested.

export interface LimitConfig {
  perHour: number;
  perDay: number;
  /** tasks one address may have running at once */
  active: number;
  /** open event streams one address may hold */
  streams: number;
  /** tasks the whole service takes in a UTC day */
  dailyCap: number;
  /** tries with a wrong key per minute from one address */
  badKeysPerMinute: number;
  /** questions to the chat one address may ask per hour (the explanation of a report is asked once for everyone) */
  chatPerHour: number;
  /** questions the chat answers about one report, all askers together */
  chatPerReport: number;
}

export const DEFAULT_LIMITS: LimitConfig = { perHour: 5, perDay: 20, active: 1, streams: 4, dailyCap: 300, badKeysPerMinute: 10, chatPerHour: 20, chatPerReport: 12 };

export type Denied = 'rate_hour' | 'rate_day' | 'too_many_active' | 'daily_cap';
export type ChatDenied = 'chat_rate' | 'chat_busy' | 'chat_cap';

export interface Limiter {
  /**
   * reserve a task for this client or say why not; call `release` when the task ends, or `cancel` when it never started
   * (the supervisor refused it): a cancelled start is taken back from the client's and the service's counts
   */
  start(client: string): { ok: true; release: () => void; cancel: () => void } | { ok: false; reason: Denied; retryAfterS: number };
  openStream(client: string): (() => void) | null;
  /** counts a wrong key; true while the client is still within its allowance */
  badKey(client: string): boolean;
  /**
   * Leave to call the model for this client about this report; call `release` when the answer is in. One call at a time per
   * client, `chatPerHour` per hour per client. `counts` is false for the explanation, which is asked once per report and
   * kept, so it takes no question from the report's allowance.
   */
  chat(client: string, reportId: string, counts: boolean): { ok: true; release: () => void } | { ok: false; reason: ChatDenied; retryAfterS: number };
  stats(): { today: number; cap: number };
  /** how many clients the limiter remembers: those with nothing left in any window are forgotten */
  tracked(): number;
}

const HOUR = 3_600_000;
const DAY = 86_400_000;

export function createLimiter(cfg: LimitConfig = DEFAULT_LIMITS, now: () => number = Date.now): Limiter {
  const starts = new Map<string, number[]>();
  const active = new Map<string, number>();
  const streams = new Map<string, number>();
  const bad = new Map<string, number[]>();
  const chats = new Map<string, number[]>();
  const chatBusy = new Set<string>();
  const asked = new Map<string, number>();
  let dayKey = Math.floor(now() / DAY);
  let today = 0;

  const prune = (arr: number[], span: number, t: number): number[] => arr.filter((x) => t - x < span);
  // A client is remembered only while one of its windows holds something: once a minute, the ones whose windows have
  // all run out are dropped, so the maps do not grow with every address that ever came (review, minor).
  let swept = now();
  const sweep = (t: number) => {
    if (t - swept < 60_000) return;
    swept = t;
    for (const [m, span] of [[starts, DAY], [bad, 60_000], [chats, HOUR]] as const) {
      for (const [k, arr] of m) {
        const left = prune(arr, span, t);
        if (left.length === 0) m.delete(k);
        else m.set(k, left);
      }
    }
  };
  const bump = (m: Map<string, number>, k: string, d: number) => {
    const v = (m.get(k) ?? 0) + d;
    if (v <= 0) m.delete(k);
    else m.set(k, v);
  };

  return {
    start(client) {
      const t = now();
      sweep(t);
      const dk = Math.floor(t / DAY);
      if (dk !== dayKey) { dayKey = dk; today = 0; }
      if (today >= cfg.dailyCap) return { ok: false, reason: 'daily_cap', retryAfterS: Math.ceil(((dk + 1) * DAY - t) / 1000) };
      if ((active.get(client) ?? 0) >= cfg.active) return { ok: false, reason: 'too_many_active', retryAfterS: 15 };
      const mine = prune(starts.get(client) ?? [], DAY, t);
      starts.set(client, mine);
      const lastHour = mine.filter((x) => t - x < HOUR);
      if (lastHour.length >= cfg.perHour) return { ok: false, reason: 'rate_hour', retryAfterS: Math.ceil((lastHour[0]! + HOUR - t) / 1000) };
      if (mine.length >= cfg.perDay) return { ok: false, reason: 'rate_day', retryAfterS: Math.ceil((mine[0]! + DAY - t) / 1000) };
      mine.push(t);
      today++;
      bump(active, client, 1);
      let released = false;
      const release = () => { if (!released) { released = true; bump(active, client, -1); } };
      let cancelled = false;
      const cancel = () => {
        if (cancelled) return;
        cancelled = true;
        release();
        const list = starts.get(client);
        const at = list ? list.lastIndexOf(t) : -1;
        if (at >= 0) list!.splice(at, 1);
        if (dayKey === dk && today > 0) today--;
      };
      return { ok: true, release, cancel };
    },
    openStream(client) {
      if ((streams.get(client) ?? 0) >= cfg.streams) return null;
      bump(streams, client, 1);
      let closed = false;
      return () => { if (!closed) { closed = true; bump(streams, client, -1); } };
    },
    badKey(client) {
      const t = now();
      sweep(t);
      const mine = prune(bad.get(client) ?? [], 60_000, t);
      mine.push(t);
      bad.set(client, mine);
      return mine.length <= cfg.badKeysPerMinute;
    },
    chat(client, reportId, counts) {
      const t = now();
      sweep(t);
      if (chatBusy.has(client)) return { ok: false, reason: 'chat_busy', retryAfterS: 5 };
      const mine = prune(chats.get(client) ?? [], HOUR, t);
      chats.set(client, mine);
      if (mine.length >= cfg.chatPerHour) return { ok: false, reason: 'chat_rate', retryAfterS: Math.ceil((mine[0]! + HOUR - t) / 1000) };
      if (counts && (asked.get(reportId) ?? 0) >= cfg.chatPerReport) return { ok: false, reason: 'chat_cap', retryAfterS: 0 };
      mine.push(t);
      if (counts) {
        if (asked.size > 2000) asked.clear(); // reports expire after a day: a reset only gives a few extra questions
        asked.set(reportId, (asked.get(reportId) ?? 0) + 1);
      }
      chatBusy.add(client);
      let released = false;
      return { ok: true, release: () => { if (!released) { released = true; chatBusy.delete(client); } } };
    },
    stats: () => ({ today, cap: cfg.dailyCap }),
    tracked: () => new Set([...starts.keys(), ...bad.keys(), ...chats.keys(), ...active.keys(), ...streams.keys()]).size,
  };
}

/** One bucket per person: an IPv6 address is counted by its /64, because one subscriber holds the whole range. */
export function clientBucket(ip: string): string {
  const v6 = ip.includes(':') && !ip.includes('.');
  if (!v6) return ip.replace(/^::ffff:/i, '');
  const g = ip.toLowerCase().split('::');
  const head = g[0]!.split(':').filter(Boolean);
  const tail = (g[1] ?? '').split(':').filter(Boolean);
  const full = g.length === 1 ? head : [...head, ...new Array<string>(Math.max(0, 8 - head.length - tail.length)).fill('0'), ...tail];
  return full.slice(0, 4).map((x) => x.padStart(4, '0')).join(':') + '::/64';
}
