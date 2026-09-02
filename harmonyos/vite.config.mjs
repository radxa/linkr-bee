import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const harmonyDir = path.dirname(fileURLToPath(import.meta.url));
const repoDir = path.resolve(harmonyDir, "..");
const webDir = path.join(repoDir, "web");
const rawfileDir = path.join(
  harmonyDir,
  "entry/src/main/resources/rawfile",
);
const distDir = path.join(harmonyDir, "dist");

function inlineArkWebAssets() {
  const indexPath = path.join(distDir, "index.html");
  let html = fs.readFileSync(indexPath, "utf8");

  html = html.replace(
    /<link\s+rel="stylesheet"(?:\s+crossorigin)?\s+href="\.\/([^"?]+\.css)(?:\?[^\"]*)?"\s*\/?>/g,
    (_tag, assetPath) => {
      const css = fs.readFileSync(path.join(distDir, assetPath), "utf8");
      return `<style>\n${css}\n</style>`;
    },
  );

  html = html.replace(
    /<script([^>]*)\s+src="\.\/([^"?]+\.js)(?:\?[^\"]*)?"([^>]*)><\/script>/g,
    (_tag, leadingAttributes, assetPath, trailingAttributes) => {
      const attributes = `${leadingAttributes}${trailingAttributes}`
        .replace(/\s+crossorigin(?:="[^"]*")?/g, "")
        .trim();
      const script = fs
        .readFileSync(path.join(distDir, assetPath), "utf8")
        .replace(/<\/script/gi, "<\\/script");
      return `<script${attributes ? ` ${attributes}` : ""}>\n${script}\n</script>`;
    },
  );

  fs.writeFileSync(indexPath, html);
}

export default {
  root: webDir,
  base: "./",
  plugins: [
    {
      name: "use-harmony-native-bootstrap",
      enforce: "pre",
      resolveId(source) {
        if (
          source === "./native-bootstrap.js" ||
          source === "/native-bootstrap.js" ||
          source.endsWith("/web/native-bootstrap.js")
        ) {
          return path.join(harmonyDir, "src/native-bootstrap.js");
        }
        return null;
      },
    },
    {
      name: "copy-linkr-terminal-vendor",
      closeBundle() {
        fs.cpSync(
          path.join(webDir, "vendor"),
          path.join(distDir, "vendor"),
          { recursive: true },
        );
        inlineArkWebAssets();
        fs.rmSync(rawfileDir, { recursive: true, force: true });
        fs.cpSync(distDir, rawfileDir, {
          recursive: true,
        });
        fs.writeFileSync(
          path.join(rawfileDir, ".gitignore"),
          "*\n!.gitignore\n",
        );
      },
    },
  ],
  build: {
    outDir: distDir,
    emptyOutDir: true,
  },
};
