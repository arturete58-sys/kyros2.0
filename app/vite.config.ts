import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  // GitHub Pages serves the app at /kyros2.0/.
  base: process.env.KYROS_BASE ?? '/kyros2.0/',
  plugins: [react()],
  define: { global: 'globalThis' },
  resolve: {
    alias: {
      'kyros-sdk': here('../sdk/src/index.ts'),
      // The SDK reads rule packs from disk only in Node; the app imports them as JSON.
      'node:fs': here('./src/stubs/node.ts'),
      'node:path': here('./src/stubs/node.ts'),
      'node:url': here('./src/stubs/node.ts'),
      buffer: here('./node_modules/buffer/index.js'),
    },
    // One copy of the Stellar SDK for the app and the Kyros SDK, so XDR objects are interchangeable.
    dedupe: ['@stellar/stellar-sdk'],
  },
  server: { fs: { allow: ['..'] } },
  build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
});
