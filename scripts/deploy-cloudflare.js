import { readFile, writeFile, mkdir, appendFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parse } from 'jsonc-parser';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { hashPassword, b64url, open } from '../backend/lib/security.js';
import { readCredentials, credentialArgument } from './credentials.js';
const settings = {
  ...(await readCredentials(credentialArgument())),
  ...Object.fromEntries(Object.entries(process.env).filter(([, value]) => value)),
};
const account = settings.CLOUDFLARE_ACCOUNT_ID,
  token = settings.CLOUDFLARE_API_TOKEN;
if (!account || !token)
  throw new Error(
    'Provide CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN through private environment settings.',
  );
if (!/^[a-f0-9]{32}$/i.exec(account)) throw new Error('The Cloudflare account ID is invalid.');
const runtimeNames = [
  'SESSION_SECRET',
  'VAULT_SECRET',
  'ADMIN_PASSWORD_HASH',
  'ADMIN_EMAIL',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_REFRESH_TOKEN',
  'GOOGLE_CONNECTED_AT',
  'RESEND_API_KEY',
  'EMAIL_FROM',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'GROQ_API_KEY',
  'VAPID_PUBLIC_KEY',
  'VAPID_PRIVATE_KEY',
];
const secretValues = Object.values(settings).filter((value) => value.length > 8);
function redact(value) {
  let output = String(value);
  for (const secret of secretValues) output = output.split(secret).join('[redacted]');
  return output;
}
async function cloud(path, options = {}) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(30000),
  });
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error('Cloudflare returned an unreadable response.');
  }
  if (!response.ok || !result.success) {
    const error = new Error(
      `Cloudflare request failed (HTTP ${response.status}): ${redact(result.errors?.map((value) => value.message).join('; ') || 'Check account permissions.')}`,
    );
    error.status = response.status;
    throw error;
  }
  return result.result;
}
const cwd = process.cwd(),
  workerName = process.env.REPLYRAVEN_WORKER_NAME || 'replyraven-api',
  queueName = `${workerName}-jobs`,
  deadName = `${workerName}-deadletters`;
let existing = false;
try {
  await cloud(`/workers/scripts/${workerName}/settings`);
  existing = true;
} catch (error) {
  if (error.status !== 404) throw error;
}
const secrets = {};
for (const name of runtimeNames) if (settings[name]) secrets[name] = settings[name];
if (settings.ADMIN_PASSWORD) {
  if (settings.ADMIN_PASSWORD.length < 12)
    throw new Error('ADMIN_PASSWORD must contain at least 12 characters.');
  secrets.ADMIN_PASSWORD_HASH = await hashPassword(settings.ADMIN_PASSWORD);
}
if (!existing && !secrets.ADMIN_PASSWORD_HASH)
  throw new Error(
    'Set a strong ADMIN_PASSWORD before the first deployment. It is hashed server-side and is never included in the frontend.',
  );
if (!existing) {
  for (const name of ['SESSION_SECRET', 'VAULT_SECRET'])
    secrets[name] ||= b64url(crypto.getRandomValues(new Uint8Array(48)));
  if (!secrets.VAPID_PUBLIC_KEY || !secrets.VAPID_PRIVATE_KEY) {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ]);
    secrets.VAPID_PUBLIC_KEY = b64url(await crypto.subtle.exportKey('raw', pair.publicKey));
    secrets.VAPID_PRIVATE_KEY = (await crypto.subtle.exportKey('jwk', pair.privateKey)).d;
  }
}
for (const name of ['SESSION_SECRET', 'VAULT_SECRET'])
  if (secrets[name] && secrets[name].length < 32)
    throw new Error(`${name} must contain at least 32 characters.`);
for (const value of Object.values(secrets)) secretValues.push(value);
if (secrets.GOOGLE_REFRESH_TOKEN && !secrets.GOOGLE_CONNECTED_AT)
  secrets.GOOGLE_CONNECTED_AT = new Date().toISOString();
let databaseId = settings.CLOUDFLARE_D1_DATABASE_ID,
  databaseName = 'replyraven';
if (databaseId) {
  const database = await cloud(`/d1/database/${databaseId}`);
  databaseName = database.name;
} else {
  const databases = await cloud('/d1/database?per_page=100');
  let database = databases.find((item) => item.name === databaseName);
  database ||= await cloud('/d1/database', { method: 'POST', body: JSON.stringify({ name: databaseName }) });
  databaseId = database.uuid;
}
const queues = await cloud('/queues?per_page=100');
for (const name of [queueName, deadName])
  if (!queues.some((queue) => queue.queue_name === name))
    await cloud('/queues', { method: 'POST', body: JSON.stringify({ queue_name: name }) });
