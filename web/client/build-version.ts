// The build's version for vite's `define`: deploy/release.sh describe, or VERSION alone when git is not at hand.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function buildVersion(): string {
  const root = resolve(import.meta.dirname, '../..');
  try {
    return execFileSync('bash', [resolve(root, 'deploy/release.sh'), 'describe'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return `${readFileSync(resolve(root, 'VERSION'), 'utf8').trim()}+unknown`;
  }
}
