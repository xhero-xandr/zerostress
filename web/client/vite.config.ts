/// <reference types="vitest/config" />
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  base: '/',
  plugins: [react(), tailwindcss()],
  // generated files live in the repository's build/ only (spec 010, 4.2)
  build: { outDir: '../../build/client', emptyOutDir: true },
  test: { environment: 'jsdom', include: ['test/**/*.test.{ts,tsx}'] },
});
