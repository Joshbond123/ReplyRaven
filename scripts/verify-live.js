import { chromium } from 'playwright';
import { browserOptions } from './browser-options.js';
const site = process.env.PUBLIC_SITE_URL || 'https://joshbond123.github.io/ReplyRaven/';
const response = await fetch(site, { signal: AbortSignal.timeout(30000) });
if (!response.ok) throw new Error(`The public website is not available (HTTP ${response.status}).`);
const browser = await chromium.launch(await browserOptions());
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } }),
    page = await context.newPage(),
    errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(site, { waitUntil: 'networkidle' });
  if (
    !(await page
      .getByRole('heading', { level: 1 })
      .textContent()
      .then((value) => value.includes('AI that auto-replies')))
  )
    throw new Error('The public site is not the current ReplyRaven build.');
  const text = await page.locator('body').innerText();
  if (new RegExp('\\b' + ['de' + 'mo', 'ex' + 'ample', 'te' + 'st'].join('\\b|\\b') + '\\b', 'i').exec(text))
    throw new Error('The website contains retired content.');
  const apiBase = await page.evaluate(() => window.REPLYRAVEN_CONFIG?.apiBase);
  if (!apiBase?.startsWith('https://'))
    throw new Error('The public build is not connected to an HTTPS Cloudflare API.');
  const health = await page.evaluate(async (endpoint) => {
    const response = await fetch(endpoint + '/health');
    return { status: response.status, ...(await response.json()) };
  }, apiBase);
  if (health.status !== 200 || !health.ok || !health.queue || !health.authentication)
    throw new Error('The live backend did not pass readiness checks.');
  await page.getByRole('link', { name: 'Sign in', exact: true }).click();
  await page.waitForURL('**/login.html');
  if (process.env.ADMIN_PASSWORD) {
    await page.getByLabel('Workspace password').fill(process.env.ADMIN_PASSWORD);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.waitForURL('**/dashboard.html');
    await page.getByRole('heading', { name: 'Overview', exact: true }).waitFor();
    for (const route of [
      'settings.html#google',
      'settings.html#ai',
      'settings.html#automation',
      'notifications.html',
      'business.html?all=1',
    ]) {
      await page.goto(new URL(route, site).toString(), { waitUntil: 'networkidle' });
      if (await page.getByText('The workspace could not be loaded.', { exact: true }).count())
        throw new Error(`The authenticated route ${route} did not load.`);
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  if (overflow) throw new Error('The mobile layout extends beyond the viewport.');
  if (errors.length) throw new Error('A browser runtime error occurred.');
  console.log(
    JSON.stringify(
      {
        site,
        backend: apiBase,
        storage: health.storage,
        queue: health.queue,
        authentication: health.authentication,
        browser_errors: 0,
        mobile_overflow: false,
        owner_routes_verified: Boolean(process.env.ADMIN_PASSWORD),
        google_posting_verified: false,
        email_delivery_verified: false,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
