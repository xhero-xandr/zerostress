// Settings of the agent (spec 008, 6), read from the environment of the service. The key lives only there: on the
// host, in /etc/zerostress/web.env (CLAUDE.md, containment rule 2). A missing key or model is not an error: the
// agent then works by the rules alone.

export interface AgentConfig {
  /** a model can be asked: address, key and model are all set */
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  model: string;
  /** send the screenshot too (the model must read images) */
  vision: boolean;
  timeoutMs: number;
  /** the most the model may write (reasoning included, for models that reason) */
  maxTokens: number;
  /** ask the model not to spend its tokens on a long hidden reasoning: our verdict is by the rules, the model explains */
  thinkingOff: boolean;
  /** repeats after a 429 or a server error */
  retries: number;
  maxConcurrent: number;
  dailyRequests: number;
  dailyTokens: number;
  maxSteps: number;
}

export class ConfigError extends Error {}

type Env = Record<string, string | undefined>;

function int(env: Env, name: string, def: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return def;
  if (!/^\d+$/.test(raw)) throw new ConfigError(`${name} must be a non-negative integer`);
  const v = Number(raw);
  if (v < min || v > max) throw new ConfigError(`${name} must be between ${min} and ${max}`);
  return v;
}

/** Plain http is accepted only for the machine itself (tests, a local gateway). */
function checkBase(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new ConfigError('INFERENCE_BASE_URL is not an address');
  }
  const local = u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) throw new ConfigError('INFERENCE_BASE_URL must be https (http only for the local machine)');
  if (u.username || u.password) throw new ConfigError('INFERENCE_BASE_URL must not carry credentials');
  return url.replace(/\/+$/, '');
}

export function loadAgentConfig(env: Env): AgentConfig {
  const baseUrl = (env.INFERENCE_BASE_URL ?? '').trim();
  const apiKey = (env.INFERENCE_API_KEY ?? '').trim();
  const model = (env.INFERENCE_MODEL ?? '').trim();
  const enabled = baseUrl !== '' && apiKey !== '' && model !== '' && env.AGENT_MODEL !== 'off';
  if (model !== '' && !/^[A-Za-z0-9._:/-]{1,100}$/.test(model)) throw new ConfigError('INFERENCE_MODEL has an unexpected shape');
  return {
    enabled,
    baseUrl: baseUrl === '' ? '' : checkBase(baseUrl),
    apiKey,
    model,
    vision: env.INFERENCE_VISION === '1',
    timeoutMs: int(env, 'AGENT_MODEL_TIMEOUT_S', 30, 1, 300) * 1000,
    maxTokens: int(env, 'AGENT_MODEL_MAX_TOKENS', 2000, 200, 16000),
    thinkingOff: env.AGENT_MODEL_THINKING !== 'default',
    retries: int(env, 'AGENT_MODEL_RETRIES', 2, 0, 5),
    maxConcurrent: int(env, 'AGENT_MODEL_CONCURRENCY', 8, 1, 16),
    dailyRequests: int(env, 'AGENT_DAILY_REQUESTS', 2000, 0, 1_000_000),
    dailyTokens: int(env, 'AGENT_DAILY_TOKENS', 4_000_000, 0, 1_000_000_000),
    maxSteps: int(env, 'AGENT_MAX_STEPS', 5, 0, 20),
  };
}

/** The configuration without the key, for logs and reports. */
export function describeConfig(c: AgentConfig): Record<string, unknown> {
  return { enabled: c.enabled, base: c.baseUrl === '' ? '' : new URL(c.baseUrl).origin, model: c.model, vision: c.vision, timeout_ms: c.timeoutMs, max_tokens: c.maxTokens, thinking_off: c.thinkingOff, retries: c.retries, max_concurrent: c.maxConcurrent };
}
