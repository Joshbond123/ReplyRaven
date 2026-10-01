import { test as base, expect, chromium } from '@playwright/test';
import { browserOptions } from '../../scripts/lib/test-browser.js';
// Isolate each flow in its own browser process as well as a fresh context.
// Playwright's artifact hooks still capture these contexts automatically.
export const test = base.extend({
  page: async ({ baseURL, viewport }, use) => {
    const browser = await chromium.launch(await browserOptions());
    const context = await browser.newContext({ baseURL, viewport });
    const page = await context.newPage();
    try {
      await use(page);
    } finally {
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
    }
  },
});
export { expect };
