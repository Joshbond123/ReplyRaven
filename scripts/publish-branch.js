import { resolve } from 'node:path';
import { cp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { buildFrontend } from './build.js';
import { readCredentials, credentialArgument } from './credentials.js';
const branch = 'arena/01a0f95f-replyraven',
  settings = {
    ...(await readCredentials(credentialArgument())),
    ...Object.fromEntries(Object.entries(process.env).filter(([, value]) => value)),
  };
const current = spawnSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).stdout.trim();
if (current !== branch) throw new Error(`This session publishes only from ${branch}.`);
let worker = settings.CLOUDFLARE_WORKER_URL;
if (!worker) {
  try {
    worker = JSON.parse(await readFile('.cache/cloudflare-release.json', 'utf8')).worker_url;
  } catch {}
}
if (!worker) throw new Error('Deploy the backend and set CLOUDFLARE_WORKER_URL before publishing.');
const response = await fetch(`${worker.replace(/\/$/, '')}/health`, { signal: AbortSignal.timeout(30000) }),
  health = await response.json();
if (!response.ok || !health.ok || !health.queue || !health.authentication)
  throw new Error('The live backend is not ready. Website publishing stopped.');
await buildFrontend(worker);
await rm(resolve('docs'), { recursive: true, force: true });
await cp(resolve('dist'), resolve('docs'), { recursive: true });
await writeFile(resolve('docs/.nojekyll'), '');
console.log(
  'The built website is staged in docs for publishing from the session branch. Commit and push this branch, then enable Pages with source /(docs).',
);
