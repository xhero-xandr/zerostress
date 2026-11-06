// The web service: wires the agent, the supervisor client, the store and the limiter into the app and listens on this
// machine only. Everything it needs comes from the environment (spec 007, 4); the key to the model never leaves it.
//
//   WEB_PORT          port on 127.0.0.1 (default 8080)
//   WEB_DATA_DIR      where finished reports are kept (default /var/lib/zerostress-web/tasks)
//   SUP_SOCKET        the supervisor's socket (default /run/zerostress/supervisor.sock)
//   WEB_DEMOS         "label|url;label|url" for the buttons under the input
//   GEO_DIR           DB-IP Lite files (default /var/lib/zerostress-web/geo); without them no place is named
//   WEB_RDAP          off: the age of a domain is not looked up
//   WEB_LIMIT_*       PER_HOUR, PER_DAY, ACTIVE, STREAMS, DAILY_CAP
//   INFERENCE_*, AGENT_*   see agent/config.ts

import { serve } from '@hono/node-server';
import { loadPrompt } from '../agent/assess.ts';
import { createBudget } from '../agent/budget.ts';
import { describeConfig, loadAgentConfig } from '../agent/config.ts';
import { loadChatPrompt, reply as chatReply } from '../agent/chat.ts';
import { loadGeo } from '../agent/geo.ts';
import { createModelClient } from '../agent/model.ts';
import { createRdap } from '../agent/rdap.ts';
import { runTask } from '../agent/runner.ts';
import { createSupervisorClient } from '../agent/supervisor.ts';
import { createApp } from './app.ts';
import { createLimiter, DEFAULT_LIMITS } from './limits.ts';
import { createStore } from './store.ts';
import type { Demo } from './text.ts';

const env = process.env;
const num = (name: string, def: number): number => {
  const raw = env[name];
  if (raw === undefined || raw === '') return def;
  const v = Number(raw);
  if (!Number.isInteger(v) || v < 0) throw new Error(`${name} must be a non-negative integer`);
  return v;
};

const cfg = loadAgentConfig(env);
const prompt = loadPrompt();
const chatPrompt = loadChatPrompt();
const budget = createBudget({ dailyRequests: cfg.dailyRequests, dailyTokens: cfg.dailyTokens });
const model = cfg.enabled ? createModelClient(cfg) : undefined;
const sup = createSupervisorClient({ socketPath: env.SUP_SOCKET ?? '/run/zerostress/supervisor.sock' }, { requestTimeoutMs: 20_000 });

const demos: Demo[] = (env.WEB_DEMOS ?? 'A harmless page|https://example.com/')
  .split(';').map((x) => x.split('|')).filter((x) => x.length === 2 && x[0]!.trim() && x[1]!.trim()).map(([label, url]) => ({ label: label!.trim(), url: url!.trim() }));

const geo = loadGeo(env.GEO_DIR ?? '/var/lib/zerostress-web/geo');
console.log(geo ? 'geo: DB-IP tables loaded' : 'geo: no tables, the report names no countries');
const rdap = env.WEB_RDAP === 'off' ? undefined : createRdap();

const store = createStore(env.WEB_DATA_DIR ?? '/var/lib/zerostress-web/tasks');
const limiter = createLimiter({
  perHour: num('WEB_LIMIT_PER_HOUR', DEFAULT_LIMITS.perHour),
  perDay: num('WEB_LIMIT_PER_DAY', DEFAULT_LIMITS.perDay),
  active: num('WEB_LIMIT_ACTIVE', DEFAULT_LIMITS.active),
  streams: num('WEB_LIMIT_STREAMS', DEFAULT_LIMITS.streams),
  dailyCap: num('WEB_LIMIT_DAILY_CAP', DEFAULT_LIMITS.dailyCap),
  badKeysPerMinute: DEFAULT_LIMITS.badKeysPerMinute,
  chatPerHour: num('WEB_LIMIT_CHAT_PER_HOUR', DEFAULT_LIMITS.chatPerHour),
  chatPerReport: num('WEB_LIMIT_CHAT_PER_REPORT', DEFAULT_LIMITS.chatPerReport),
});

const app = createApp({
  run: (input, onProgress) => runTask(input, { sup, cfg, prompt, model, budget, onProgress, geo, rdap, limits: { totalMs: 240_000 } }),
  fetchShot: (runId, name) => sup.artifact(runId, name, 4 * 1024 * 1024),
  approve: (runId, commandId, sha) => sup.approve(runId, commandId, sha),
  cancel: (runId) => sup.cancel(runId),
  chat: { reply: (report, input) => chatReply(report, input, { cfg, client: model, budget, prompt: chatPrompt }) },
  store,
  limiter,
  demos,
  session: { idle_s: 90, max_s: 240 },
});

setInterval(() => { store.sweep(); }, 10 * 60_000).unref();

const port = num('WEB_PORT', 8080);
serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, (info) => {
  console.log(JSON.stringify({ at: new Date().toISOString(), msg: 'listening', port: info.port, agent: describeConfig(cfg) }));
});
