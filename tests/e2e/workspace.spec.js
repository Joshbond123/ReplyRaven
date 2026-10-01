import { test, expect } from './fixtures.js';
import { SCHEMA, rowValues } from '../../lib/core.js';
import { business, review, aiKey } from '../helpers.js';
test.beforeEach(async ({ page }) => {
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
});
async function demo(page) {
  await page.goto('/login.html?demo=true');
  await expect(page.locator('.business-card')).toHaveCount(6);
}
test('landing, default password, guards, expiry, and logout have no redirect loops', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Every review/ })).toBeVisible();
  await page.goto('/dashboard.html');
  await expect(page).toHaveURL(/login\.html$/);
  await page.getByRole('button', { name: 'Forgot your password?' }).click();
  await expect(page.locator('#password-hint')).toContainText('ReplyRaven123');
  await page.locator('#login-password').fill('wrong');
  await page.getByRole('button', { name: 'Sign in to your workspace' }).click();
  await expect(page.locator('#login-error')).toBeVisible();
  await page.locator('#login-password').fill('ReplyRaven123');
  await page.getByRole('button', { name: 'Sign in to your workspace' }).click();
  await expect(page).toHaveURL(/dashboard\.html$/);
  await expect(page.getByRole('heading', { name: 'A home for all your businesses.' })).toBeVisible();
  const expiry = await page.evaluate(() => Number(localStorage.getItem('auth_expiry')));
  expect(expiry - Date.now()).toBeGreaterThan(6.9 * 86400000);
  await page.goto('/');
  await expect(page).toHaveURL(/dashboard\.html$/);
  await page.goto('/login.html');
  await expect(page).toHaveURL(/dashboard\.html$/);
  await page.getByRole('button', { name: 'Log out', exact: true }).click();
  await expect(page).toHaveURL(/index\.html$/);
  await page.evaluate(() => {
    localStorage.setItem('auth', 'true');
    localStorage.setItem('auth_expiry', '1');
  });
  await page.goto('/settings.html');
  await expect(page).toHaveURL(/login\.html$/);
  expect(errors).toEqual([]);
});
test('demo scanning, selection, deduplication, toggles, custom voice, and search', async ({ page }) => {
  await demo(page);
  await page.getByRole('button', { name: 'Scan businesses', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('3 new businesses found');
  await page.locator('.scan-checkbox').first().uncheck();
  await page.getByRole('button', { name: 'Add selected businesses' }).click();
  await expect(page.locator('.business-card')).toHaveCount(8);
  await page.getByRole('button', { name: 'Scan businesses', exact: true }).click();
  await expect(page.locator('.scan-result')).toHaveCount(1);
  await page.getByRole('button', { name: 'Add selected businesses' }).click();
  await expect(page.locator('.business-card')).toHaveCount(9);
  const card = page.locator('[data-business="willow"]');
  await expect(card.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
  await card.getByRole('switch').click();
  await expect(page.locator('[data-business="willow"]').getByRole('switch')).toHaveAttribute(
    'aria-checked',
    'false',
  );
  await page
    .locator('[data-business="willow"]')
    .getByRole('button', { name: /Options/ })
    .click();
  await page.getByRole('button', { name: 'Customize AI voice' }).click();
  await page.locator('#business-prompt').fill('Thank {business_name} customers warmly. {comment}');
  await page.getByRole('button', { name: 'Save voice' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.locator('#global-search').fill('willow');
  await expect(page.locator('.business-card')).toHaveCount(1);
  await page.locator('#global-search').fill('does not exist');
  await expect(page.getByRole('heading', { name: 'No businesses match just yet.' })).toBeVisible();
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(page.locator('.business-card')).toHaveCount(9);
});
test('review filters, AI draft, manual post/edit/delete, WhatsApp, and bulk safety', async ({ page }) => {
  await demo(page);
  await page.locator('[data-business="willow"]').getByRole('link', { name: 'View reviews' }).click();
  await expect(page.getByRole('heading', { name: 'Willow & Oak Café' })).toBeVisible();
  await page.getByRole('button', { name: /1–3 stars/ }).click();
  await expect(page.locator('.review-card')).toHaveCount(2);
  await expect(page.locator('.review-card').first()).toContainText('Needs attention');
  await page.getByRole('button', { name: /^All 24/ }).click();
  const first = page.locator('.review-card').first();
  expect(await first.locator('a[title="Share on WhatsApp"]').getAttribute('href')).toMatch(
    /^https:\/\/wa\.me\/\?text=/,
  );
  await first.getByRole('button', { name: 'Generate AI reply' }).click();
  await expect(page.locator('#reply-text')).not.toHaveValue('');
  await page.getByRole('button', { name: 'Post demo reply' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.review-card').first()).toContainText('Replied');
  await page.locator('.review-card').first().getByRole('button', { name: 'Edit reply' }).click();
  await page.locator('#reply-text').fill('Thanks so much for stopping by!');
  await page.getByRole('button', { name: 'Post demo reply' }).click();
  await expect(page.locator('.review-card').first()).toContainText('Thanks so much for stopping by!');
  await page.locator('.review-card').first().getByRole('button', { name: 'Delete reply' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete reply', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.review-card').first()).toContainText('Unreplied');
  await page.getByRole('button', { name: 'Bulk reply 4–5 stars' }).click();
  await page.getByRole('button', { name: 'Run demo bulk replies' }).click();
  await expect(page.getByRole('dialog')).toContainText('A few more customers, heard.', { timeout: 20000 });
  await page.getByRole('button', { name: 'Back to reviews' }).click();
  await page.getByRole('button', { name: /^Unreplied/ }).click();
  await expect(page.locator('.review-card')).toHaveCount(2);
  await expect(page.locator('.review-card').first()).toContainText('Needs attention');
});
test('AI keys, settings tabs, automation rules, password change, and theme persist', async ({ page }) => {
  await demo(page);
  await page.goto('/settings.html#ai');
  await expect(page.locator('.keys-table tbody tr')).toHaveCount(3);
  await page.locator('#ai-provider').selectOption('gemini');
  await expect(page.locator('#ai-model')).toHaveValue('gemini-2.5-flash');
  await page.getByRole('button', { name: 'Add sample key' }).click();
  await expect(page.locator('.keys-table tbody tr')).toHaveCount(4);
  await page.locator('.keys-table tbody tr').first().getByRole('switch').click();
  await expect(page.locator('.keys-table tbody tr').first().getByRole('switch')).toHaveAttribute(
    'aria-checked',
    'false',
  );
  await page.getByRole('tab', { name: 'GitHub secrets' }).click();
  await page.getByRole('button', { name: 'Generate & reveal JSON' }).click();
  const json = JSON.parse(await page.locator('#ai-keys-json').inputValue());
  expect(json).toHaveLength(3);
  expect(json.every((key) => key.is_active === 'TRUE')).toBe(true);
  await page.getByRole('tab', { name: 'Automation' }).click();
  await page.getByRole('switch', { name: 'Enable scheduled AI replies' }).click();
  await expect(page.getByRole('switch', { name: 'Enable scheduled AI replies' })).toHaveAttribute(
    'aria-checked',
    'false',
  );
  await page.locator('#reply-delay').fill('3');
  await page.getByRole('button', { name: 'Save guardrails' }).click();
  await page.getByRole('tab', { name: 'Account', exact: true }).click();
  await page.getByRole('button', { name: 'Dark', exact: true }).click();
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.locator('#new-password').fill('new-password-123');
  await page.locator('#confirm-password').fill('new-password-123');
  await page.getByRole('button', { name: 'Save preferences' }).click();
  await expect(page.locator('#new-password')).toHaveValue('');
  await page.reload();
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.locator('.sidebar').getByRole('button', { name: 'Log out', exact: true }).click();
  await page.goto('/login.html');
  await page.locator('#login-password').fill('new-password-123');
  await page.getByRole('button', { name: 'Sign in to your workspace' }).click();
  await expect(page).toHaveURL(/dashboard\.html$/);
});
test('mobile and dark mode stay within viewport, with working navigation and dialogs', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await demo(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await expect(page.locator('.sidebar')).toHaveClass(/open/);
  await page.locator('.sidebar').getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: /Switch to dark mode/ }).click();
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.locator('.topbar [data-action="scan"]').click();
  await expect(page.getByRole('dialog')).toBeVisible();
  expect(
    await page.evaluate(() => document.querySelector('.modal').getBoundingClientRect().right <= innerWidth),
  ).toBe(true);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.goto('/business.html');
  await expect(page.locator('.review-card').first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test('OAuth callbacks remove codes from history and block unverified browser exchange', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('client_secret', 'fake-secret');
    localStorage.setItem('client_id', 'fake-client');
  });
  await page.goto('/callback.html?code=test-code&state=unverified');
  await expect(page.locator('#oauth-code')).toHaveValue('test-code');
  await expect(page.getByRole('heading', { name: 'Check your authorization source.' })).toBeVisible();
  await expect(page).toHaveURL(/callback\.html$/);
  await expect(page.locator('#browser-exchange')).toHaveCount(0);
  await page.evaluate(() => {
    sessionStorage.setItem('rr_oauth_state', 'expected');
  });
  await page.goto('/callback.html?code=verified-code&state=expected');
  await expect(page.getByRole('heading', { name: 'One step closer.' })).toBeVisible();
  await expect(page.locator('#browser-exchange')).toHaveCount(1);
  await expect(page).toHaveURL(/callback\.html$/);
});
test('private live Sheets reads and writes use OAuth, RAW, and fresh row values', async ({ page }) => {
  const tables = Object.fromEntries(Object.keys(SCHEMA).map((tab) => [tab, []]));
  tables.Businesses = [business];
  tables.Reviews = [review];
  tables.AI_Keys = [aiKey];
  const writes = [];
  await page.addInitScript(() => {
    localStorage.setItem('auth', 'true');
    localStorage.setItem('auth_expiry', String(Date.now() + 86400000));
    localStorage.setItem('sheet_id', 'private-sheet');
    localStorage.setItem('access_token', 'private-access-token');
  });
  await page.route('https://sheets.googleapis.com/**', async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      body = request.postDataJSON();
    expect(request.headers().authorization).toBe('Bearer private-access-token');
    if (request.method() === 'GET') {
      const range = decodeURIComponent(url.pathname.split('/values/')[1] || '');
      const tab = range.match(/'([^']+)'!/)?.[1];
      await route.fulfill({
        json: tab
          ? { values: [SCHEMA[tab], ...tables[tab].map((row) => rowValues(tab, row))] }
          : {
              sheets: Object.keys(SCHEMA).map((title, index) => ({ properties: { title, sheetId: index } })),
            },
      });
      return;
    }
    writes.push({ url: url.href, body });
    if (url.pathname.endsWith('/values:batchUpdate')) {
      expect(body.valueInputOption).toBe('RAW');
      for (const update of body.data) {
        const [, tab, row] = update.range.match(/'([^']+)'!A(\d+)/);
        tables[tab][Number(row) - 2] = Object.fromEntries(
          SCHEMA[tab].map((key, index) => [key, update.values[0][index]]),
        );
      }
    }
    if (url.pathname.endsWith(':append')) {
      const tab = decodeURIComponent(url.pathname).match(/'([^']+)'!/)?.[1];
      expect(url.searchParams.get('valueInputOption')).toBe('RAW');
      tables[tab].push(
        ...body.values.map((values) =>
          Object.fromEntries(SCHEMA[tab].map((key, index) => [key, values[index]])),
        ),
      );
    }
    await route.fulfill({ json: {} });
  });
  await page.goto('/dashboard.html');
  await expect(page.locator('.business-card')).toHaveCount(1);
  await expect(page.getByRole('heading', { name: 'A café', exact: true })).toBeVisible();
  await page.getByRole('switch', { name: 'Auto-reply for A café' }).click();
  await expect(page.getByRole('switch', { name: 'Auto-reply for A café' })).toHaveAttribute(
    'aria-checked',
    'false',
  );
  expect(tables.Businesses[0].is_auto_reply).toBe('FALSE');
  expect(writes.length).toBeGreaterThan(1);
});
test('GitHub Pages project subpaths retain routes, assets, and exact callback URI', async ({ page }) => {
  await page.route('http://127.0.0.1:3000/ReplyRaven/**', async (route) => {
    const url = new URL(route.request().url());
    url.pathname = url.pathname.replace(/^\/ReplyRaven/, '');
    const response = await page.request.get(url.href);
    await route.fulfill({ response });
  });
  await page.goto('/ReplyRaven/login.html?demo=true');
  await expect(page).toHaveURL(/\/ReplyRaven\/dashboard\.html$/);
  await expect(page.locator('.business-card')).toHaveCount(6);
  await page.goto('/ReplyRaven/settings.html#google');
  await expect(page.locator('#oauth-redirect-uri')).toHaveText(
    'http://127.0.0.1:3000/ReplyRaven/callback.html',
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.topbar .global-search > svg').click();
  await expect(page.getByRole('dialog')).toContainText('Find a business');
  await page.locator('#mobile-search').fill('willow');
  await page.locator('#mobile-search-list').getByRole('link').click();
  await expect(page).toHaveURL(/\/ReplyRaven\/business\.html\?/);
  await expect(page.getByRole('heading', { name: 'Willow & Oak Café' })).toBeVisible();
});
