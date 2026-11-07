import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { checkUrl, SERVICE } from '../link.js';

test('a web link becomes the check page, with the link handed over whole', () => {
  assert.equal(checkUrl('https://paypa1-secure.test/login?x=1&y=2#frag'), `${SERVICE}?u=${encodeURIComponent('https://paypa1-secure.test/login?x=1&y=2#frag')}`);
  assert.equal(checkUrl('  http://example.com  '), `${SERVICE}?u=${encodeURIComponent('http://example.com/')}`);
});

test('anything that is not a web address is not sent anywhere', () => {
  for (const x of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'chrome://settings', 'mailto:a@b.c', 'not a url', '', null, `https://x.example/${'a'.repeat(2100)}`]) assert.equal(checkUrl(x), null, String(x).slice(0, 40));
});

test('a link to ZeroStress itself needs no check', () => {
  assert.equal(checkUrl('https://zerostress.space/r/0123'), null);
});

test('the extension asks for no access to the pages a person visits', () => {
  const m = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
  assert.deepEqual(m.permissions.sort(), ['activeTab', 'contextMenus']);
  assert.equal(m.host_permissions, undefined);
  assert.equal(m.content_scripts, undefined);
  assert.equal(m.manifest_version, 3);
});
