import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

const mobileDir = path.dirname(fileURLToPath(import.meta.url));
const repoDir = path.resolve(mobileDir, "..");
const webDir = path.join(repoDir, "web");
const browserDependencies = ["@capacitor/core", "@capacitor-community/bluetooth-le",
  "@earendil-works/pi-agent-core", "@earendil-works/pi-ai",
  // Every provider the runtime can stream from has to be listed: one missing
  // adapter is discovered on the first chat that selects it, and Vite answers a
  // late discovery by reloading the page underneath the running session.
  "@earendil-works/pi-ai/api/openai-completions",
  "@earendil-works/pi-ai/api/anthropic-messages",
  "@earendil-works/pi-ai/api/google-generative-ai",
  "@earendil-works/pi-ai/utils/event-stream",
  "@earendil-works/pi-ai/utils/retry",
  "@earendil-works/pi-ai/utils/overflow"];

export default defineConfig({
  root: webDir,
  base: "./",
  cacheDir: path.join(mobileDir, "node_modules/.vite"),
  server: {
    headers: { "Cache-Control": "no-store" },
  },
  optimizeDeps: {
    // Prebundle lazy agent dependencies before the first chat. Discovering
    // these after startup would make Vite reload an active serial session.
    include: browserDependencies,
  },
  resolve: {
    alias: [
      // The Vite root is web/, but npm dependencies live under mobile/.
      ...browserDependencies.map((name) => ({
        find: new RegExp(`^${name}$`),
        replacement: fileURLToPath(import.meta.resolve(name)),
      })),
      {
        find: "/native-bootstrap.js",
        replacement: path.join(mobileDir, "src/native-bootstrap.ts"),
      },
      {
        find: path.join(webDir, "native-bootstrap.js"),
        replacement: path.join(mobileDir, "src/native-bootstrap.ts"),
      },
    ],
  },
  plugins: [
    {
      name: "use-capacitor-native-bootstrap",
      enforce: "pre",
      resolveId(source) {
        if (source === "./agent_runtime.js" || source.endsWith("/web/agent_runtime.js")) {
          return path.join(mobileDir, "src/agent-runtime.mjs");
        }
        if (
          source === "./native-bootstrap.js" ||
          source === "/native-bootstrap.js" ||
          source.endsWith("/web/native-bootstrap.js")
        ) {
          return path.join(mobileDir, "src/native-bootstrap.ts");
        }
        return null;
      },
    },
    {
      name: "copy-linkr-terminal-vendor",
      closeBundle() {
        fs.cpSync(
          path.join(webDir, "vendor"),
          path.join(mobileDir, "dist/vendor"),
          { recursive: true },
        );
      },
    },
  ],
  build: {
    outDir: path.join(mobileDir, "dist"),
    emptyOutDir: true,
  },
});
