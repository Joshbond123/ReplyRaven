import {
  AppError,
  DAY,
  DEFAULT_AUTOMATION,
  DEFAULT_NOTIFICATIONS,
  PROVIDERS,
  billingAllows,
  boundedInt,
  ensure,
  identifier,
  nextDue,
  normalizeAutomation,
  normalizeNotifications,
  parseJSON,
  publicBusiness,
  safeMessage,
} from './lib/core.js';
import { all, business, getSetting, log, one, run, setSetting } from './lib/db.js';
import { addKey, draftReply, modelsFor, normalizeVoice, publicKey } from './lib/ai.js';
import {
  discover,
  googleClient,
  googleCredentials,
  normalizeLocation,
  normalizeReview,
} from './lib/google.js';
import {
  digest,
  hashPassword,
  login,
  open,
  ownerPassword,
  passwordMatches,
  protectedValue,
  saveProtected,
  seal,
  session,
} from './lib/security.js';
import { dispatch, enqueue } from './lib/outbox.js';
import {
  postUnreplied,
  processJob,
  refreshReview,
  releaseWrite,
  resumeJobs,
  reviewWriteLease,
  scheduler,
} from './lib/jobs.js';
import { notify, preferences } from './lib/notifications.js';
import { validateSubscription } from './lib/push.js';
const VERSION = '2.0.0';
function origins(env) {
  return String(env.CORS_ORIGINS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}
function cors(request, env) {
  const origin = request.headers.get('Origin');
  if (origin && !origins(env).includes(origin))
    throw new AppError('This origin is not allowed to access ReplyRaven.', 403, 'origin_denied');
  return {
    ...(origin ? { 'Access-Control-Allow-Origin': origin } : {}),
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  };
}
const json = (value, status = 200, headers = {}) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
async function input(request) {
  ensure(
    (Number(request.headers.get('Content-Length')) || 0) <= 65536,
    'The request body is too large.',
    413,
  );
  ensure(
    (request.headers.get('Content-Type') || '').includes('application/json'),
    'Send a JSON request body.',
    415,
  );
  const reader = request.body?.getReader();
  ensure(reader, 'The request body is missing.');
  const decoder = new TextDecoder();
  let text = '',
    size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      ensure(size <= 65536, 'The request body is too large.', 413);
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new AppError('The request body is not valid JSON.');
  }
}
function wake(env, ctx) {
  ctx.waitUntil(dispatch(env).catch(() => {}));
}
async function requireBusiness(env, id) {
  const row = await business(env, id);
  ensure(row, 'This business could not be found.', 404);
  return row;
}
function billingFields(value, existing = null) {
  const enabled =
    value.billing_enabled === undefined ? Boolean(existing?.billing_enabled) : Boolean(value.billing_enabled);
  const trial =
    value.trial_enabled === undefined ? Boolean(existing?.trial_enabled) : Boolean(value.trial_enabled);
  const subscription =
    value.subscription_enabled === undefined
      ? Boolean(existing?.subscription_enabled)
      : Boolean(value.subscription_enabled);
  const method = String(value.payment_method || existing?.payment_method || 'transfer').toLowerCase(),
    cycle = String(value.cycle || existing?.cycle || 'monthly');
  ensure(['cash', 'transfer', 'stripe', 'paypal'].includes(method), 'Choose a supported payment method.');
  ensure(['monthly', 'yearly', 'custom'].includes(cycle), 'Choose monthly, yearly, or custom billing.');
  const raw = value.amount ?? existing?.amount ?? 0,
    amount = Number(String(raw).replace(/[^0-9.\-]/g, ''));
  ensure(Number.isFinite(amount) && amount >= 0 && amount <= 1e12, 'Enter a valid payment amount.');
  const currency = String(
    value.currency ||
      (/₦/.exec(String(raw)) ? 'NGN' : /\$/.exec(String(raw)) ? 'USD' : existing?.currency || 'NGN'),
  ).toUpperCase();
  ensure(/^[A-Z]{3}$/.exec(currency), 'Use a three-letter currency code.');
  ensure(!enabled || !subscription || amount > 0, 'Set an amount for an enabled subscription.');
  const now = Date.now(),
    customDays = boundedInt(value.custom_days ?? existing?.custom_days, 1, 3650, 30);
  let status = existing?.payment_status || (enabled && trial ? 'trial' : 'active');
  if (value.payment_status === 'cancelled') status = 'cancelled';
  else if (
    existing &&
    ['expired', 'cancelled'].includes(existing.payment_status) &&
    value.payment_status &&
    value.payment_status !== existing.payment_status
  )
    throw new AppError('Use Mark as Paid to reactivate an expired or cancelled business.');
  let trialEnds = existing?.trial_ends_at || null;
  if (enabled && trial && !existing?.trial_enabled) {
    ensure(
      !existing || !['expired', 'cancelled'].includes(existing.payment_status),
      'Record payment before restarting this business.',
    );
    trialEnds = now + 7 * DAY;
    status = 'trial';
  }
  let due = existing?.next_due_at || null;
  if (value.next_due_at !== undefined && value.next_due_at !== null && value.next_due_at !== '') {
    due = typeof value.next_due_at === 'number' ? value.next_due_at : Date.parse(value.next_due_at);
    ensure(Number.isFinite(due), 'Choose a valid next due date.');
  }
  if (enabled && subscription && status === 'active' && !due) due = nextDue(now, cycle, customDays);
  return {
    billing_enabled: enabled ? 1 : 0,
    trial_enabled: trial ? 1 : 0,
    subscription_enabled: subscription ? 1 : 0,
    payment_status: status,
    payment_method: method,
    cycle,
    amount,
    currency,
    custom_days: customDays,
    trial_ends_at: trialEnds,
    next_due_at: due,
  };
}
async function connectionStatus(env) {
  const values = await googleCredentials(env),
    meta = await getSetting(env, 'google_connection', {});
  const connected = Boolean(values.clientId && values.clientSecret && values.refreshToken);
  const date =
    meta.connected_at || Date.parse(env.GOOGLE_CONNECTED_AT) || Number(env.GOOGLE_CONNECTED_AT) || null;
  return {
    client_id: values.clientId,
    client_secret_saved: Boolean(values.clientSecret),
    refresh_token_saved: Boolean(values.refreshToken),
    connected,
    connected_at: date,
    expires_at: date ? date + (Number(env.GOOGLE_TOKEN_LIFETIME_DAYS) || 7) * DAY : null,
    expired: Boolean(meta.expired),
    last_checked: meta.last_checked || null,
  };
}
async function settingsResponse(env) {
  const automation = normalizeAutomation(await getSetting(env, 'automation', DEFAULT_AUTOMATION));
  return {
    google: await connectionStatus(env),
    automation,
    notifications: await preferences(env),
    account: await getSetting(env, 'account', { workspace_name: 'ReplyRaven' }),
    capabilities: {
      email: Boolean((env.RESEND_API_KEY || env.EMAIL) && env.EMAIL_FROM),
      browser: Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY),
      queue: Boolean(env.JOBS),
      stored_providers: PROVIDERS.filter((provider) => Boolean(env[provider.toUpperCase() + '_API_KEY'])),
    },
    vapid_public_key: env.VAPID_PUBLIC_KEY || '',
  };
}
async function stateResponse(env) {
  const stats = await one(
    env,
    `SELECT (SELECT COUNT(*) FROM businesses WHERE deleted_at IS NULL) AS businesses,
    (SELECT COALESCE(SUM(review_count),0) FROM businesses WHERE deleted_at IS NULL) AS reviews,
    (SELECT COUNT(*) FROM reviews r JOIN businesses b ON b.id=r.business_id WHERE b.deleted_at IS NULL AND r.archived=0 AND r.reply IS NULL) AS unreplied,
    (SELECT COUNT(*) FROM reviews r JOIN businesses b ON b.id=r.business_id WHERE b.deleted_at IS NULL AND r.archived=0 AND r.reply_source='ai' AND r.replied_at>=?) AS auto_today`,
    new Date().setUTCHours(0, 0, 0, 0),
  );
  const notification = await one(
    env,
    'SELECT COUNT(*) AS unread FROM notifications WHERE visible=1 AND read_at IS NULL',
  );
  return {
    stats,
    unread: notification.unread,
    settings: await settingsResponse(env),
    activity: await all(
      env,
      'SELECT action,level,message,created_at,business_id FROM logs ORDER BY created_at DESC LIMIT 10',
    ),
    version: VERSION,
  };
}
async function listBusinesses(env, url) {
  const page = boundedInt(url.searchParams.get('page'), 1, 100000, 1),
    query = (url.searchParams.get('q') || '').trim().slice(0, 200);
  const filter = url.searchParams.get('filter') || 'all';
  const clauses = ['b.deleted_at IS NULL'],
    values = [];
  if (query) {
    clauses.push('(b.name LIKE ? OR b.address LIKE ? OR b.google_location_id LIKE ?)');
    values.push(`%${query}%`, `%${query}%`, `%${query}%`);
  }
  if (filter === 'auto') clauses.push('b.auto_reply=1');
  if (filter === 'overdue')
    (clauses.push(
      "b.billing_enabled=1 AND (b.payment_status IN ('expired','cancelled') OR (b.payment_status='trial' AND b.trial_ends_at<=?) OR (b.subscription_enabled=1 AND b.payment_status='active' AND b.next_due_at<=?))",
    ),
      values.push(Date.now(), Date.now()));
  const where = clauses.join(' AND '),
    count = await one(env, `SELECT COUNT(*) AS count FROM businesses b WHERE ${where}`, ...values);
  const rows = await all(
    env,
    `SELECT b.*,(SELECT COUNT(*) FROM reviews r WHERE r.business_id=b.id AND r.archived=0 AND r.reply IS NULL) AS unreplied FROM businesses b WHERE ${where} ORDER BY b.created_at DESC,b.id LIMIT 24 OFFSET ?`,
    ...values,
    (page - 1) * 24,
  );
  return {
    businesses: rows.map(publicBusiness),
    total: count.count,
    page,
    pages: Math.max(1, Math.ceil(count.count / 24)),
  };
}
async function listReviews(env, url, bizId = null) {
  const page = boundedInt(url.searchParams.get('page'), 1, 100000, 1),
    query = (url.searchParams.get('q') || '').slice(0, 200),
    filter = url.searchParams.get('filter') || 'all';
  const clauses = ['b.deleted_at IS NULL', 'r.archived=0'],
    values = [];
  if (bizId) {
    clauses.push('r.business_id=?');
    values.push(bizId);
  }
  if (query) {
    clauses.push('(r.reviewer LIKE ? OR r.comment LIKE ?)');
    values.push(`%${query}%`, `%${query}%`);
  }
  if (filter === 'unreplied') clauses.push('r.reply IS NULL');
  if (filter === 'low') clauses.push('r.rating BETWEEN 1 AND 3');
  if (filter === 'high') clauses.push('r.rating BETWEEN 4 AND 5');
  if (filter === 'auto') clauses.push("r.reply_source='ai'");
  const where = clauses.join(' AND '),
    count = await one(
      env,
      `SELECT COUNT(*) AS count FROM reviews r JOIN businesses b ON b.id=r.business_id WHERE ${where}`,
      ...values,
    );
  const rows = await all(
    env,
    `SELECT r.*,b.name AS business_name FROM reviews r JOIN businesses b ON b.id=r.business_id WHERE ${where} ORDER BY r.created_at DESC,r.id LIMIT 30 OFFSET ?`,
    ...values,
    (page - 1) * 30,
  );
  return {
    reviews: rows.map(({ write_owner, write_lease_until, seen_run, ...row }) => row),
    total: count.count,
    page,
    pages: Math.max(1, Math.ceil(count.count / 30)),
  };
}
async function routes(request, env, ctx, url) {
  const path = url.pathname.replace(/\/$/, '') || '/',
    method = request.method;
  if (path === '/health' && method === 'GET') {
    let storage = false;
    try {
      storage = Boolean(await one(env, "SELECT value FROM counters WHERE key='ai_rotation'"));
    } catch {}
    return {
      ok: storage,
      version: VERSION,
      storage: storage ? 'connected' : 'unavailable',
      queue: Boolean(env.JOBS),
      authentication: Boolean(env.SESSION_SECRET && env.VAULT_SECRET && env.ADMIN_PASSWORD_HASH),
      timestamp: Date.now(),
    };
  }
  ensure(env.DB, 'The D1 database binding is missing.', 503, 'setup_required');
  if (path === '/auth/login' && method === 'POST') {
    const body = await input(request);
    return login(env, request, body.password);
  }
  await session(env, request);
  if (path === '/auth/session' && method === 'GET') return { authenticated: true };
  if (path === '/state' && method === 'GET') return stateResponse(env);
  if (path === '/settings' && method === 'GET') return settingsResponse(env);
  if (path === '/settings/google' && method === 'PUT') {
    const body = await input(request),
      current = await googleCredentials(env);
    const credentials = {
      clientId: String(body.client_id || current.clientId).trim(),
      clientSecret: String(body.client_secret || current.clientSecret).trim(),
      refreshToken: String(body.refresh_token || current.refreshToken).trim(),
    };
    ensure(
      credentials.clientId && credentials.clientSecret && credentials.refreshToken,
      'Enter Google Client ID, Google Client Secret, and Refresh Token.',
    );
    const client = await import('./lib/google.js').then(({ GoogleClient }) => new GoogleClient(credentials));
    await client.token();
    for (const [key, value] of Object.entries({
      GOOGLE_CLIENT_ID: credentials.clientId,
      GOOGLE_CLIENT_SECRET: credentials.clientSecret,
      GOOGLE_REFRESH_TOKEN: credentials.refreshToken,
    }))
      await saveProtected(env, key, value);
    const meta = await getSetting(env, 'google_connection', {}),
      now = Date.now();
    await setSetting(env, 'google_connection', {
      connected_at: body.refresh_token
        ? now
        : meta.connected_at || Date.parse(env.GOOGLE_CONNECTED_AT) || now,
      last_checked: now,
      expired: false,
    });
    await log(
      env,
      'google_connected',
      'Google credentials validated and saved in the encrypted Cloudflare vault.',
    );
    return { google: await connectionStatus(env) };
  }
  if (path === '/google/playground' && method === 'GET')
    return {
      url:
        'https://developers.google.com/oauthplayground/#step1&apis=' +
        encodeURIComponent('https://www.googleapis.com/auth/business.manage'),
      client_id: (await googleCredentials(env)).clientId,
    };
  if (path === '/settings/automation' && method === 'PUT') {
    const settings = normalizeAutomation(await input(request));
    await setSetting(env, 'automation', settings);
    if (settings.enabled) await resumeJobs(env);
    await log(env, 'automation_updated', settings.enabled ? 'Automation enabled.' : 'Automation paused.');
    wake(env, ctx);
    return { automation: settings };
  }
  if (path === '/settings/notifications' && method === 'PUT') {
    const body = normalizeNotifications(await input(request));
    ensure(
      !body.email || Boolean((env.RESEND_API_KEY || env.EMAIL) && env.EMAIL_FROM),
      'Configure verified email delivery before enabling this channel.',
      409,
    );
    ensure(
      !body.browser || Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY),
      'Configure browser signing keys before enabling this channel.',
      409,
    );
    await setSetting(env, 'notifications', body);
    return { notifications: body };
  }
  if (path === '/settings/account' && method === 'PUT') {
    const body = await input(request),
      name = String(body.workspace_name || 'ReplyRaven')
        .trim()
        .slice(0, 100);
    await setSetting(env, 'account', { workspace_name: name });
    if (body.new_password) {
      ensure(
        String(body.new_password).length >= 12 && String(body.new_password).length <= 256,
        'Use a password with at least 12 characters.',
      );
      ensure(
        await passwordMatches(String(body.current_password || ''), await ownerPassword(env)),
        'Your current password is not correct.',
        403,
      );
      await saveProtected(env, 'ADMIN_PASSWORD_HASH', await hashPassword(body.new_password));
      await setSetting(env, 'auth_version', Date.now());
    }
    return { account: { workspace_name: name }, reauthenticate: Boolean(body.new_password) };
  }
  if (path === '/ai/models' && method === 'POST') {
    const body = await input(request);
    ensure(PROVIDERS.includes(body.provider), 'Choose a supported provider.');
    const key = body.use_saved_key
      ? await protectedValue(env, body.provider.toUpperCase() + '_API_KEY')
      : body.api_key;
    return { models: await modelsFor(body.provider, key) };
  }
  if (path === '/ai/keys' && method === 'GET')
    return { keys: (await all(env, 'SELECT * FROM ai_keys ORDER BY created_at')).map(publicKey) };
  if (path === '/ai/keys' && method === 'POST') {
    const body = await input(request);
    ensure(PROVIDERS.includes(body.provider), 'Choose a supported provider.');
    if (body.use_saved_key)
      body.api_key = await protectedValue(env, body.provider.toUpperCase() + '_API_KEY');
    const key = await addKey(env, body);
    await log(env, 'ai_key_added', 'An encrypted AI key and an available model were saved.');
    return { key };
  }
  const keyRoute = /^\/ai\/keys\/([^/]+)(?:\/(health))?$/.exec(path);
  if (keyRoute) {
    const key = await one(env, 'SELECT * FROM ai_keys WHERE id=?', keyRoute[1]);
    ensure(key, 'The key could not be found.', 404);
    if (method === 'DELETE') {
      await run(env, 'DELETE FROM ai_keys WHERE id=?', key.id);
      return { deleted: true };
    }
    if (method === 'PUT') {
      const body = await input(request);
      await run(env, 'UPDATE ai_keys SET enabled=? WHERE id=?', body.enabled ? 1 : 0, key.id);
      return { key: publicKey(await one(env, 'SELECT * FROM ai_keys WHERE id=?', key.id)) };
    }
    if (method === 'POST' && keyRoute[2]) {
      try {
        const models = await modelsFor(key.provider, await open(env, key.ciphertext, `ai:${key.id}`));
        await run(
          env,
          "UPDATE ai_keys SET health='active',cooldown_until=NULL,error=NULL WHERE id=?",
          key.id,
        );
        return { models, key: publicKey(await one(env, 'SELECT * FROM ai_keys WHERE id=?', key.id)) };
      } catch (error) {
        await run(
          env,
          'UPDATE ai_keys SET health=?,error=? WHERE id=?',
          [401, 403].includes(error.status) ? 'invalid' : error.status === 429 ? 'rate_limited' : key.health,
          safeMessage(error),
          key.id,
        );
        throw error;
      }
    }
  }
  if (path === '/businesses/discover' && method === 'POST') {
    const result = await discover(env, (await input(request)).cursor || null);
    const ids = new Set(
      (await all(env, 'SELECT google_location_id FROM businesses WHERE deleted_at IS NULL')).map(
        (row) => row.google_location_id,
      ),
    );
    return {
      ...result,
      locations: result.locations.filter((location) => !ids.has(location.google_location_id)),
    };
  }
  if (path === '/businesses' && method === 'GET') return listBusinesses(env, url);
  if (path === '/businesses' && method === 'POST') {
    const body = await input(request),
      locationId = identifier(body.google_location_id),
      accountId = identifier(body.google_account_id);
    ensure(locationId && accountId, 'Choose an accessible Google business and account.');
    const google = await googleClient(env),
      profile = await google.profile(locationId),
      location = normalizeLocation(profile, accountId);
    ensure(
      !(await one(
        env,
        'SELECT id FROM businesses WHERE google_location_id=? AND deleted_at IS NULL',
        locationId,
      )),
      'This business is already added.',
      409,
    );
    const id = crypto.randomUUID(),
      now = Date.now(),
      payment = billingFields(body);
    const removed = await one(
      env,
      'SELECT id FROM businesses WHERE google_location_id=? AND deleted_at IS NOT NULL',
      locationId,
    );
    if (removed)
      await run(
        env,
        'UPDATE businesses SET google_location_id=? WHERE id=?',
        `removed:${removed.id}`,
        removed.id,
      );
    await run(
      env,
      'INSERT INTO businesses(id,google_location_id,google_account_id,name,address,website,metadata,auto_reply,created_at,updated_at,billing_enabled,trial_enabled,subscription_enabled,payment_status,payment_method,cycle,amount,currency,custom_days,trial_ends_at,next_due_at,backfill_limit) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      id,
      locationId,
      accountId,
      String(body.name || location.name)
        .trim()
        .slice(0, 200),
      location.address,
      location.website,
      JSON.stringify(profile),
      body.auto_reply ? 1 : 0,
      now,
      now,
      payment.billing_enabled,
      payment.trial_enabled,
      payment.subscription_enabled,
      payment.payment_status,
      payment.payment_method,
      payment.cycle,
      payment.amount,
      payment.currency,
      payment.custom_days,
      payment.trial_ends_at,
      payment.next_due_at,
      body.include_previous ? boundedInt(body.previous_count, 1, 1000, 1) : 0,
    );
    await enqueue(env, 'learn', id, {}, `learn:${id}:${now}`);
    await enqueue(env, 'sync', id, {}, `initial-sync:${id}`);
    await log(
      env,
      'business_added',
      'Business added. Brand learning and review synchronization are queued.',
      id,
    );
    wake(env, ctx);
    return { business: publicBusiness(await business(env, id)) };
  }
  if (path === '/reviews' && method === 'GET')
    return listReviews(env, url, url.searchParams.get('business_id'));
  const bizRoute = /^\/businesses\/([^/]+)(?:\/(sync|voice|payments|mark-paid|backfill|retry))?$/.exec(path);
  if (bizRoute) {
    const biz = await requireBusiness(env, bizRoute[1]),
      action = bizRoute[2];
    if (!action && method === 'GET')
      return {
        business: publicBusiness(biz),
        reviews: await listReviews(env, url, biz.id),
        payments: await all(
          env,
          'SELECT * FROM payments WHERE business_id=? ORDER BY paid_at DESC LIMIT 20',
          biz.id,
        ),
        jobs: await all(
          env,
          'SELECT kind,state,error,created_at FROM jobs WHERE entity_id=? ORDER BY created_at DESC LIMIT 5',
          biz.id,
        ),
      };
    if (!action && method === 'DELETE') {
      await run(env, 'UPDATE businesses SET deleted_at=?,auto_reply=0 WHERE id=?', Date.now(), biz.id);
      await log(
        env,
        'business_removed',
        'Business removed from ReplyRaven. Its Google profile and owner replies were not changed.',
        biz.id,
      );
      return { deleted: true };
    }
    if (!action && method === 'PUT') {
      const body = await input(request),
        payment = billingFields(body, biz);
      await run(
        env,
        'UPDATE businesses SET name=?,auto_reply=?,billing_enabled=?,trial_enabled=?,subscription_enabled=?,payment_status=?,payment_method=?,cycle=?,amount=?,currency=?,custom_days=?,trial_ends_at=?,next_due_at=?,updated_at=? WHERE id=?',
        String(body.name || biz.name)
          .trim()
          .slice(0, 200),
        body.auto_reply === undefined ? biz.auto_reply : body.auto_reply ? 1 : 0,
        payment.billing_enabled,
        payment.trial_enabled,
        payment.subscription_enabled,
        payment.payment_status,
        payment.payment_method,
        payment.cycle,
        payment.amount,
        payment.currency,
        payment.custom_days,
        payment.trial_ends_at,
        payment.next_due_at,
        Date.now(),
        biz.id,
      );
      if (body.auto_reply) await resumeJobs(env, biz.id);
      return { business: publicBusiness(await business(env, biz.id)) };
    }
    if (action === 'sync' && method === 'POST') {
      const job = await enqueue(env, 'sync', biz.id, {}, `manual-sync:${biz.id}:${Date.now()}`);
      wake(env, ctx);
      return { queued: true, job_id: job.id };
    }
    if (action === 'voice' && method === 'PUT') {
      const voice = normalizeVoice((await input(request)).voice);
      await run(
        env,
        "UPDATE businesses SET voice_profile=?,voice_status='ready',voice_error=NULL,updated_at=? WHERE id=?",
        JSON.stringify(voice),
        Date.now(),
        biz.id,
      );
      return { voice };
    }
    if (action === 'voice' && method === 'POST') {
      const job = await enqueue(env, 'learn', biz.id, {}, `learn:${biz.id}:${Date.now()}`);
      await run(env, "UPDATE businesses SET voice_status='pending',voice_error=NULL WHERE id=?", biz.id);
      wake(env, ctx);
      return { queued: true, job_id: job.id };
    }
    if (action === 'mark-paid' && method === 'POST') {
      const body = await input(request),
        now = Date.now(),
        payment = billingFields({ ...body, payment_status: undefined }, biz),
        base = biz.payment_status === 'active' && biz.next_due_at > now ? biz.next_due_at : now,
        due = payment.subscription_enabled ? nextDue(base, payment.cycle, payment.custom_days) : null;
      await env.DB.batch([
        env.DB.prepare(
          'INSERT INTO payments(id,business_id,amount,currency,method,paid_at,due_at,note) VALUES(?,?,?,?,?,?,?,?)',
        ).bind(
          crypto.randomUUID(),
          biz.id,
          payment.amount,
          payment.currency,
          payment.payment_method,
          now,
          due,
          String(body.note || '').slice(0, 500),
        ),
        env.DB.prepare(
          "UPDATE businesses SET payment_status='active',next_due_at=?,updated_at=? WHERE id=?",
        ).bind(due, now, biz.id),
      ]);
      await resumeJobs(env, biz.id);
      await log(
        env,
        'payment_recorded',
        'Payment recorded and billing pause cleared. Automatic replies still require master and business opt-in.',
        biz.id,
      );
      wake(env, ctx);
      return { business: publicBusiness(await business(env, biz.id)) };
    }
    if (action === 'backfill' && method === 'POST') {
      const body = await input(request);
      ensure(
        body.confirmed === true,
        'Confirm that you want to schedule previous unreplied 4–5 star reviews.',
      );
      const limit = boundedInt(body.limit, 1, 1000, 1),
        job = await enqueue(env, 'backfill', biz.id, { limit }, `backfill:${biz.id}:${Date.now()}`);
      wake(env, ctx);
      return { queued: true, limit, job_id: job.id };
    }
    if (action === 'retry' && method === 'POST') {
      await run(
        env,
        "UPDATE jobs SET state='pending',attempts=0,last_dispatched=NULL,available_at=?,error=NULL WHERE entity_id=? AND kind IN ('learn','sync') AND state='failed'",
        Date.now(),
        biz.id,
      );
      await resumeJobs(env, biz.id);
      wake(env, ctx);
      return { queued: true };
    }
  }
  const reviewRoute = /^\/reviews\/([^/]+)\/(draft|reply|reconcile)$/.exec(path);
  if (reviewRoute) {
    const row = await one(env, 'SELECT * FROM reviews WHERE id=? AND archived=0', reviewRoute[1]);
    ensure(row, 'This review could not be found.', 404);
    const biz = await requireBusiness(env, row.business_id),
      action = reviewRoute[2];
    if (action === 'reconcile' && method === 'POST') {
      const body = await input(request);
      ensure(
        !row.write_lease_until || row.write_lease_until < Date.now(),
        'A reply operation is still in progress.',
        409,
      );
      const refreshed = await refreshReview(env, biz, row);
      if (!refreshed.item.has_reply && row.reply_state === 'uncertain' && body.confirm_no_reply === true) {
        await run(
          env,
          "UPDATE reviews SET reply_state='unreplied',eligible_at=NULL,historical=1 WHERE id=?",
          row.id,
        );
        await log(
          env,
          'reply_write_verified',
          'The owner confirmed the remote review has no reply. Any next post requires deliberate approval.',
          biz.id,
        );
      }
      return {
        review: await one(env, 'SELECT * FROM reviews WHERE id=?', row.id),
        has_reply: refreshed.item.has_reply,
      };
    }
    if (action === 'draft' && method === 'POST') {
      const refreshed = await refreshReview(env, biz, row);
      ensure(
        !refreshed.item.has_reply,
        'Google already has an owner reply. It will not be overwritten.',
        409,
      );
      ensure(
        biz.voice_status === 'ready',
        'Wait for a brand voice profile or save one before generating a reply.',
        409,
      );
      return { draft: (await draftReply(env, biz, refreshed.item)).text };
    }
    if (action === 'reply' && method === 'POST') {
      const body = await input(request);
      return postUnreplied(env, biz, row, String(body.comment || ''), 'manual');
    }
    if (action === 'reply' && method === 'DELETE') {
      const body = await input(request);
      ensure(
        body.confirmed === true && typeof body.expected_reply === 'string',
        'Confirm deletion of this owner reply.',
      );
      const owner = crypto.randomUUID();
      ensure(await reviewWriteLease(env, row.id, owner), 'A reply operation is in progress.', 409);
      try {
        const refreshed = await refreshReview(env, biz, row);
        ensure(
          refreshed.item.has_reply && refreshed.item.reply === body.expected_reply,
          'The owner reply changed. Refresh before deleting.',
          409,
        );
        await refreshed.google.removeReply(biz, row.google_review_id);
        await run(
          env,
          "UPDATE reviews SET reply=NULL,replied_at=NULL,reply_state='unreplied',eligible_at=NULL WHERE id=?",
          row.id,
        );
        await log(
          env,
          'owner_reply_deleted',
          'The explicitly confirmed owner reply was deleted. Automatic re-posting remains disabled for this review.',
          biz.id,
        );
        return { deleted: true };
      } finally {
        await releaseWrite(env, row.id, owner);
      }
    }
  }
  if (path === '/notifications' && method === 'GET')
    return {
      notifications: await all(
        env,
        'SELECT * FROM notifications WHERE visible=1 ORDER BY created_at DESC LIMIT 100',
      ),
      deliveries: await all(
        env,
        'SELECT d.channel,d.state,d.error,d.sent_at,d.notification_id,n.title FROM deliveries d JOIN notifications n ON n.id=d.notification_id ORDER BY d.updated_at DESC LIMIT 30',
      ),
    };
  if (path === '/notifications/read' && method === 'POST') {
    const body = await input(request);
    if (body.id) await run(env, 'UPDATE notifications SET read_at=? WHERE id=?', Date.now(), body.id);
    else await run(env, 'UPDATE notifications SET read_at=? WHERE read_at IS NULL', Date.now());
    return { read: true };
  }
  if (path === '/notifications/confirmation' && method === 'POST') {
    await notify(
      env,
      'connection_ready',
      'ReplyRaven notifications are connected',
      'This confirmation is delivered to the notification channels you enabled.',
      `confirmation:${Date.now()}`,
    );
    wake(env, ctx);
    return { queued: true };
  }
  if (path === '/notifications/retry' && method === 'POST') {
    await run(
      env,
      "UPDATE jobs SET state='pending',available_at=?,attempts=0,last_dispatched=NULL,error=NULL WHERE kind='notification' AND state='failed'",
      Date.now(),
    );
    wake(env, ctx);
    return { queued: true };
  }
  if (path === '/notifications/subscribe' && method === 'POST') {
    ensure(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY, 'Browser notifications are not configured.', 409);
    const subscription = validateSubscription(await input(request)),
      hash = await digest(subscription.endpoint),
      existing = await one(env, 'SELECT id FROM push_subscriptions WHERE endpoint_hash=?', hash),
      id = existing?.id || crypto.randomUUID();
    await run(
      env,
      'INSERT INTO push_subscriptions(id,endpoint_hash,ciphertext,created_at) VALUES(?,?,?,?) ON CONFLICT(endpoint_hash) DO UPDATE SET ciphertext=excluded.ciphertext',
      id,
      hash,
      await seal(env, JSON.stringify(subscription), `push:${id}`),
      Date.now(),
    );
    return { subscribed: true };
  }
  if (path === '/notifications/subscribe' && method === 'DELETE') {
    const body = await input(request);
    await run(
      env,
      'DELETE FROM push_subscriptions WHERE endpoint_hash=?',
      await digest(String(body.endpoint || '')),
    );
    return { subscribed: false };
  }
  if (path === '/logs' && method === 'GET')
    return {
      logs: await all(env, 'SELECT * FROM logs ORDER BY created_at DESC LIMIT 100'),
      jobs: await all(
        env,
        "SELECT kind,state,error,created_at,updated_at FROM jobs WHERE state IN ('pending','running','blocked','failed') ORDER BY updated_at DESC LIMIT 30",
      ),
    };
  if (path === '/automation/run' && method === 'POST') {
    ctx.waitUntil(scheduler(env));
    return { queued: true };
  }
  throw new AppError('This API route does not exist.', 404, 'not_found');
}
export default {
  async fetch(request, env, ctx) {
    let headers = {};
    try {
      headers = cors(request, env);
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
      return json(await routes(request, env, ctx, new URL(request.url)), 200, headers);
    } catch (error) {
      return json(
        { error: safeMessage(error), code: error.code || 'internal_error' },
        error.status || 500,
        headers,
      );
    }
  },
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(scheduler(env));
  },
  async queue(batch, env, ctx) {
    for (const message of batch.messages) {
      try {
        const outcome = await processJob(env, message.body?.id);
        message.ack();
      } catch {
        message.retry({ delaySeconds: 300 });
      }
    }
    ctx.waitUntil(dispatch(env).catch(() => {}));
  },
};
