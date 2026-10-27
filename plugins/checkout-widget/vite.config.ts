import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

// One self-contained script a shop adds to its checkout page: <script src="kyros-checkout.js"></script>.
export default defineConfig({
  define: { global: 'globalThis', 'process.env.NODE_ENV': '"production"' },
  resolve: { alias: { buffer: fileURLToPath(new URL('./node_modules/buffer/index.js', import.meta.url)) } },
  build: {
    target: 'es2020',
    lib: { entry: 'src/main.ts', name: 'KyrosCheckout', formats: ['iife'], fileName: () => 'kyros-checkout.js' },
    rollupOptions: { output: { inlineDynamicImports: true } },
    chunkSizeWarningLimit: 6000,
  },
});
