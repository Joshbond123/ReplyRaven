import http from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { sqliteBinding } from './sqlite-binding.js';
import { resolve } from 'node:path';
import app from '../backend/index.js';
import { hashPassword } from '../backend/lib/security.js';
const port = Number(process.env.API_PORT || 8787);
const directory = resolve(process.env.LOCAL_STATE_DIR || '.cache/local');
await mkdir(directory, { recursive: true });
let access;
try {
  access = JSON.parse(await readFile(resolve(directory, 'owner-access.json'), 'utf8'));
} catch {
  access = {
    password: crypto.randomUUID() + crypto.randomUUID(),
    session_secret: crypto.randomUUID() + crypto.randomUUID(),
    vault_secret: crypto.randomUUID() + crypto.randomUUID(),
  };
  await writeFile(resolve(directory, 'owner-access.json'), JSON.stringify(access), { mode: 0o600 });
}
const DB = sqliteBinding(resolve(directory, 'database.sqlite'));
await DB.exec(await readFile(resolve('backend/migrations/0001.sql'), 'utf8'));
const env = {
  ...process.env,
  DB,
  SESSION_SECRET: access.session_secret,
  VAULT_SECRET: access.vault_secret,
  ADMIN_PASSWORD_HASH: await hashPassword(process.env.LOCAL_OWNER_PASSWORD || access.password),
  CORS_ORIGINS: 'http://127.0.0.1:3000',
  PUBLIC_SITE_URL: 'http://127.0.0.1:3000/',
  GOOGLE_TOKEN_LIFETIME_DAYS: '7',
};
const waits = new Set();
const ctx = {
  waitUntil(promise) {
    waits.add(promise);
    promise.catch(() => {}).finally(() => waits.delete(promise));
  },
};
http
  .createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const request = new Request(`http://127.0.0.1:${port}${req.url}`, {
        method: req.method,
        headers: req.headers,
        ...(!['GET', 'HEAD'].includes(req.method) ? { body: Buffer.concat(chunks) } : {}),
      });
      const response = await app.fetch(request, env, ctx);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      res.writeHead(500);
      res.end(JSON.stringify({ error: 'The local API could not complete this request.' }));
    }
  })
  .listen(port, '0.0.0.0', () =>
    console.log(
      `ReplyRaven API is available on port ${port}. Private local access settings are in ${directory}/owner-access.json.`,
    ),
  );
