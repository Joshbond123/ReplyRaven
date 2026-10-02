import { mkdir, readFile, writeFile, cp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
export const PAGES = [
  'index.html',
  'login.html',
  'dashboard.html',
  'business.html',
  'settings.html',
  'notifications.html',
];
export async function buildFrontend(apiBase = process.env.CLOUDFLARE_WORKER_URL) {
  if (!apiBase) throw new Error('Set CLOUDFLARE_WORKER_URL to your deployed HTTPS API URL before building.');
  if (apiBase !== '/api') {
    const url = new URL(apiBase);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
      throw new Error(
        'CLOUDFLARE_WORKER_URL must be an HTTPS endpoint without credentials or query parameters.',
      );
  }
  const directory = resolve('dist');
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  for (const file of [...PAGES, 'app.js', 'auth.js', 'styles.css', 'service-worker.js', '.nojekyll'])
    await cp(resolve(file), resolve(directory, file));
  await cp(resolve('assets'), resolve(directory, 'assets'), { recursive: true });
  await writeFile(
    resolve(directory, 'runtime-config.js'),
    `window.REPLYRAVEN_CONFIG = Object.freeze(${JSON.stringify({ apiBase: apiBase.replace(/\/$/, ''), version: '2.0.0' })});\n`,
  );
  const site = process.env.PUBLIC_SITE_URL;
  if (site) {
    const host = new URL(site).hostname;
    if (!host.endsWith('.github.io')) await writeFile(resolve(directory, 'CNAME'), `${host}\n`);
  }
  for (const file of [
    ...PAGES,
    'app.js',
    'auth.js',
    'styles.css',
    'runtime-config.js',
    'service-worker.js',
  ]) {
    const text = await readFile(resolve(directory, file), 'utf8');
    if (
      new RegExp(
        '\\b(?:' +
          ['de' + 'mo', 'ex' + 'ample', 'te' + 'st'].join('|') +
          ')\\b|Google\\s+' +
          'Sheets?|' +
          'GitHub\\s+' +
          'Actions?',
        'i',
      ).exec(text)
    )
      throw new Error(`Remove retired content from ${file} before publishing.`);
  }
  console.log('ReplyRaven frontend built in dist. No private credentials are included.');
  return directory;
}
if (process.argv[1] === resolve('scripts/build.js'))
  buildFrontend().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
