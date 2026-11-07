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

test('the extension frames ZeroStress only, and reads no page', () => {
  // no activeTab either: the menu hands over the link it was clicked on, and opening the panel needs only the click
  assert.deepEqual([...manifest.permissions].sort(), ['contextMenus', 'sidePanel', 'storage']);
  assert.equal(manifest.host_permissions, undefined, 'no access to any site: the panel is a frame, not a client');
  assert.equal(manifest.content_scripts, undefined);
  assert.equal(manifest.manifest_version, 3);
  assert.match(manifest.content_security_policy.extension_pages, /frame-src https:\/\/zerostress\.space(;|$)/);
  assert.doesNotMatch(manifest.content_security_policy.extension_pages, /connect-src|unsafe/);
});

test('its id is the one the server lets frame /panel and the panel takes links from (derived from the public key)', () => {
  const hex = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32);
  const id = [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
  const server = readFileSync(new URL('../../server/app.ts', import.meta.url), 'utf8');
  assert.match(server, new RegExp(`EXTENSION_ORIGIN = 'chrome-extension://${id}'`));
  const client = readFileSync(new URL('../../client/src/extension.ts', import.meta.url), 'utf8');
  assert.match(client, new RegExp(`EXTENSION_ORIGIN = 'chrome-extension://${id}'`));
});

test('the manifest fits the Chrome Web Store limits', () => {
  // the store refuses a longer description (132) or name (75), and refuses "key": tools/extension-store.mjs drops it
  assert.ok(manifest.description.length <= 132, `description is ${manifest.description.length} characters`);
  assert.ok(manifest.name.length <= 75, `name is ${manifest.name.length} characters`);
  assert.ok(manifest.short_name.length <= 12);
});
