import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../src/config.ts';

test('session settings: defaults', () => {
  const c = loadConfig({});
  assert.equal(c.sessionSlots, 1);
  assert.equal(c.sessionIdleMs, 60_000);
  assert.equal(c.sessionMaxMs, 300_000);
  assert.equal(c.sessionGraceMs, 30_000);
  assert.equal(c.approvalTtlMs, 300_000);
  assert.equal(c.commandMax, 190);
  assert.equal(c.commandTimeoutMs, 30_000);
});

test('session settings: values are read and converted to milliseconds', () => {
  const c = loadConfig({
    SUP_SESSION_SLOTS: '2',
    SUP_SESSION_IDLE_S: '90',
    SUP_SESSION_MAX_S: '600',
    SUP_SESSION_GRACE_S: '10',
    SUP_APPROVAL_TTL_S: '120',
    SUP_COMMAND_MAX: '50',
    SUP_COMMAND_TIMEOUT_S: '5',
  });
  assert.deepEqual(
    [c.sessionSlots, c.sessionIdleMs, c.sessionMaxMs, c.sessionGraceMs, c.approvalTtlMs, c.commandMax, c.commandTimeoutMs],
    [2, 90_000, 600_000, 10_000, 120_000, 50, 5_000],
  );
});

test('session settings: out-of-range or malformed values stop the service at start', () => {
  const bad: Record<string, string>[] = [
    { SUP_SESSION_SLOTS: '5' },
    { SUP_SESSION_SLOTS: '-1' },
    { SUP_SESSION_IDLE_S: '4' },
    { SUP_SESSION_IDLE_S: '121' },
    { SUP_SESSION_MAX_S: '29' },
    { SUP_SESSION_MAX_S: '601' },
    { SUP_APPROVAL_TTL_S: '9' },
    { SUP_APPROVAL_TTL_S: '3601' },
    // the agent forwards at most 200 lines per job; the supervisor keeps one for its own close
    { SUP_COMMAND_MAX: '200' },
    { SUP_COMMAND_MAX: '0' },
    { SUP_COMMAND_TIMEOUT_S: '0' },
    { SUP_COMMAND_TIMEOUT_S: '121' },
    { SUP_SESSION_SLOTS: 'one' },
    { SUP_COMMAND_MAX: '1.5' },
  ];
  for (const env of bad) assert.throws(() => loadConfig(env), /must be/, JSON.stringify(env));
});

test('zero session slots is allowed and means sessions are switched off', () => {
  assert.equal(loadConfig({ SUP_SESSION_SLOTS: '0' }).sessionSlots, 0);
});
