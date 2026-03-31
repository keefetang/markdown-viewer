import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  plugins: [svelte()],
  root: 'src',
  publicDir: false,
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    target: 'es2022',
    // KaTeX lazy chunk is ~800kb — intentional, only loaded when math detected
    chunkSizeWarningLimit: 900,
  },
});
