import {test, expect} from '@playwright/test';

test.use({deviceScaleFactor: 2});

function luminance(rgb) {
  return rgb.map(value => value / 255)
    .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
    .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
}

async function checkGradient(button) {
  const style = await button.evaluate(element => {
    const computed = getComputedStyle(element);
    return {color: computed.color, background: computed.backgroundImage, film: computed.backgroundColor,
      blur: computed.backdropFilter, canvas: computed.getPropertyValue('--bg').trim(),
      surfaces: ['--terminal', '--panel', '--panel-2', '--panel-3'].map(name => computed.getPropertyValue(name).trim())};
  });
  expect(style.background).toContain('linear-gradient');
  expect(style.blur).toContain('blur(');
  const color = value => value.startsWith('#')
    ? [1, 3, 5].map(start => parseInt(value.slice(start, start + 2), 16))
    : value.match(/[\d.]+/g).map(Number);
  const over = (top, base) => top.slice(0, 3).map((value, index) => value * (top[3] ?? 1) + base[index] * (1 - (top[3] ?? 1)));
  const foreground = luminance(color(style.color));
  const stops = [...style.background.matchAll(/rgba?\([^)]+\)/g)].map(match => color(match[0]));
  expect(stops).toHaveLength(2);
  for (const stop of stops) {
    expect(stop[3]).toBeGreaterThan(0);
    expect(stop[3]).toBeLessThanOrEqual(0.3);
  }
  // Account for translucency over each surrounding theme surface, not just
  // the uncomposited RGB values of the gradient stops.
  for (const surface of style.surfaces) {
    const backdrop = over(color(style.film), over(color(surface), color(style.canvas)));
    for (let step = 0; step <= 20; step++) {
      const sample = stops[0].map((value, index) => value + (stops[1][index] - value) * step / 20);
      const background = luminance(over(sample, backdrop));
      const contrast = (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
      expect(contrast).toBeGreaterThanOrEqual(4.5);
    }
  }
  return style.background;
}

for (const theme of ['light', 'dark']) {
  for (const width of [390, 834, 1428]) {
    test(`terminal toolbar ${theme} ${width}px`, async ({page}, testInfo) => {
      await page.setViewportSize({width, height: 1000});
      await page.addInitScript(theme => {
        localStorage.setItem('linkr-theme', theme);
        localStorage.setItem('linkr-lang', 'zh');
      }, theme);
      await page.goto('/');
      const button = page.locator('#agentButton');
      const header = page.locator('#terminalCard .terminal-head');
      await expect(button).toBeVisible();
      await expect(header.locator('.term-hint')).toBeHidden();
      expect(await header.innerText()).not.toContain('xterm.js');
      const initial = await checkGradient(button);
      const bounds = await button.boundingBox();
      await header.screenshot({path: testInfo.outputPath('toolbar.png')});
      await expect.poll(() => header.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);

      await button.hover();
      await checkGradient(button);
      const hovered = await button.boundingBox();
      expect({width: hovered.width, height: hovered.height}).toEqual({width: bounds.width, height: bounds.height});

      await button.focus();
      await page.keyboard.press('Tab');
      await page.keyboard.press('Shift+Tab');
      await expect(button).toBeFocused();
      await expect(button).toHaveCSS('outline-style', 'solid');

      await button.click();
      await expect(button).toHaveAttribute('aria-pressed', 'true');
      /* A narrow window opens the assistant alone, so the terminal toolbar is not
       * on screen until the split is asked for. The same button must still leave
       * Agent mode once it is back. */
      if (width < 960) await page.locator('#agentToggleTerminal').click();
      await expect(button).toBeVisible();
      expect(await checkGradient(button)).not.toBe(initial);
      await expect(button).toHaveCSS('border-top-color', 'rgba(143, 126, 201, 0.5)');
      await button.click();
      await expect(button).toHaveAttribute('aria-pressed', 'false');
    });
  }
}
