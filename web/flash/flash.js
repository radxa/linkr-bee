/* The flashing page reads ./firmware/index.json, which the Pages workflow
 * builds from the release's firmware zips (see tools/build_flasher.py). Boards
 * are data, not markup: adding a board is a generator change, not an HTML one.
 *
 * Everything is built with DOM calls and textContent — the manifest comes from
 * our own CI, but a page that flashes firmware should not paste fetched strings
 * into innerHTML. */

const boards = document.getElementById("boards");
const meta = document.getElementById("buildMeta");

function boardCard(board) {
  const card = document.createElement("article");
  card.className = "card board";

  const title = document.createElement("h2");
  title.textContent = board.name;

  const chip = document.createElement("span");
  chip.className = "chip";
  chip.textContent = board.chip;

  const hint = document.createElement("p");
  hint.className = "hint";
  hint.textContent = board.hint || "";

  const button = document.createElement("esp-web-install-button");
  button.setAttribute("manifest", board.manifest);
  button.setAttribute("install-supported", "");
  // Shown by the button itself when Web Serial is missing or the port is busy.
  button.setAttribute("show-log", "");

  card.append(title, chip, hint, button);
  return card;
}

function notice(text) {
  const p = document.createElement("p");
  p.className = "empty";
  p.textContent = text;
  return p;
}

async function main() {
  let index;
  try {
    const response = await fetch("./firmware/index.json", { cache: "no-cache" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    index = await response.json();
  } catch (error) {
    meta.textContent = "";
    boards.setAttribute("aria-busy", "false");
    boards.append(notice(`读不到固件清单（${error.message}）。可以从发布页下载 zip，用 flash_firmware.sh 刷写。`));
    return;
  }

  meta.textContent = `固件 ${index.version} · ${index.boards.length} 个型号`;
  boards.setAttribute("aria-busy", "false");

  await customElements.whenDefined("esp-web-install-button");
  for (const board of index.boards) boards.append(boardCard(board));
}

main();
