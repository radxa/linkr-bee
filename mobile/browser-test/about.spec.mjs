import { test, expect } from "@playwright/test";
import { ABOUT_DATA } from "../../web/about-data.js";

const shippedComponents = ABOUT_DATA.groups.flatMap((group) => group.components);

/* The About page is a compliance surface: it must be reachable, name the
 * components the build ships, and carry the CC-BY attribution for the cursor
 * artwork. Geometry is checked too, because a 4-column table in a 331 px drawer
 * would be unreadable and nothing else would notice. */

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#panelToggle")).toBeVisible();
});

async function openAbout(page) {
  await page.locator("#panelToggle").tap();
  await page.locator('[data-settings-target="about"]').tap();
  await expect(page.locator("#aboutPage")).toBeVisible();
}

test("the About page lists components, licences and contributors", async ({ page }) => {
  await openAbout(page);
  await expect(page.locator("#controlsPanel")).toHaveAttribute("data-settings-active", "about");
  await expect(page.locator("#aboutMeta")).toContainText("0.1.2");
  await expect(page.locator("#aboutMeta")).toContainText("Apache-2.0");

  // Dependency upgrades can add or remove transitive components.
  await expect(page.locator("#aboutComponents .about-component")).toHaveCount(shippedComponents.length);
  for (const name of ["@earendil-works/pi-agent-core", "@earendil-works/pi-ai"]) {
    const component = shippedComponents.find((item) => item.name === name);
    expect(component).toBeDefined();
    await expect(page.locator("#aboutComponents .about-component").filter({ hasText: name }))
      .toContainText(component.version);
  }
  const components = page.locator("#aboutComponents");
  await expect(components).toContainText("@capacitor/core");
  await expect(components).toContainText("marked");
  await expect(components).toContainText("Zephyr RTOS");
  await expect(components).toContainText("BSD-3-Clause");
  await expect(components).toContainText("MPL-2.0 OR Apache-2.0");

  // The CC-BY-4.0 grant needs the author and a statement of changes on screen,
  // not only in a README the page links to.
  await expect(components).toContainText("CC-BY-4.0");
  await expect(components).toContainText("UnionTech");
  await expect(components).toContainText("XCursor");

  await expect(page.locator("#aboutContributors .about-contributor")).toHaveCount(6);
  await expect(page.locator("#aboutContributors")).toContainText("Novice-PG");
  await expect(page.locator("#aboutRepository")).toHaveAttribute("href", "https://github.com/radxa/linkr-bee");
  await expect(page.locator("#aboutLicenseLink")).toHaveAttribute("href",
    "https://github.com/radxa/linkr-bee/blob/main/LICENSE");

  // A phone drawer must scroll vertically, not sideways.
  const overflow = await page.locator("#controlsPanel").evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(overflow).toBeLessThanOrEqual(3);
});

test("switching sections hides About and the language switch re-renders it", async ({ page }) => {
  await openAbout(page);
  await page.locator('[data-settings-target="connection"]').tap();
  await expect(page.locator("#controlsPanel")).toHaveAttribute("data-settings-active", "connection");
  await expect(page.locator("#aboutPage")).toBeHidden();
  // The connection page now has more than one card (the BLE-name settings are
  // separate); target the original controls card, not an arbitrary first one.
  await expect(page.locator('section[data-i18n-aria="connectionControls"]')).toBeVisible();

  await page.locator('[data-settings-target="about"]').tap();
  await page.locator("#drawerLangButton").tap();
  await expect(page.locator("#aboutTitle")).toHaveText("关于");
  await expect(page.locator("#aboutComponents")).toContainText("运行时");
  await expect(page.locator("#aboutContributors")).toContainText("Novice-PG", "names do not translate");
});

/* The rail layout belongs to pointer devices; the default project viewport is a
 * phone, where the drawer layout hides the rail. Ask for a mouse explicitly. */
test.describe("desktop", () => {
  test.use({ isMobile: false, hasTouch: false, viewport: { width: 1440, height: 900 } });

  test("the rail opens About on a wide window", async ({ page }) => {
    const rail = page.locator('[data-rail-target="about"]');
    await rail.click();
    await expect(page.locator("#aboutPage")).toBeVisible();
    await expect(rail).toHaveAttribute("aria-current", "page");
    await expect(page.locator('section[data-i18n-aria="connectionControls"]')).toBeHidden();
  });
});
