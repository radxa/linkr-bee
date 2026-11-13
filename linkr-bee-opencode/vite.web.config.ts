/**
 * Builds the plugin's standalone browser console asset.
 *
 * This is the *other* bundle beside `dist/gui-experimental.cjs`: the plugin's
 * own local HTTP server serves `dist/web-console.js` to a plain browser (no
 * OpenCode window, no app-provided modules), so unlike the GUI bundle it must
 * be one self-contained IIFE with every dependency — including xterm and the
 * fit addon — inlined, and the stylesheet injected from a string (`?inline`)
 * so the server only has to serve one file.
 *
 * Built with `npm run build:web`; `npm run build` builds both assets.
 */
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    outDir: 'dist',
    // dist/ also holds the GUI bundle: never wipe it.
    emptyOutDir: false,
    target: 'es2022',
    minify: 'esbuild',
    cssCodeSplit: false,
    lib: {
      entry: 'src/web/main.ts',
      formats: ['iife'],
      name: 'LinkrBeeWebConsole',
      fileName: () => 'web-console.js',
    },
    rollupOptions: {
      output: {
        // One file only: the page server serves exactly `dist/web-console.js`.
        inlineDynamicImports: true,
      },
    },
  },
});
