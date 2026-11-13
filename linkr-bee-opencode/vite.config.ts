/**
 * Builds `dist/gui-experimental.cjs` with the verified OpenCode GUI preset.
 *
 * The preset compiles the Solid JSX, bundles every dependency except the
 * modules the app itself provides (solid-js, @opencode/*, @opencode/plugin/rpc,
 * … — see `@opencode/plugin/gui/vite`), and writes one CommonJS file so the app
 * never has to load a second chunk. `xterm` and `@xterm/addon-fit` are not
 * provided by the app, so they are bundled in.
 */
import { defineConfig } from 'vite';
import { gui } from '@opencode/plugin/gui/vite';

export default defineConfig({
  plugins: [gui()],
  // xterm's stylesheet is imported with `?inline` and contributed through the
  // `Style` registry, so no separate CSS asset may be emitted.
  build: {
    cssCodeSplit: false,
  },
});
