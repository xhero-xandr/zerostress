import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigError, loadScannerConfig } from '../config.ts';

const ID = '0123456789abcdef0123456789abcdef';
const TOKEN = 'Abc_def-1234567890XYZabcdef0123456789';

test('URL Scanner: both empty is off, both set is on', () => {
  assert.deepEqual(loadScannerConfig({}), { enabled: false, accountId: '', token: '' });
  assert.deepEqual(loadScannerConfig({ CF_URLSCANNER_ACCOUNT_ID: ' ', CF_URLSCANNER_TOKEN: '' }), { enabled: false, accountId: '', token: '' });
  assert.deepEqual(loadScannerConfig({ CF_URLSCANNER_ACCOUNT_ID: ID, CF_URLSCANNER_TOKEN: TOKEN }), { enabled: true, accountId: ID, token: TOKEN });
});

test('URL Scanner: half a configuration or a wrong shape stops the start, and the error never repeats the value', () => {
  const bad: Array<Record<string, string>> = [
    { CF_URLSCANNER_ACCOUNT_ID: ID },
    { CF_URLSCANNER_TOKEN: TOKEN },
    { CF_URLSCANNER_ACCOUNT_ID: 'my-account@example.com', CF_URLSCANNER_TOKEN: TOKEN },
    { CF_URLSCANNER_ACCOUNT_ID: ID.toUpperCase(), CF_URLSCANNER_TOKEN: TOKEN },
    { CF_URLSCANNER_ACCOUNT_ID: ID, CF_URLSCANNER_TOKEN: 'short' },
    { CF_URLSCANNER_ACCOUNT_ID: ID, CF_URLSCANNER_TOKEN: `${TOKEN} extra` },
    { CF_URLSCANNER_ACCOUNT_ID: ID, CF_URLSCANNER_TOKEN: `"${TOKEN}"` },
  ];
  for (const env of bad) {
    assert.throws(() => loadScannerConfig(env), (e: unknown) => {
      assert.ok(e instanceof ConfigError, JSON.stringify(env));
      for (const v of Object.values(env)) assert.ok(!e.message.includes(v.trim()) || v.trim().length < 6, `the error repeats a value: ${e.message}`);
      return true;
    });
  }
});
