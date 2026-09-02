import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

const mobileDir = path.dirname(fileURLToPath(import.meta.url));
const repoDir = path.resolve(mobileDir, "..");
const webDir = path.join(repoDir, "web");

export default defineConfig({
  root: webDir,
  base: "./",
  resolve: {
    alias: [
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
