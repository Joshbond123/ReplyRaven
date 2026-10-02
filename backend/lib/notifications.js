import { AppError, DAY, DEFAULT_NOTIFICATIONS, ensure, normalizeNotifications, safeMessage } from './core.js';
import { all, getSetting, setSetting, log, one, run } from './db.js';
import { digest, open } from './security.js';
import { enqueue } from './outbox.js';
import { sendPush } from './push.js';
export async function preferences(env) {
  return normalizeNotifications(
    await getSetting(env, 'notifications', {
      ...DEFAULT_NOTIFICATIONS,
      email_address: env.ADMIN_EMAIL || '',
    }),
  );
}
export async function notify(env, kind, title, body, dedupeKey, businessId = null, href = 'dashboard.html') {
  const existing = await one(env, 'SELECT * FROM notifications WHERE dedupe_key=?', dedupeKey);
  if (existing) return existing;
  const prefs = await preferences(env);
  if (!prefs.enabled || prefs[kind] === false) return null;
  const id = crypto.randomUUID(),
    now = Date.now();
  await run(
    env,
    'INSERT INTO notifications(id,dedupe_key,kind,title,body,href,business_id,created_at,visible) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(dedupe_key) DO NOTHING',
    id,
    dedupeKey,
    kind,
    title,
    body,
    href,
    businessId,
    now,
    prefs.in_app ? 1 : 0,
  );
  const event = await one(env, 'SELECT * FROM notifications WHERE dedupe_key=?', dedupeKey);
  if (prefs.email || prefs.browser) await enqueue(env, 'notification', event.id, {}, `notify:${event.id}`);
  return event;
}
async function delivery(env, event, channel, destination, sender) {
  const id = `${event.id}:${channel}:${(await digest(destination)).slice(0, 16)}`;
  const prior = await one(env, 'SELECT * FROM deliveries WHERE id=?', id);
  if (prior?.state === 'sent' || prior?.state === 'inactive') return;
  const now = Date.now();
  await run(
    env,
    "INSERT INTO deliveries(id,notification_id,channel,destination,state,attempts,updated_at) VALUES(?,?,?,?,'pending',1,?) ON CONFLICT(id) DO UPDATE SET attempts=attempts+1,updated_at=excluded.updated_at",
    id,
    event.id,
    channel,
    destination,
    now,
  );
  try {
    const outcome = await sender(id);
    await run(
      env,
      'UPDATE deliveries SET state=?,provider_id=?,sent_at=?,error=NULL,updated_at=? WHERE id=?',
      outcome.inactive ? 'inactive' : 'sent',
      outcome.provider_id || null,
      outcome.inactive ? null : Date.now(),
      Date.now(),
      id,
    );
  } catch (error) {
    await run(
      env,
      "UPDATE deliveries SET state='delayed',error=?,updated_at=? WHERE id=?",
      safeMessage(error),
      Date.now(),
      id,
    );
    throw error;
  }
}
function safeAddress(value) {
  return /^[^\s@\r\n]+@[^\s@\r\n]+\.[^\s@\r\n]+$/.exec(String(value || ''));
}
function escape(value) {
  return String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}
