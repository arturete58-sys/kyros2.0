import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/**
 * passkey-kit 0.19.1 reads a signer with no expiration as `null`, not
 * `undefined`, and then calls `null.toString()` while connecting the wallet.
 * Treat both as "no expiration". The build fails if the code it fixes changes.
 */
function passkeyKitNoExpiration(): Plugin {
  const from = 'if (expiration !== undefined) {';
  return {
    name: 'passkey-kit-no-expiration',
    enforce: 'pre',
    transform(code, id) {
      if (!/passkey-kit[\\/]dist[\\/]kit\.js$/.test(id)) return null;
      if (!code.includes(from)) throw new Error('passkey-kit changed: review the no-expiration fix in vite.config.ts');
      return code.replace(from, 'if (expiration !== undefined && expiration !== null) {');
    },
  };
}

export default defineConfig({
  // GitHub Pages serves the app at /kyros2.0/.
  base: process.env.KYROS_BASE ?? '/kyros2.0/',
  plugins: [passkeyKitNoExpiration(), react()],
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
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 4000,
    rollupOptions: {
      output: {
        // Libraries change less often than the app: separate files stay cached across releases.
        manualChunks: {
          stellar: ['@stellar/stellar-sdk'],
          react: ['react', 'react-dom'],
        },
      },
    },
  },
});
