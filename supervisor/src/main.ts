import { chmodSync, mkdirSync, rmSync } from 'node:fs';
import { createApi } from './api.ts';
import { LinuxBackend, freeGbOf, imageShaFrom } from './backend.ts';
import { loadConfig } from './config.ts';
import { stdoutLogger as log } from './logger.ts';
import { ResultFiles, Store } from './store.ts';
import { Supervisor } from './supervisor.ts';

const config = loadConfig();
mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
mkdirSync(config.runsDir, { recursive: true, mode: 0o700 });

const store = new Store(config.dbPath);
const results = new ResultFiles(config.resultsDir);
const backend = new LinuxBackend(config, log);
const sup = new Supervisor({
  config,
  store,
  results,
  backend,
  log,
  freeGb: freeGbOf(config.stateDir),
  imageSha256: imageShaFrom(config.imageDir),
});

await sup.start();

const server = createApi(sup, config, log);
rmSync(config.socketPath, { force: true }); // stale socket of a previous process
await new Promise<void>((resolve, reject) => {
  server.once('error', reject);
  server.listen(config.socketPath, resolve);
});
// access is granted by file permissions: owner and group (zerostress-ipc, the web layer), nobody else
chmodSync(config.socketPath, 0o660);
log('info', 'supervisor listening', { socket: config.socketPath, concurrency: config.concurrency, queue_max: config.queueMax });

let stopping = false;
async function stop(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  log('info', 'shutting down', { signal });
  server.close();
  await sup.shutdown();
  server.closeAllConnections();
  store.close();
  process.exit(0);
}
process.on('SIGTERM', () => void stop('SIGTERM'));
process.on('SIGINT', () => void stop('SIGINT'));

// anything unexpected: crash loudly and let systemd restart us, startup recovery cleans up
process.on('uncaughtException', (e) => {
  log('error', 'uncaught exception', { detail: String(e?.stack ?? e).slice(0, 500) });
  process.exit(1);
});
process.on('unhandledRejection', (e) => {
  log('error', 'unhandled rejection', { detail: String(e).slice(0, 500) });
  process.exit(1);
});
