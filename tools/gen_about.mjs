#!/usr/bin/env node
// Generate web/about-data.js: the component list, licences and contributors the
// About page renders.
//
// Why a generator and not a hand-written list: the versions on that page are
// exactly the ones the app ships, and a stale licence page is a compliance bug.
// The unit test re-runs collectAbout() and compares it with the committed file,
// so bumping a dependency without regenerating this artefact fails CI instead of
// shipping a page that names the old version.
//
// Contributors are curated here on purpose. The real source is `git shortlog`,
// but GitHub Actions checks out with depth 1, so a generated-from-history list
// would be empty in CI. The list below was taken from `git shortlog -sne --all`
// on 2026-10-19, with duplicate identities merged; add a name when a new author
// lands their first commit.
//
//   node tools/gen_about.mjs

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const ABOUT_DATA_FILE = "web/about-data.js";

const PROJECT_LICENSE = "Apache-2.0";
const PROJECT_LICENSE_URL = "https://github.com/radxa/linkr-bee/blob/main/LICENSE";

/* Not in mobile/package.json: the terminal libraries are copied into web/vendor
 * by hand (see web/vendor/README.md), so their versions live here. */
const VENDORED_WEB = [
  { name: "@xterm/xterm", version: "6.0.0", license: "MIT",
    url: "https://github.com/xtermjs/xterm.js" },
  { name: "@xterm/addon-fit", version: "0.11.0", license: "MIT",
    url: "https://github.com/xtermjs/xterm.js" },
];

/* The firmware is built from this repository with Zephyr's west manifest.
 * Versions other than Zephyr's own are the ones that manifest pins, and the
 * allowlist says so. */
const FIRMWARE = [
  { name: "Zephyr RTOS", version: "4.5.0", license: "Apache-2.0",
    url: "https://github.com/zephyrproject-rtos/zephyr" },
  { name: "HAL for Espressif SoCs", version: "pinned by Zephyr 4.5.0", license: "Apache-2.0",
    url: "https://github.com/zephyrproject-rtos/hal_espressif" },
  { name: "Mbed TLS", version: "pinned by Zephyr 4.5.0", license: "Apache-2.0",
    url: "https://github.com/zephyrproject-rtos/mbedtls" },
  { name: "TF-PSA-Crypto", version: "pinned by Zephyr 4.5.0", license: "Apache-2.0",
    url: "https://github.com/zephyrproject-rtos/tf-psa-crypto" },
  { name: "hostap", version: "pinned by Zephyr 4.5.0", license: "BSD-3-Clause",
    url: "https://github.com/zephyrproject-rtos/hostap" },
];

/* Artwork is not a package. The CC-BY-4.0 grant needs the title, the author,
 * the source and a statement of changes, which is what this entry becomes on the
 * page; web/vendor/macaron-cursors/README.md has the long form. */
const ASSETS = [
  { name: "Macaron cursor theme", version: "revision a0c79e3", license: "CC-BY-4.0",
    author: "UnionTech Software Technology Co., Ltd.",
    url: "https://github.com/linuxdeepin/deepin-desktop-theme",
    changes: "Three cursor shapes extracted from the XCursor bundles and converted to PNG.",
    licenseFile: "vendor/macaron-cursors/LICENSE-CC-BY-4.0.txt" },
  { name: "BabelStone Pseudographica (subset)", version: "16.0.0", license: "OFL-1.1",
    author: "Andrew West",
    url: "https://www.babelstone.co.uk/Fonts/Pseudographica.html",
    changes: "Subset to U+1CC00–U+1CEBF and U+1FB00–U+1FBFF, scaled horizontally to half-width for terminal cells, and renamed Linkr Legacy Computing.",
    licenseFile: "fonts/OFL.txt" },
];

const CONTRIBUTORS = [
  "Novice-PG",
  "xzl",
  "HarryLoong",
  "dfsjklw",
  "Anupam Mediratta",
  "rock",
];

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

