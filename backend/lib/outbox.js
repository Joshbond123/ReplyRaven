import { all, one, run } from './db.js';
export async function enqueue(env, kind, entityId, payload, dedupeKey, availableAt = Date.now()) {
  const id = crypto.randomUUID(),
    now = Date.now();
  await run(
    env,
    'INSERT INTO jobs(id,dedupe_key,kind,entity_id,payload,available_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(dedupe_key) DO NOTHING',
    id,
    dedupeKey,
    kind,
    entityId,
    JSON.stringify(payload || {}),
    availableAt,
    now,
    now,
  );
  return one(env, 'SELECT id,state FROM jobs WHERE dedupe_key=?', dedupeKey);
}
export async function dispatch(env) {
  if (!env.JOBS) return { dispatched: 0, queue_ready: false };
  const now = Date.now();
  const candidates = await all(
    env,
    "SELECT id,available_at FROM jobs WHERE state='pending' AND available_at<=? AND (last_dispatched IS NULL OR (last_dispatched<? AND available_at<=?)) ORDER BY available_at,created_at LIMIT 20",
    now + 86_400_000,
    now - 900000,
    now,
  );
  if (!candidates.length) return { dispatched: 0, queue_ready: true };
  await env.JOBS.sendBatch(
    candidates.map((job) => ({
      body: { id: job.id },
      delaySeconds: Math.min(86400, Math.max(0, Math.ceil((job.available_at - now) / 1000))),
    })),
  );
  await run(
    env,
    `UPDATE jobs SET last_dispatched=? WHERE state='pending' AND id IN (${candidates.map(() => '?').join(',')})`,
    now,
    ...candidates.map((job) => job.id),
  );
  return { dispatched: candidates.length, queue_ready: true };
}
export async function claim(env, id) {
  const now = Date.now();
  return one(
    env,
    "UPDATE jobs SET state='running',lease_until=?,attempts=attempts+1,updated_at=? WHERE id=? AND available_at<=? AND (state='pending' OR (state='running' AND lease_until<?)) RETURNING *",
    now + 300000,
    now,
    id,
    now,
    now,
  );
}
export async function recover(env) {
  const now = Date.now();
  await run(
    env,
    "UPDATE jobs SET state='pending',last_dispatched=NULL,lease_until=NULL,updated_at=? WHERE state='running' AND lease_until<?",
    now,
    now,
  );
  await run(
    env,
    "UPDATE jobs SET state='pending',attempts=0,last_dispatched=NULL,available_at=?,updated_at=? WHERE kind='notification' AND state='failed' AND updated_at<?",
    now,
    now,
    now - 21600000,
  );
  await run(env, 'DELETE FROM auth_attempts WHERE window_start<?', now - 86400000);
}
