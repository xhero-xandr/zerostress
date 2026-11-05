// The daily ceiling of what the model may cost (spec 008, 6): requests and tokens per UTC day. In memory: a restart
// of the service forgets it, which is stated in the spec; the ceiling guards against runaway use, it is not an invoice.

export interface BudgetLimits {
  dailyRequests: number;
  dailyTokens: number;
}

export interface Usage {
  prompt: number;
  completion: number;
  total: number;
}

export interface Budget {
  /** reserves one request; false when today's ceiling is reached */
  tryReserve(): boolean;
  /** records the tokens a finished call used */
  record(usage: Usage | null): void;
  snapshot(): { day: string; requests: number; tokens: number };
}

export function createBudget(limits: BudgetLimits, now: () => number = Date.now): Budget {
  let day = '';
  let requests = 0;
  let tokens = 0;
  const roll = () => {
    const today = new Date(now()).toISOString().slice(0, 10);
    if (today !== day) {
      day = today;
      requests = 0;
      tokens = 0;
    }
  };
  return {
    tryReserve() {
      roll();
      if (requests >= limits.dailyRequests || tokens >= limits.dailyTokens) return false;
      requests++;
      return true;
    },
    record(usage) {
      roll();
      if (usage && Number.isFinite(usage.total) && usage.total > 0) tokens += Math.floor(usage.total);
    },
    snapshot() {
      roll();
      return { day, requests, tokens };
    },
  };
}
