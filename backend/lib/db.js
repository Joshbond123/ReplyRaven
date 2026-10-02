import { parseJSON } from './core.js';
export const one = (env, sql, ...values) =>
  env.DB.prepare(sql)
    .bind(...values)
    .first();
export async function all(env, sql, ...values) {
  const response = await env.DB.prepare(sql)
    .bind(...values)
    .all();
  return response.results || [];
}
export const run = (env, sql, ...values) =>
  env.DB.prepare(sql)
    .bind(...values)
    .run();
export async function getSetting(env, key, fallback) {
  const row = await one(env, 'SELECT value FROM settings WHERE key = ?', key);
  return row ? parseJSON(row.value, fallback) : fallback;
}
export async function setSetting(env, key, value) {
  await run(
    env,
    'INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at',
    key,
    JSON.stringify(value),
    Date.now(),
  );
}
export async function log(env, action, message, businessId = null, level = 'info') {
  await run(
    env,
    'INSERT INTO logs(id,business_id,action,level,message,created_at) VALUES(?,?,?,?,?,?)',
    crypto.randomUUID(),
    businessId,
    action,
    level,
    message,
    Date.now(),
  );
}
export async function business(env, id) {
  return one(env, 'SELECT * FROM businesses WHERE id = ? AND deleted_at IS NULL', id);
}
