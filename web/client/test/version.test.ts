// The site says which build it is, and offers the extension of its own release.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';
import { BUILD, extensionZip, RELEASE, releasePage } from '../src/version.ts';

const VERSION = readFileSync(resolve(process.cwd(), '../../VERSION'), 'utf8').trim();

test('the build is VERSION, on its release or after it', () => {
  expect(RELEASE).toBe(VERSION);
  expect(BUILD).toMatch(new RegExp(`^${VERSION.replace(/\./g, '\\.')}(\\+[0-9A-Za-z.]+)?$`));
});

test('the extension and the notes are those of this release, by name', () => {
  expect(extensionZip()).toBe(`https://github.com/xhero-xandr/zerostress/releases/download/v${VERSION}/zerostress-extension-${VERSION}.zip`);
  expect(releasePage()).toBe(`https://github.com/xhero-xandr/zerostress/releases/tag/v${VERSION}`);
});
