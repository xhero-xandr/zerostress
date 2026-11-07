import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { webLink } from '../src/link.ts';

test('a web link is taken whole', () => {
  assert.equal(webLink('https://paypa1-secure.test/login?x=1&y=2#frag'), 'https://paypa1-secure.test/login?x=1&y=2#frag');
  assert.equal(webLink('  http://example.com  '), 'http://example.com/');
});

test('anything that is not a web address is not taken', () => {
  for (const x of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'chrome://settings', 'mailto:a@b.c', 'not a url', '', null, `https://x.example/${'a'.repeat(2100)}`]) assert.equal(webLink(x), null, String(x).slice(0, 40));
});

test('a link to ZeroStress itself needs no check', () => {
  assert.equal(webLink('https://zerostress.space/r/0123'), null);
});

const manifest = JSON.parse(readFileSync(new URL('../public/manifest.json', import.meta.url), 'utf8'));

test('the extension may reach ZeroStress only, and reads no page', () => {
  assert.deepEqual([...manifest.permissions].sort(), ['activeTab', 'contextMenus', 'sidePanel', 'storage']);
  assert.deepEqual(manifest.host_permissions, ['https://zerostress.space/*']);
  assert.equal(manifest.content_scripts, undefined);
  assert.equal(manifest.manifest_version, 3);
  assert.match(manifest.content_security_policy.extension_pages, /connect-src https:\/\/zerostress\.space(;|$)/);
});

test('its id is the one the server lets in (derived from the public key in the manifest)', () => {
  const hex = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32);
  const id = [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
  const server = readFileSync(new URL('../../server/app.ts', import.meta.url), 'utf8');
  assert.match(server, new RegExp(`EXTENSION_ORIGIN = 'chrome-extension://${id}'`));
});
