import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { browserOptions } from '../scripts/browser-options.js';
const origin = process.env.VERIFICATION_SITE_URL || 'http://127.0.0.1:3000/';
const password =
  process.env.LOCAL_OWNER_PASSWORD ||
  JSON.parse(await readFile('.cache/local/owner-access.json', 'utf8')).password;
const browser = await chromium.launch(await browserOptions());
let checks = 0;
const errors = [];
await mkdir('.cache/captures', { recursive: true });
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 960 },
    reducedMotion: 'reduce',
  });
  await context.route('**/*', (route) =>
    route.request().url().startsWith(origin) ? route.continue() : route.abort(),
  );
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(origin, { waitUntil: 'networkidle' });
  assert.ok((await page.getByRole('heading', { level: 1 }).textContent()).includes('AI that auto-replies'));
  await page.screenshot({ path: '.cache/captures/home-light.png', fullPage: true });
  checks++;
  await page.locator('[data-action="theme"]').click();
  await page.screenshot({ path: '.cache/captures/home-dark.png' });
  checks++;
  await page.getByRole('link', { name: 'Sign in', exact: true }).click();
  await page.waitForURL('**/login.html');
  await page.getByLabel('Workspace password').fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL('**/dashboard.html');
  await page.getByRole('heading', { name: 'Overview', exact: true }).waitFor();
  await page.getByRole('heading', { name: 'Add your first business', exact: true }).waitFor();
  assert.equal(await page.locator('.business-card').count(), 0);
  await page.screenshot({ path: '.cache/captures/dashboard-empty-dark.png', fullPage: true });
  checks++;
  await page.goto(new URL('settings.html#google', origin).toString(), { waitUntil: 'networkidle' });
  await page.getByLabel('Google Client ID', { exact: true }).waitFor();
  assert.equal(await page.locator('#google-settings-form input').count(), 3);
  await page.screenshot({ path: '.cache/captures/google-settings-dark.png', fullPage: true });
  checks++;
  await page.getByRole('link', { name: 'AI keys', exact: true }).last().click();
  await page.getByLabel('API Key', { exact: true }).waitFor();
  const dynamicModel = crypto.randomUUID();
  await page.route('**/api/ai/models', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ models: [{ id: dynamicModel, name: 'Available model' }] }),
    }),
  );
  await page.getByLabel('API Key', { exact: true }).fill(crypto.randomUUID());
  await page.getByLabel('Available model', { exact: true }).selectOption(dynamicModel);
  assert.equal(await page.getByRole('button', { name: 'Add API key', exact: true }).isEnabled(), true);
  checks++;
  await page.getByRole('link', { name: 'Automation', exact: true }).last().click();
  await page.getByLabel('Check interval', { exact: true }).selectOption('120');
  await page.getByLabel('Minimum reply delay · minutes', { exact: true }).fill('7');
  await page.getByLabel('Maximum reply delay · minutes', { exact: true }).fill('24');
  await page.getByRole('button', { name: 'Save automation', exact: true }).click();
  await page.getByText('Automation settings saved.', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('Check interval', { exact: true }).inputValue(), '120');
  checks++;
  await page.goto(new URL('notifications.html', origin).toString(), { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Notifications', exact: true }).waitFor();
  assert.equal(await page.locator('#notification-settings-form input[type="checkbox"]').count(), 10);
  await page.getByRole('button', { name: 'Save notification preferences', exact: true }).click();
  await page.getByText('Notification preferences saved.', { exact: true }).waitFor();
  await page.screenshot({ path: '.cache/captures/notifications-dark.png', fullPage: true });
  checks++;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(new URL('dashboard.html', origin).toString(), { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Add your first business', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
  await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.waitForURL('**/settings.html#google');
  await page.getByLabel('Google Client ID', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
  await page.screenshot({ path: '.cache/captures/settings-mobile.png', fullPage: true });
  checks++;
  await page.goto(new URL('business.html?all=1', origin).toString(), { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Review inbox', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
  checks++;
  await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.waitForURL('**/login.html');
  await page.goto(new URL('dashboard.html', origin).toString(), { waitUntil: 'networkidle' });
  await page.waitForURL('**/login.html');
  checks++;
  await page.goto(origin, { waitUntil: 'networkidle' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
  await page.screenshot({ path: '.cache/captures/home-mobile.png', fullPage: true });
  assert.deepEqual(errors, []);
  checks++;
  console.log(`${checks} browser flows passed. No runtime exceptions or mobile overflow.`);
} finally {
  await browser.close();
}
