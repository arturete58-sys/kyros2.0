import { defineConfig, transformWithEsbuild, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

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

/**
 * Ships each language's strings as its own small file. The strings are edited
 * in one place (src/i18n-strings.ts, every language side by side); this plugin
 * turns that file into `virtual:kyros-i18n/<lang>`, a plain key -> text map for
 * one language, falling back to English for any missing string.
 */
function i18nPerLanguage(): Plugin {
  const prefix = 'virtual:kyros-i18n/';
  const file = here('./src/i18n-strings.ts');
  return {
    name: 'kyros-i18n-per-language',
    resolveId: (id) => (id.startsWith(prefix) ? `\0${id}` : null),
    async load(id) {
      if (!id.startsWith(`\0${prefix}`)) return null;
      const lang = id.slice(prefix.length + 1);
      this.addWatchFile(file);
      // The strings file is data only: compile it and read its export.
      const { code } = await transformWithEsbuild(readFileSync(file, 'utf8'), file, { loader: 'ts', format: 'cjs' });
      const mod: { exports: { D?: Record<string, Record<string, string>> } } = { exports: {} };
      new Function('module', 'exports', code)(mod, mod.exports);
      const all = mod.exports.D;
      if (!all) throw new Error('src/i18n-strings.ts must export D');
      const one = Object.fromEntries(Object.entries(all).map(([k, e]) => [k, e[lang] ?? e.en]));
      return `export default JSON.parse(${JSON.stringify(JSON.stringify(one))});`;
    },
  };
}

export default defineConfig({
  // GitHub Pages serves the app at /kyros2.0/.
  base: process.env.KYROS_BASE ?? '/kyros2.0/',
  plugins: [passkeyKitNoExpiration(), i18nPerLanguage(), react()],
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
