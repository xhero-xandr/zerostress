// The browser extension (web/extension), built with the client's tools so that it shares the client's texts and log
// sentences (src/text.ts, src/logic.ts). Load build/extension in chrome://extensions ("Load unpacked").
import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import { buildVersion } from './build-version.ts';

const root = resolve(import.meta.dirname, '../extension');
export default defineConfig({
  root,
  base: './',
  define: { __ZS_VERSION__: JSON.stringify(buildVersion()) },
  publicDir: resolve(root, 'public'),
  build: {
    outDir: resolve(import.meta.dirname, '../../build/extension'),
    emptyOutDir: true,
    modulePreload: false,
    rollupOptions: {
      input: { sidepanel: resolve(root, 'sidepanel.html'), background: resolve(root, 'src/background.ts') },
      output: { entryFileNames: (c) => (c.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js') },
    },
  },
});