const config = parse(await readFile(resolve('wrangler.jsonc'), 'utf8'));
config.name = workerName;
config.account_id = account;
config.main = resolve('backend/index.js');
config.preview_urls = false;
config.d1_databases = [
  {
    binding: 'DB',
    database_name: databaseName,
    database_id: databaseId,
    migrations_dir: resolve('backend/migrations'),
  },
];
config.queues = {
  producers: [{ binding: 'JOBS', queue: queueName }],
  consumers: [
    {
      queue: queueName,
      max_batch_size: 1,
      max_batch_timeout: 5,
      max_retries: 8,
      dead_letter_queue: deadName,
      max_concurrency: 1,
    },
  ],
};
config.vars.PUBLIC_SITE_URL = settings.PUBLIC_SITE_URL || config.vars.PUBLIC_SITE_URL;
config.vars.CORS_ORIGINS = settings.CORS_ORIGINS || new URL(config.vars.PUBLIC_SITE_URL).origin;
if (settings.CLOUDFLARE_EMAIL === 'true') {
  if (!settings.ADMIN_EMAIL) throw new Error('Cloudflare Email requires a verified destination address.');
  config.send_email = [{ name: 'EMAIL', destination_address: settings.ADMIN_EMAIL }];
}
await mkdir(resolve('.cache'), { recursive: true });
const configPath = resolve('.cache/cloudflare-deploy.json');
await writeFile(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
const env = {
  ...process.env,
  CLOUDFLARE_ACCOUNT_ID: account,
  CLOUDFLARE_API_TOKEN: token,
  WRANGLER_SEND_METRICS: 'false',
  CI: 'true',
};
function wrangler(args) {
  const response = spawnSync(
    process.execPath,
    [resolve('node_modules/wrangler/bin/wrangler.js'), ...args, '--config', configPath],
    { cwd, env, encoding: 'utf8', maxBuffer: 4000000 },
  );
  if (response.stdout) console.log(redact(response.stdout));
  if (response.status !== 0) throw new Error(redact(response.stderr || 'The Cloudflare command failed.'));
}
wrangler(['d1', 'migrations', 'apply', databaseName, '--remote']);
if (secrets.VAULT_SECRET) {
  const results = await cloud(`/d1/database/${databaseId}/query`, {
    method: 'POST',
    body: JSON.stringify({
      sql: "SELECT ciphertext,key AS context FROM protected_values UNION ALL SELECT ciphertext,'ai:'||id AS context FROM ai_keys UNION ALL SELECT ciphertext,'push:'||id AS context FROM push_subscriptions LIMIT 1",
      params: [],
    }),
  });
  const sample = results[0]?.results?.[0];
  if (sample)
    try {
      await open({ VAULT_SECRET: secrets.VAULT_SECRET }, sample.ciphertext, sample.context);
    } catch {
      throw new Error(
        'The existing database contains encrypted records. Supply its original VAULT_SECRET; deployment stopped before changing runtime secrets.',
      );
    }
}
wrangler(['deploy']);
const privatePath = resolve(tmpdir(), `replyraven-runtime-${crypto.randomUUID()}.json`);
try {
  await writeFile(privatePath, JSON.stringify(secrets), { mode: 0o600 });
  if (Object.keys(secrets).length) wrangler(['secret', 'bulk', privatePath]);
} finally {
  await rm(privatePath, { force: true });
}
const subdomain = await cloud('/workers/subdomain'),
  workerURL = settings.CLOUDFLARE_WORKER_URL || `https://${workerName}.${subdomain.subdomain}.workers.dev`;
const response = await fetch(`${workerURL.replace(/\/$/, '')}/health`, {
  signal: AbortSignal.timeout(30000),
});
const health = await response.json();
if (!response.ok || !health.ok || !health.queue || !health.authentication)
  throw new Error('The deployed worker did not pass storage, queue, and authentication readiness checks.');
const publicResult = {
  worker_url: workerURL,
  version: health.version,
  storage: health.storage,
  queue: health.queue,
  authentication: health.authentication,
};
await writeFile(
  resolve('.cache/cloudflare-release.json'),
  JSON.stringify({ ...publicResult, database_id: databaseId }, null, 2),
  { mode: 0o600 },
);
if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `worker_url=${workerURL}\n`);
const githubEnv = {
  ...process.env,
  ...(settings.DEPLOY_GITHUB_TOKEN ? { GH_TOKEN: settings.DEPLOY_GITHUB_TOKEN } : {}),
};
if (process.argv.includes('--save-repository-secrets'))
  for (const [name, value] of Object.entries({
    CLOUDFLARE_ACCOUNT_ID: account,
    CLOUDFLARE_API_TOKEN: token,
    CLOUDFLARE_D1_DATABASE_ID: databaseId,
  })) {
    const result = spawnSync('gh', ['secret', 'set', name, '--repo', 'Joshbond123/ReplyRaven'], {
      env: githubEnv,
      input: value,
      encoding: 'utf8',
    });
    if (result.status !== 0)
      throw new Error(
        `The worker is deployed, but repository secret ${name} could not be saved. Check the GitHub connection’s permissions.`,
      );
  }
console.log(JSON.stringify(publicResult, null, 2));
