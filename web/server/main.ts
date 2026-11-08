// The web service: wires the agent, the supervisor client, the store and the limiter into the app and listens on this
// machine only. Everything it needs comes from the environment (spec 007, 4); the key to the model never leaves it.
//
// Every path defaults to a place under the project root, the directory two levels above this file (/zerostress on the
// server, the checkout on a developer's machine), so the same code runs in both without settings (spec 010):
//   WEB_PORT          port on 127.0.0.1 (default 8080)
//   WEB_DATA_DIR      finished reports (default <root>/data/web/tasks)
//   WEB_CLIENT_DIR    the built client (default <root>/build/client)
//   SUP_SOCKET        the supervisor's socket (default <root>/run/supervisor.sock)
//   WEB_DEMOS         "label|url;label|url" for the buttons under the input
//   GEO_DIR           DB-IP Lite files (default <root>/data/geo); without them no place is named
//   WEB_RDAP          off: the age of a domain is not looked up
//   WEB_LIMIT_*       PER_HOUR, PER_DAY, ACTIVE, STREAMS, DAILY_CAP, CHAT_PER_HOUR, CHAT_PER_REPORT
//   INFERENCE_*, AGENT_*   see agent/config.ts

import { serve } from '@hono/node-server';
import { fileURLToPath } from 'node:url';
import { loadPrompt } from '../agent/assess.ts';
import { warmGuarded } from '../hooks/index.ts';
import { createBudget } from '../agent/budget.ts';
import { describeConfig, loadAgentConfig, loadScannerConfig } from '../agent/config.ts';
import { createUrlScanClient } from '../agent/urlscan.ts';
import { loadChatPrompt, reply as chatReply } from '../agent/chat.ts';
import { loadGeo } from '../agent/geo.ts';
import { createModelClient } from '../agent/model.ts';
import { createRdap } from '../agent/rdap.ts';
import { createReputation } from '../agent/reputation.ts';
import { runTask } from '../agent/runner.ts';
import { createSupervisorClient } from '../agent/supervisor.ts';
import { createApp } from './app.ts';
import { createLimiter, DEFAULT_LIMITS } from './limits.ts';
import { createStore } from './store.ts';
import type { Demo } from './text.ts';
import { DEFAULT_DEMOS, parseDemos } from './demo.ts';
import { createSenderCheck } from './sender.ts';

const env = process.env;
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const num = (name: string, def: number): number => {
  const raw = env[name];
  if (raw === undefined || raw === '') return def;
  const v = Number(raw);
  if (!Number.isInteger(v) || v < 0) throw new Error(`${name} must be a non-negative integer`);
  return v;
};

const cfg = loadAgentConfig(env);
// checked at start even before anything uses it, so a broken value shows up now and not in the middle of a check
const scanner = loadScannerConfig(env);
const urlscan = scanner.enabled ? createUrlScanClient(scanner) : undefined;
const prompt = loadPrompt();
const chatPrompt = loadChatPrompt();
const budget = createBudget({ dailyRequests: cfg.dailyRequests, dailyTokens: cfg.dailyTokens });
const model = cfg.enabled ? createModelClient(cfg) : undefined;
const sup = createSupervisorClient({ socketPath: env.SUP_SOCKET ?? `${ROOT}run/supervisor.sock` }, { requestTimeoutMs: 20_000 });

const demos: Demo[] = parseDemos(env.WEB_DEMOS ?? DEFAULT_DEMOS);

const geo = loadGeo(env.GEO_DIR ?? `${ROOT}data/geo`);
console.log(geo ? 'geo: DB-IP tables loaded' : 'geo: no tables, the report names no countries');
const rdap = env.WEB_RDAP === 'off' ? undefined : createRdap();
const reputation = createReputation({ safeBrowsing: env.SAFE_BROWSING_API_KEY || undefined, virustotal: env.VIRUSTOTAL_API_KEY || undefined, spamhausDqs: env.SPAMHAUS_DQS_KEY || undefined, urlscan: env.URLSCAN_API_KEY || undefined });

const store = createStore(env.WEB_DATA_DIR ?? `${ROOT}data/web/tasks`);
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
  ...(urlscan ? { urlscan } : {}),
  clientDir: (env.WEB_CLIENT_DIR ?? `${ROOT}build/client`).replace(/\/?$/, '/'),
  run: (input, onProgress) => runTask(input, { sup, cfg, prompt, model, budget, onProgress, geo, rdap, reputation, limits: { totalMs: 240_000 } }),
  fetchShot: (runId, name) => sup.artifact(runId, name, 4 * 1024 * 1024),
  approve: (runId, commandId, sha) => sup.approve(runId, commandId, sha),
  reject: (runId, commandId) => sup.reject(runId, commandId),
  chat: { reply: (report, input) => chatReply(report, input, { cfg, client: model, budget, prompt: chatPrompt }) },
  store,
  limiter,
  demos,
  session: { idle_s: 90, max_s: 240 },
  publicUrl: env.WEB_PUBLIC_URL ?? 'https://zerostress.space',
  sender: createSenderCheck({ rdap, reputation }),
  ...(reputation.enabled ? { fileReputation: (sha256: string) => reputation.file(sha256) } : {}),
});

setInterval(() => { store.sweep(); }, 10 * 60_000).unref();

const port = num('WEB_PORT', 8080);
// the hooks thread for chat questions and second opinions boots now, not on the first visitor's request
warmGuarded();
serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, (info) => {
  console.log(JSON.stringify({ at: new Date().toISOString(), msg: 'listening', port: info.port, agent: describeConfig(cfg), url_scanner: scanner.enabled }));
});