/* Installed metadata is the truth for what is actually shipped; package.json
 * ranges can be wider than the tree (e.g. "^8.0.0" installed 8.5.1). */
function installedVersion(root, name) {
  try {
    return readJson(path.join(root, "mobile/node_modules", name, "package.json")).version;
  } catch {
    return null;
  }
}

function installedLicense(root, name) {
  try {
    return readJson(path.join(root, "mobile/node_modules", name, "package.json")).license || "unknown";
  } catch {
    return "unknown";
  }
}

function normalizeUrl(value) {
  if (!value) return "";
  let url = String(value)
    .replace(/^git\+/, "")
    .replace(/^git:\/\//, "https://")
    .replace(/^github:/, "https://github.com/")
    .replace(/\.git$/, "")
    .replace(/\/$/, "");
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(url)) url = `https://github.com/${url}`;
  return url;
}

function packageUrl(root, name) {
  try {
    const manifest = readJson(path.join(root, "mobile/node_modules", name, "package.json"));
    const repo = typeof manifest.repository === "string"
      ? manifest.repository : manifest.repository?.url;
    return normalizeUrl(repo) || `https://www.npmjs.com/package/${name}`;
  } catch {
    return `https://www.npmjs.com/package/${name}`;
  }
}

export function collectAbout(root) {
  const pkg = readJson(path.join(root, "mobile/package.json"));
  const bundled = readJson(path.join(root, "web/vendor/agent/BUILD.json")).packages || {};
  const runtimeNames = Object.keys(pkg.dependencies || {}).sort();
  const direct = runtimeNames
    .filter((name) => !name.startsWith("@earendil-works/"))
    .map((name) => ({
      name,
      version: installedVersion(root, name) || String(pkg.dependencies[name]).replace(/^[\^~]/, ""),
      license: installedLicense(root, name),
      url: packageUrl(root, name),
    }));
  // pi-* are shown with the rest of the bundle, which is where they are compiled
  // into a single artefact; listing them twice would read as two copies.
  const bundleOnly = Object.entries(bundled)
    .filter(([name]) => !runtimeNames.includes(name))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, fallback]) => ({
      name,
      version: installedVersion(root, name) || fallback,
      license: installedLicense(root, name),
      url: packageUrl(root, name),
    }));
  const bundledRuntime = runtimeNames
    .filter((name) => name.startsWith("@earendil-works/"))
    .map((name) => ({
      name,
      version: installedVersion(root, name) || String(pkg.dependencies[name]).replace(/^[\^~]/, ""),
      license: installedLicense(root, name),
      url: packageUrl(root, name),
    }));

  return {
    app: {
      name: "Linkr Bee Terminal",
      version: pkg.version,
      license: PROJECT_LICENSE,
      licenseUrl: PROJECT_LICENSE_URL,
      repository: "https://github.com/radxa/linkr-bee",
      issues: "https://github.com/radxa/linkr-bee/issues",
      // The page is shipped in three shells; the same bundle runs in all of them.
      platforms: ["browser", "iOS", "Android", "HarmonyOS"],
    },
    groups: [
      { id: "runtime", components: [...direct, ...VENDORED_WEB, ...bundledRuntime, ...bundleOnly] },
      { id: "firmware", components: FIRMWARE },
      { id: "assets", components: ASSETS },
    ],
    contributors: CONTRIBUTORS,
  };
}

export function renderAboutModule(data) {
  return `// Generated by tools/gen_about.mjs — edit the generator, not this file.
//
// The version strings below are what this tree ships; mobile/test/about.test.mjs
// regenerates the object and fails when it differs, so a dependency bump that
// forgets to regenerate this file cannot reach a release.

export const ABOUT_DATA = ${JSON.stringify(data, null, 2)};
`;
}

// A plain `node tools/gen_about.mjs` regenerates the file; importing the module
// (the unit test) must not write anything.
if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const target = path.join(root, ABOUT_DATA_FILE);
  writeFileSync(target, renderAboutModule(collectAbout(root)));
  console.log(`wrote ${ABOUT_DATA_FILE}`);
}