async function sendEmail(env, event, to, idempotency) {
  ensure(safeAddress(to), 'The notification email address is invalid.');
  ensure(env.EMAIL_FROM && !/[\r\n]/.exec(env.EMAIL_FROM), 'Configure a verified notification sender.', 503);
  const link = new URL(event.href, env.PUBLIC_SITE_URL).toString();
  if (env.RESEND_API_KEY) {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotency,
      },
      body: JSON.stringify({
        from: env.EMAIL_FROM,
        to: [to],
        subject: event.title,
        text: `${event.body}\n\n${link}`,
        html: `<div style="font-family:Arial,sans-serif;max-width:560px"><h2>ReplyRaven</h2><h3>${escape(event.title)}</h3><p>${escape(event.body)}</p><p><a href="${escape(link)}">Open ReplyRaven</a></p></div>`,
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok)
      throw new AppError(
        `Email delivery was not accepted (HTTP ${response.status}). The notification remains queued.`,
        502,
        'email_delayed',
      );
    const result = await response.json();
    return { provider_id: result.id };
  }
  if (env.EMAIL) {
    const { EmailMessage } = await import('cloudflare:email');
    ensure(safeAddress(env.EMAIL_FROM), 'Cloudflare Email requires a plain verified sender address.', 503);
    const subject = `=?UTF-8?B?${btoa(String.fromCharCode(...new TextEncoder().encode(event.title)))}?=`;
    const raw = `From: ${env.EMAIL_FROM}\r\nTo: ${to}\r\nSubject: ${subject}\r\nMessage-ID: <${event.id}@${env.EMAIL_FROM.split('@')[1]}>\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${event.body}\n\n${link}`;
    await env.EMAIL.send(new EmailMessage(env.EMAIL_FROM, to, raw));
    return { provider_id: event.id };
  }
  throw new AppError(
    'Email delivery is not configured. Add a verified sender and Resend key or Cloudflare Email binding.',
    503,
    'email_unconfigured',
  );
}
export async function deliverNotification(env, id, cursor = '') {
  const event = await one(env, 'SELECT * FROM notifications WHERE id=?', id);
  if (!event) return;
  const prefs = await preferences(env);
  if (!prefs.enabled || prefs[event.kind] === false) return;
  const errors = [];
  if (prefs.email)
    try {
      await delivery(env, event, 'email', prefs.email_address, (idem) =>
        sendEmail(env, event, prefs.email_address, idem),
      );
    } catch (error) {
      errors.push(error);
    }
  if (prefs.browser) {
    const subscriptions = await all(
      env,
      'SELECT * FROM push_subscriptions WHERE id>? ORDER BY id LIMIT 4',
      cursor,
    );
    for (const row of subscriptions)
      try {
        await delivery(env, event, 'browser', row.id, async () => {
          const subscription = JSON.parse(await open(env, row.ciphertext, `push:${row.id}`));
          const response = await sendPush(env, subscription, {
            id: event.id,
            title: event.title,
            body: event.body,
            url: new URL(event.href, env.PUBLIC_SITE_URL).toString(),
          });
          if ([404, 410].includes(response.status)) {
            await run(env, 'DELETE FROM push_subscriptions WHERE id=?', row.id);
            return { inactive: true };
          }
          if (!response.ok)
            throw new AppError(
              `Browser delivery was not accepted (HTTP ${response.status}).`,
              502,
              'push_delayed',
            );
          await run(env, 'UPDATE push_subscriptions SET last_used=? WHERE id=?', Date.now(), row.id);
          return { provider_id: event.id };
        });
      } catch (error) {
        errors.push(error);
      }
  }
  if (errors.length) throw errors[0];
  if (prefs.browser) {
    const rows = await all(env, 'SELECT id FROM push_subscriptions WHERE id>? ORDER BY id LIMIT 4', cursor);
    if (rows.length === 4)
      await enqueue(
        env,
        'notification',
        event.id,
        { cursor: rows.at(-1).id },
        `notify:${event.id}:${rows.at(-1).id}`,
      );
  }
}
export async function reminders(env, now = Date.now()) {
  const connection = await getSetting(env, 'google_connection', null);
  const connectedAt =
    connection?.connected_at || Date.parse(env.GOOGLE_CONNECTED_AT) || Number(env.GOOGLE_CONNECTED_AT) || 0;
  if (connectedAt) {
    const expiry = connectedAt + Math.max(1, Number(env.GOOGLE_TOKEN_LIFETIME_DAYS) || 7) * DAY,
      remaining = Math.ceil((expiry - now) / DAY);
    if (remaining === 1)
      await notify(
        env,
        'google_expiry',
        'Your Google connection expires in 24 hours - Reconnect now',
        'Open Google settings and reconnect through OAuth Playground before automated replies pause.',
        `google:${connectedAt}:1`,
        null,
        'settings.html#google',
      );
    if (remaining <= 0 || connection?.expired)
      await notify(
        env,
        'google_expiry',
        'Your Google connection needs attention',
        'Reconnect Google to continue review syncing and automated replies.',
        `google:${connectedAt}:0`,
        null,
        'settings.html#google',
      );
  }
  const cursor = await getSetting(env, 'reminder_cursor', '');
  const rows = await all(
    env,
    "SELECT * FROM businesses WHERE id>? AND deleted_at IS NULL AND billing_enabled=1 AND payment_status NOT IN ('expired','cancelled') ORDER BY id LIMIT 4",
    cursor,
  );
  for (const row of rows) {
    const trial = row.payment_status === 'trial' && row.trial_enabled;
    const due = trial ? row.trial_ends_at : row.subscription_enabled ? row.next_due_at : null;
    if (!due) continue;
    const days = Math.max(0, Math.ceil((due - now) / DAY)),
      thresholds = trial ? [2, 1, 0] : [3, 1, 0];
    if (thresholds.includes(days)) {
      const kind = trial ? 'trial_ending' : row.cycle === 'yearly' ? 'yearly_due' : 'monthly_due';
      const title = trial
        ? days
          ? `${row.name}: trial ends in ${days} ${days === 1 ? 'day' : 'days'}`
          : `${row.name}: trial expired`
        : days
          ? `${row.name}: payment due in ${days} ${days === 1 ? 'day' : 'days'}`
          : `${row.name}: payment overdue`;
      await notify(
        env,
        kind,
        title,
        days
          ? 'Review this business’s payment settings before automatic replies pause.'
          : 'Automatic replies are paused. Record payment with “Mark as Paid” to resume.',
        `billing:${row.id}:${due}:${days}`,
        row.id,
        `business.html?id=${row.id}#payments`,
      );
    }
    if (due <= now) {
      await run(
        env,
        "UPDATE businesses SET payment_status='expired',updated_at=? WHERE id=? AND payment_status NOT IN ('expired','cancelled')",
        now,
        row.id,
      );
      await log(env, 'billing_expired', 'Automatic replies paused because the billing period ended.', row.id);
    }
  }
  await setSetting(env, 'reminder_cursor', rows.length === 4 ? rows.at(-1).id : '');
  if (rows.length === 4)
    await enqueue(
      env,
      'maintenance',
      null,
      {},
      `maintenance-page:${Math.floor(now / 300000)}:${rows.at(-1).id}`,
    );
}
