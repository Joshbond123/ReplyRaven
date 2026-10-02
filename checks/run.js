import assert from 'node:assert/strict';
import { hkdfSync } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { sqliteBinding } from '../scripts/sqlite-binding.js';
import app from '../backend/index.js';
import {
  DAY,
  DEFAULT_AUTOMATION,
  billingAllows,
  nextDue,
  normalizeAutomation,
  normalizeNotifications,
  publicURL,
} from '../backend/lib/core.js';
import {
  hashPassword,
  passwordMatches,
  seal,
  open,
  login,
  b64url,
  unb64url,
} from '../backend/lib/security.js';
import { all, business, getSetting, one, run, setSetting } from '../backend/lib/db.js';
import { enqueue, dispatch, recover } from '../backend/lib/outbox.js';
import { processJob, postUnreplied, resumeJobs } from '../backend/lib/jobs.js';
import { notify, reminders, deliverNotification } from '../backend/lib/notifications.js';
import { modelsFor, addKey, generate } from '../backend/lib/ai.js';
import { sendPush } from '../backend/lib/push.js';
let count = 0;
async function check(name, fn) {
  try {
    await fn();
    count++;
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}: ${error.message}`);
    throw error;
  }
}
const DB = sqliteBinding();
await DB.exec(await readFile(resolve('backend/migrations/0001.sql'), 'utf8'));
const password = crypto.randomUUID(),
  env = {
    DB,
    SESSION_SECRET: crypto.randomUUID() + crypto.randomUUID(),
    VAULT_SECRET: crypto.randomUUID() + crypto.randomUUID(),
    ADMIN_PASSWORD_HASH: await hashPassword(password),
    CORS_ORIGINS: 'https://joshbond123.github.io',
    PUBLIC_SITE_URL: 'https://joshbond123.github.io/ReplyRaven/',
    GOOGLE_CLIENT_ID: crypto.randomUUID(),
    GOOGLE_CLIENT_SECRET: crypto.randomUUID(),
    GOOGLE_REFRESH_TOKEN: crypto.randomUUID(),
    GOOGLE_TOKEN_LIFETIME_DAYS: '7',
    ADMIN_EMAIL: 'owner@replyraven.invalid',
  };
const waits = [];
const ctx = {
  waitUntil(promise) {
    waits.push(promise.catch(() => {}));
  },
};
let auth = '';
async function request(
  path,
  { method = 'GET', body, origin = 'https://joshbond123.github.io', token = auth } = {},
) {
  const response = await app.fetch(
    new Request(`https://api.replyraven.invalid${path}`, {
      method,
      headers: {
        Origin: origin,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
    env,
    ctx,
  );
  return { status: response.status, body: await response.json(), headers: response.headers };
}
const model = 'model-' + crypto.randomUUID().slice(0, 8),
  keyValue = 'private-' + crypto.randomUUID();
let remoteReviews = [],
  remoteReply = null,
  putCount = 0,
  mode = 'normal',
  keyFailures = 0,
  lastPrompt = '',
  pushRequest = null;
const nativeFetch = globalThis.fetch;
globalThis.fetch = async (url, options = {}) => {
  const target = String(url);
  if (target.includes('oauth2.googleapis.com'))
    return Response.json({ access_token: crypto.randomUUID(), expires_in: 3600 });
  if (target.includes('/v1/models') || target.includes('/v1beta/models')) {
    if (options.headers?.Authorization?.endsWith('invalid'))
      return Response.json({ error: {} }, { status: 401 });
    if (target.includes('generativelanguage'))
      return Response.json({
        models: [
          { name: 'models/' + model, displayName: model, supportedGenerationMethods: ['generateContent'] },
        ],
      });
    return Response.json({ data: [{ id: model }, { id: 'embedding-vector' }] });
  }
  if (target.includes('/locations/') && target.includes('businessinformation'))
    return Response.json({
      name: 'locations/' + remoteReviews[0]?.locationId,
      title: 'Brand ' + crypto.randomUUID().slice(0, 6),
      profile: { description: 'A locally owned business.' },
      storefrontAddress: { locality: 'Ibadan' },
      websiteUri: '',
    });
  if (target.includes('mybusiness.googleapis.com') && target.endsWith('/reply')) {
    if (options.method === 'PUT') {
      putCount++;
      if (mode === 'uncertain') return Response.json({ error: {} }, { status: 503 });
      remoteReply = { comment: JSON.parse(options.body).comment, updateTime: new Date().toISOString() };
      return Response.json(remoteReply);
    }
    if (options.method === 'DELETE') {
      remoteReply = null;
      return new Response(null, { status: 204 });
    }
  }
  if (target.includes('mybusiness.googleapis.com') && target.includes('/reviews?'))
    return Response.json({
      reviews: remoteReviews,
      averageRating: 4.5,
      totalReviewCount: remoteReviews.length,
    });
  if (target.includes('mybusiness.googleapis.com') && target.includes('/reviews/')) {
    const id = decodeURIComponent(target.split('/').at(-1));
    const remote = remoteReviews.find((row) => row.reviewId === id);
    return remote
      ? Response.json({ ...remote, ...(remoteReply ? { reviewReply: remoteReply } : {}) })
      : Response.json({ error: {} }, { status: 404 });
  }
  if (target.startsWith('https://fcm.googleapis.com/fcm/send/')) {
    pushRequest = { url: target, ...options };
    return new Response(null, { status: 201 });
  }
  if (target.includes('/chat/completions')) {
    lastPrompt = JSON.parse(options.body).messages.at(-1).content;
    if (mode === 'limited' && keyFailures++ === 0)
      return Response.json({ error: {} }, { status: 429, headers: { 'Retry-After': '90' } });
    if (mode === 'human')
      remoteReply = { comment: 'An owner response already posted.', updateTime: new Date().toISOString() };
    if (mode === 'pause') await setSetting(env, 'automation', { ...DEFAULT_AUTOMATION, enabled: false });
    const structured = Boolean(JSON.parse(options.body).response_format);
    return Response.json({
      choices: [
        {
          message: {
            content: structured
              ? JSON.stringify({
                  summary: 'An approachable local brand.',
                  tone: 'Warm and clear',
                  language: 'English',
                  audience: 'Local customers',
                  reply_style: 'Thank the customer and reference their feedback.',
                  facts: ['Locally owned'],
                  avoid: ['Unverified promises'],
                  sign_off: '',
                  max_words: 100,
                })
              : 'Thank you for sharing your experience. We appreciate your support and look forward to welcoming you again.',
          },
        },
      ],
    });
  }
  if (target === 'https://api.resend.com/emails') {
    if (mode === 'email_failure') return Response.json({ error: {} }, { status: 503 });
    return Response.json({ id: crypto.randomUUID() });
  }
  throw new Error('Unexpected outbound request');
};
async function createBusiness(extra = {}) {
  const id = crypto.randomUUID(),
    now = Date.now(),
    voice = {
      summary: 'A locally owned brand.',
      tone: 'Warm',
      reply_style: 'Be concise and personal.',
      language: 'English',
      max_words: 100,
    };
  await run(
    env,
    "INSERT INTO businesses(id,google_location_id,google_account_id,name,created_at,updated_at,auto_reply,voice_status,voice_profile) VALUES(?,?,?,?,?,?,1,'ready',?)",
    id,
    crypto.randomUUID(),
    crypto.randomUUID(),
    'Brand ' + id.slice(0, 8),
    now - 10000,
    now,
    JSON.stringify(voice),
  );
  for (const [field, value] of Object.entries(extra))
    await run(env, `UPDATE businesses SET ${field}=? WHERE id=?`, value, id);
  return business(env, id);
}
async function createReview(biz, { rating = 5, replied = false, historical = false } = {}) {
  const id = crypto.randomUUID(),
    googleId = crypto.randomUUID(),
    now = Date.now();
  await run(
    env,
    'INSERT INTO reviews(id,business_id,google_review_id,reviewer,rating,comment,created_at,updated_at,detected_at,reply,reply_state,had_reply,historical,eligible_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    id,
    biz.id,
    googleId,
    'Customer ' + id.slice(0, 6),
    rating,
    'A thoughtful customer comment.',
    now - 1000,
    now - 1000,
    now,
    replied ? 'Existing owner response' : null,
    replied ? 'replied' : 'scheduled',
    replied ? 1 : 0,
    historical ? 1 : 0,
    now - 1,
  );
  remoteReviews = [
    {
      reviewId: googleId,
      locationId: biz.google_location_id,
      starRating: rating === 5 ? 'FIVE' : rating === 4 ? 'FOUR' : 'THREE',
      comment: 'A thoughtful customer comment.',
      reviewer: { displayName: 'Customer ' + id.slice(0, 6) },
      createTime: new Date(now - 1000).toISOString(),
      updateTime: new Date(now - 1000).toISOString(),
    },
  ];
  remoteReply = null;
  return one(env, 'SELECT * FROM reviews WHERE id=?', id);
}
try {
  await check('migration is repeatable and starts with no businesses', async () => {
    await DB.exec(await readFile('backend/migrations/0001.sql', 'utf8'));
    assert.equal((await one(env, 'SELECT COUNT(*) AS count FROM businesses')).count, 0);
  });
  await check('health reports real storage readiness', async () => {
    const result = await request('/health', { token: '' });
    assert.equal(result.status, 200);
    assert.equal(result.body.storage, 'connected');
  });
  await check('private routes reject unsigned access', async () => {
    assert.equal((await request('/state', { token: '' })).status, 401);
  });
  await check('CORS rejects unapproved origins', async () => {
    assert.equal((await request('/health', { origin: 'https://unapproved.invalid', token: '' })).status, 403);
  });
  await check('password hashes validate without plaintext storage', async () => {
    assert.equal(await passwordMatches(password, env.ADMIN_PASSWORD_HASH), true);
    assert.equal(await passwordMatches(crypto.randomUUID(), env.ADMIN_PASSWORD_HASH), false);
  });
  await check('owner login issues a signed server session', async () => {
    const result = await request('/auth/login', { method: 'POST', body: { password }, token: '' });
    assert.equal(result.status, 200);
    auth = result.body.token;
    assert.ok(result.body.expires_at > Date.now());
    assert.equal((await request('/auth/session')).status, 200);
  });
  await check('vault ciphertext is bound to its record context', async () => {
    const secret = crypto.randomUUID(),
      cipher = await seal(env, secret, 'one');
    assert.notEqual(cipher, secret);
    assert.equal(await open(env, cipher, 'one'), secret);
    await assert.rejects(() => open(env, cipher, 'two'));
  });
  await check('credentials never appear in settings responses', async () => {
    const result = await request('/settings');
    assert.equal(result.status, 200);
    const raw = JSON.stringify(result.body);
    assert.ok(!raw.includes(env.GOOGLE_CLIENT_SECRET));
    assert.ok(!raw.includes(env.GOOGLE_REFRESH_TOKEN));
    assert.equal(result.body.google.client_secret_saved, true);
  });
  await check('monthly and yearly dates handle short months', async () => {
    assert.equal(
      new Date(nextDue(Date.UTC(2026, 0, 31), 'monthly')).toISOString().slice(0, 10),
      '2026-02-28',
    );
    assert.equal(new Date(nextDue(Date.UTC(2024, 1, 29), 'yearly')).toISOString().slice(0, 10), '2025-02-28');
  });
  await check('optional billing gates do not block unbilled businesses', async () => {
    assert.equal(billingAllows({ billing_enabled: 0, payment_status: 'expired' }), true);
    assert.equal(
      billingAllows({
        billing_enabled: 1,
        payment_status: 'trial',
        trial_enabled: 1,
        trial_ends_at: Date.now() - 1,
      }),
      false,
    );
  });
  await check('interval and delay settings stay within safe boundaries', async () => {
    assert.deepEqual(normalizeAutomation({ enabled: true, interval: 120, delay_min: 1, delay_max: 90 }), {
      enabled: true,
      interval: 120,
      delay_min: 5,
      delay_max: 30,
    });
  });
  await check('notification email requires a valid address', async () => {
    assert.throws(() => normalizeNotifications({ email: true, email_address: 'not-an-address' }));
  });
  await check('website learning refuses local addresses', async () => {
    for (const value of [
      'http://localhost',
      'https://127.0.0.1',
      'https://[::1]',
      'https://localhost',
      'https://app.internal',
    ])
      assert.throws(() => publicURL(value));
  });
  await check('provider models are fetched for the submitted key', async () => {
    const models = await modelsFor('openai', keyValue);
    assert.deepEqual(
      models.map((row) => row.id),
      [model],
    );
    await assert.rejects(() => modelsFor('openai', 'private-invalid'));
  });
  await check('saved API keys are encrypted and expose only a suffix', async () => {
    const result = await request('/ai/keys', {
      method: 'POST',
      body: { provider: 'openai', api_key: keyValue, model },
    });
    assert.equal(result.status, 200);
    assert.ok(!JSON.stringify(result.body).includes(keyValue));
    const row = await one(env, 'SELECT * FROM ai_keys WHERE id=?', result.body.key.id);
    assert.notEqual(row.ciphertext, keyValue);
  });
  await check('round-robin fails over on a rate-limited key', async () => {
    await addKey(env, { provider: 'openai', api_key: 'private-' + crypto.randomUUID(), model });
    mode = 'limited';
    const output = await generate(env, 'Write a reply.', 'Customer feedback');
    assert.ok(output.text);
    assert.equal(
      (await one(env, "SELECT COUNT(*) AS count FROM ai_keys WHERE health='rate_limited'")).count,
      1,
    );
    mode = 'normal';
  });
  await check('no key plaintext is returned to the browser', async () => {
    const response = await request('/ai/keys');
    assert.ok(response.body.keys.every((row) => !row.api_key && !row.ciphertext));
  });
  await check('job enqueue deduplicates repeated work', async () => {
    const key = crypto.randomUUID(),
      first = await enqueue(env, 'maintenance', null, {}, key),
      second = await enqueue(env, 'maintenance', null, {}, key);
    assert.equal(first.id, second.id);
  });
  await check('remote owner replies are never overwritten', async () => {
    await setSetting(env, 'automation', { ...DEFAULT_AUTOMATION, enabled: true });
    const biz = await createBusiness(),
      row = await createReview(biz);
    remoteReply = { comment: 'An owner response already posted.', updateTime: new Date().toISOString() };
    const before = putCount;
    await assert.rejects(() => postUnreplied(env, biz, row, 'A new reply'));
    assert.equal(putCount, before);
    assert.equal((await one(env, 'SELECT * FROM reviews WHERE id=?', row.id)).had_reply, 1);
  });
  await check('a low-star edit prevents an automated post', async () => {
    const biz = await createBusiness(),
      row = await createReview(biz, { rating: 3 }),
      job = await enqueue(env, 'reply', row.id, {}, crypto.randomUUID());
    const before = putCount;
    await processJob(env, job.id);
    assert.equal(putCount, before);
  });
  await check('an owner reply during generation is detected before PUT', async () => {
    const biz = await createBusiness(),
      row = await createReview(biz),
      job = await enqueue(env, 'reply', row.id, {}, crypto.randomUUID());
    mode = 'human';
    const before = putCount;
    await processJob(env, job.id);
    assert.equal(putCount, before);
    mode = 'normal';
  });
  await check('master pause during generation stops the write', async () => {
    await setSetting(env, 'automation', { ...DEFAULT_AUTOMATION, enabled: true });
    const biz = await createBusiness(),
      row = await createReview(biz),
      job = await enqueue(env, 'reply', row.id, {}, crypto.randomUUID());
    mode = 'pause';
    const before = putCount;
    await processJob(env, job.id);
    assert.equal(putCount, before);
    assert.equal((await one(env, 'SELECT state FROM jobs WHERE id=?', job.id)).state, 'blocked');
    mode = 'normal';
  });
  await check('an expired trial blocks generation and posting', async () => {
    await setSetting(env, 'automation', { ...DEFAULT_AUTOMATION, enabled: true });
    const biz = await createBusiness({
        billing_enabled: 1,
        trial_enabled: 1,
        payment_status: 'trial',
        trial_ends_at: Date.now() - 1,
      }),
      row = await createReview(biz),
      job = await enqueue(env, 'reply', row.id, {}, crypto.randomUUID());
    const before = putCount;
    await processJob(env, job.id);
    assert.equal(putCount, before);
    assert.equal((await one(env, 'SELECT state FROM jobs WHERE id=?', job.id)).state, 'blocked');
  });
  await check('Mark as Paid clears the billing pause without forcing opt-in', async () => {
    const biz = await createBusiness({
      billing_enabled: 1,
      subscription_enabled: 1,
      payment_status: 'expired',
      auto_reply: 0,
      amount: 25000,
      currency: 'NGN',
    });
    const response = await request(`/businesses/${biz.id}/mark-paid`, { method: 'POST', body: {} });
    assert.equal(response.status, 200);
    assert.equal(response.body.business.payment_status, 'active');
    assert.equal(response.body.business.auto_reply, false);
    assert.equal(response.body.business.billing_allowed, true);
    assert.equal(
      (await one(env, 'SELECT COUNT(*) AS count FROM payments WHERE business_id=?', biz.id)).count,
      1,
    );
  });
  await check('brand learning reads authorized profile and twenty recent reviews', async () => {
    const biz = await createBusiness(),
      row = await createReview(biz),
      job = await enqueue(env, 'learn', biz.id, {}, crypto.randomUUID());
    await processJob(env, job.id);
    const result = await business(env, biz.id);
    assert.equal(result.voice_status, 'ready');
    assert.ok(parseJSONValue(result.voice_profile).tone);
    assert.ok(lastPrompt.includes('customer_reviews'));
    assert.equal(parseJSONValue(result.voice_sources).review_count, 1);
  });
  await check('voice profiles can be inspected and edited', async () => {
    const biz = await createBusiness();
    const voice = {
      summary: 'An independent brand.',
      tone: 'Friendly',
      reply_style: 'Be warm and specific.',
      max_words: 90,
    };
    const response = await request(`/businesses/${biz.id}/voice`, { method: 'PUT', body: { voice } });
    assert.equal(response.status, 200);
    assert.equal(response.body.voice.tone, 'Friendly');
  });
  await check('a safe automatic reply posts and records its actual result', async () => {
    await setSetting(env, 'automation', { ...DEFAULT_AUTOMATION, enabled: true });
    const biz = await createBusiness(),
      row = await createReview(biz),
      job = await enqueue(env, 'reply', row.id, {}, crypto.randomUUID());
    const before = putCount;
    await processJob(env, job.id);
    assert.equal(putCount, before + 1);
    const stored = await one(env, 'SELECT * FROM reviews WHERE id=?', row.id);
    assert.equal(stored.reply_source, 'ai');
    assert.equal(stored.had_reply, 1);
  });
  await check('ambiguous Google PUT results block all blind replays', async () => {
    const biz = await createBusiness(),
      row = await createReview(biz),
      job = await enqueue(env, 'reply', row.id, {}, crypto.randomUUID());
    mode = 'uncertain';
    const before = putCount;
    await processJob(env, job.id);
    assert.equal(putCount, before + 1);
    assert.equal(
      (await one(env, 'SELECT reply_state FROM reviews WHERE id=?', row.id)).reply_state,
      'uncertain',
    );
    await processJob(env, job.id);
    assert.equal(putCount, before + 1);
    mode = 'normal';
  });
  await check('day-six connection reminders are durable and deduplicated', async () => {
    const stamp = Date.now() - 6 * DAY;
    await setSetting(env, 'google_connection', { connected_at: stamp });
    await reminders(env);
    await reminders(env);
    assert.equal(
      (await one(env, 'SELECT COUNT(*) AS count FROM notifications WHERE dedupe_key=?', `google:${stamp}:1`))
        .count,
      1,
    );
  });
  await check('trial expiry stores a notification and stops eligibility', async () => {
    await setSetting(env, 'reminder_cursor', '');
    await run(env, 'UPDATE businesses SET billing_enabled=0');
    const biz = await createBusiness({
      billing_enabled: 1,
      trial_enabled: 1,
      payment_status: 'trial',
      trial_ends_at: Date.now() - 1,
    });
    await reminders(env);
    assert.equal((await business(env, biz.id)).payment_status, 'expired');
    assert.equal(
      (
        await one(
          env,
          "SELECT COUNT(*) AS count FROM notifications WHERE business_id=? AND kind='trial_ending'",
          biz.id,
        )
      ).count,
      1,
    );
  });
  await check('notification toggles prevent unwanted events', async () => {
    await setSetting(env, 'notifications', { enabled: false });
    const result = await notify(
      env,
      'reply_success',
      'Reply received',
      'A reply completed.',
      crypto.randomUUID(),
    );
    assert.equal(result, null);
    await setSetting(env, 'notifications', { enabled: true, in_app: true });
  });
  await check('email outages retain delivery records for retry', async () => {
    env.RESEND_API_KEY = crypto.randomUUID();
    env.EMAIL_FROM = 'reply@replyraven.invalid';
    await setSetting(env, 'notifications', {
      enabled: true,
      email: true,
      email_address: 'owner@replyraven.invalid',
      in_app: true,
    });
    const event = await notify(
      env,
      'reply_success',
      'A reply completed',
      'Your business has a new reply.',
      crypto.randomUUID(),
    );
    mode = 'email_failure';
    await assert.rejects(() => deliverNotification(env, event.id));
    assert.equal(
      (await one(env, 'SELECT state FROM deliveries WHERE notification_id=?', event.id)).state,
      'delayed',
    );
    mode = 'normal';
    await deliverNotification(env, event.id);
    assert.equal(
      (await one(env, 'SELECT state FROM deliveries WHERE notification_id=?', event.id)).state,
      'sent',
    );
  });
  await check('business list pagination has no application business cap', async () => {
    const response = await request('/businesses?page=1');
    assert.equal(response.status, 200);
    assert.ok(response.body.total > 0);
    assert.ok(response.body.businesses.length <= 24);
  });
  await check('invalid password attempts cannot bypass backend authentication', async () => {
    const response = await request('/auth/login', {
      method: 'POST',
      body: { password: crypto.randomUUID() },
      token: '',
    });
    assert.equal(response.status, 401);
  });
  await check('public UI source has no retired content or credential values', async () => {
    const files = [
      'app.js',
      'auth.js',
      'index.html',
      'login.html',
      'dashboard.html',
      'business.html',
      'settings.html',
      'notifications.html',
      'styles.css',
    ];
    const forbidden = new RegExp(
      '\\b(?:' +
        ['de' + 'mo', 'ex' + 'ample', 'te' + 'st'].join('|') +
        ')\\b|Google\\s+' +
        'Sheets?|' +
        'GitHub\\s+' +
        'Actions?',
      'i',
    );
    for (const path of files) {
      const source = await readFile(path, 'utf8');
      assert.equal(forbidden.exec(source), null, path);
      assert.ok(!source.includes(env.GOOGLE_CLIENT_SECRET));
    }
  });

  await check('initial sync skips historical replies unless explicitly selected', async () => {
    await setSetting(env, 'automation', { ...DEFAULT_AUTOMATION, enabled: true });
    const biz = await createBusiness(),
      stamp = Date.now();
    remoteReviews = [
      {
        reviewId: crypto.randomUUID(),
        starRating: 'FIVE',
        createTime: new Date(stamp - DAY).toISOString(),
        updateTime: new Date(stamp - DAY).toISOString(),
        comment: 'Earlier feedback',
      },
      {
        reviewId: crypto.randomUUID(),
        starRating: 'FIVE',
        createTime: new Date(stamp).toISOString(),
        updateTime: new Date(stamp).toISOString(),
        comment: 'New feedback',
      },
      {
        reviewId: crypto.randomUUID(),
        starRating: 'THREE',
        createTime: new Date(stamp).toISOString(),
        updateTime: new Date(stamp).toISOString(),
        comment: 'Feedback needs care',
      },
      {
        reviewId: crypto.randomUUID(),
        starRating: 'FIVE',
        createTime: new Date(stamp).toISOString(),
        updateTime: new Date(stamp).toISOString(),
        reviewReply: { comment: 'An existing response', updateTime: new Date(stamp).toISOString() },
      },
    ];
    const job = await enqueue(env, 'sync', biz.id, {}, crypto.randomUUID());
    await processJob(env, job.id);
    assert.equal((await one(env, 'SELECT state FROM jobs WHERE id=?', job.id)).state, 'done');
    const rows = await all(env, 'SELECT * FROM reviews WHERE business_id=?', biz.id);
    assert.equal(rows.length, 4);
    assert.equal(rows.find((row) => row.historical).reply_state, 'unreplied');
    const fresh = rows.find((row) => !row.historical && row.rating === 5 && !row.had_reply);
    assert.equal(fresh.reply_state, 'scheduled');
    const queued = await one(env, "SELECT * FROM jobs WHERE entity_id=? AND kind='reply'", fresh.id);
    assert.ok(queued.available_at >= stamp + 5 * 60000 && queued.available_at <= Date.now() + 30 * 60000);
    assert.equal(rows.find((row) => row.had_reply).reply_state, 'replied');
    assert.equal(rows.find((row) => row.rating === 3).reply_state, 'unreplied');
    const historical = rows.find((row) => row.historical),
      backfill = await enqueue(env, 'backfill', biz.id, { limit: 1 }, crypto.randomUUID());
    await processJob(env, backfill.id);
    assert.equal(
      (await one(env, 'SELECT reply_state FROM reviews WHERE id=?', historical.id)).reply_state,
      'scheduled',
    );
  });
  await check('manual replies also respect uncertain-write quarantine', async () => {
    const biz = await createBusiness(),
      row = await createReview(biz);
    await run(env, "UPDATE reviews SET reply_state='uncertain' WHERE id=?", row.id);
    const before = putCount;
    assert.equal(
      (
        await request(`/reviews/${row.id}/reply`, {
          method: 'POST',
          body: { comment: 'An intentional owner response.' },
        })
      ).status,
      409,
    );
    assert.equal(putCount, before);
    const verified = await request(`/reviews/${row.id}/reconcile`, { method: 'POST', body: {} });
    assert.equal(verified.body.review.reply_state, 'uncertain');
    const cleared = await request(`/reviews/${row.id}/reconcile`, {
      method: 'POST',
      body: { confirm_no_reply: true },
    });
    assert.equal(cleared.body.review.reply_state, 'unreplied');
    assert.equal(cleared.body.review.historical, 1);
    assert.equal(cleared.body.review.eligible_at, null);
  });
  await check('ordinary editing cannot reset an expired subscription', async () => {
    const biz = await createBusiness({
      billing_enabled: 1,
      subscription_enabled: 1,
      payment_status: 'expired',
    });
    const response = await request(`/businesses/${biz.id}`, {
      method: 'PUT',
      body: { payment_status: 'active' },
    });
    assert.ok([400, 409].includes(response.status));
    assert.equal((await business(env, biz.id)).payment_status, 'expired');
  });
  await check('Mark as Paid resumes previously blocked opted-in replies', async () => {
    const biz = await createBusiness({
        billing_enabled: 1,
        subscription_enabled: 1,
        payment_status: 'expired',
        amount: 127,
      }),
      row = await createReview(biz),
      job = await enqueue(env, 'reply', row.id, {}, crypto.randomUUID());
    await processJob(env, job.id);
    assert.equal((await one(env, 'SELECT state FROM jobs WHERE id=?', job.id)).state, 'blocked');
    await request(`/businesses/${biz.id}/mark-paid`, { method: 'POST', body: {} });
    assert.equal((await one(env, 'SELECT state FROM jobs WHERE id=?', job.id)).state, 'pending');
    assert.equal(
      (await one(env, 'SELECT reply_state FROM reviews WHERE id=?', row.id)).reply_state,
      'scheduled',
    );
  });
  await check('future queue delivery uses the target delay without repeated dispatch', async () => {
    const messages = [];
    env.JOBS = {
      async sendBatch(batch) {
        messages.push(...batch);
      },
    };
    await run(env, "UPDATE jobs SET state='done' WHERE state='pending'");
    const due = Date.now() + 10 * 60000,
      job = await enqueue(env, 'maintenance', null, {}, crypto.randomUUID(), due);
    const result = await dispatch(env);
    assert.equal(result.dispatched, 1);
    assert.equal(messages[0].body.id, job.id);
    assert.ok(messages[0].delaySeconds >= 599 && messages[0].delaySeconds <= 600);
    assert.equal((await dispatch(env)).dispatched, 0);
    delete env.JOBS;
  });
  await check('exhausted notification attempts remain recoverable', async () => {
    const job = await enqueue(env, 'notification', crypto.randomUUID(), {}, crypto.randomUUID());
    await run(
      env,
      "UPDATE jobs SET state='failed',attempts=8,updated_at=? WHERE id=?",
      Date.now() - 7 * 3600000,
      job.id,
    );
    await recover(env);
    const row = await one(env, 'SELECT * FROM jobs WHERE id=?', job.id);
    assert.equal(row.state, 'pending');
    assert.equal(row.attempts, 0);
  });
  await check('maintenance pagination queues continuations for large account sets', async () => {
    await run(env, 'UPDATE businesses SET billing_enabled=0');
    for (let index = 0; index < 6; index++)
      await createBusiness({
        billing_enabled: 1,
        subscription_enabled: 1,
        next_due_at: Date.now() + 10 * DAY,
      });
    await setSetting(env, 'reminder_cursor', '');
    await reminders(env);
    assert.ok(
      (await one(env, "SELECT COUNT(*) AS count FROM jobs WHERE dedupe_key LIKE 'maintenance-page:%'"))
        .count > 0,
    );
  });
  await check('server-stored provider keys discover models without exposing secrets', async () => {
    env.GEMINI_API_KEY = 'private-' + crypto.randomUUID();
    const result = await request('/ai/models', {
      method: 'POST',
      body: { provider: 'gemini', use_saved_key: true },
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.models[0].id, model);
    assert.ok(!JSON.stringify(result.body).includes(env.GEMINI_API_KEY));
    assert.equal((await request('/settings')).body.capabilities.stored_providers.includes('gemini'), true);
  });
  await check('Web Push payload encryption and VAPID signatures validate independently', async () => {
    const receiver = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
        'deriveBits',
      ]),
      sender = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
        'sign',
        'verify',
      ]);
    const publicReceiver = new Uint8Array(await crypto.subtle.exportKey('raw', receiver.publicKey)),
      authSecret = crypto.getRandomValues(new Uint8Array(16));
    env.VAPID_PUBLIC_KEY = b64url(await crypto.subtle.exportKey('raw', sender.publicKey));
    env.VAPID_PRIVATE_KEY = (await crypto.subtle.exportKey('jwk', sender.privateKey)).d;
    const payload = {
      title: 'A private notification',
      body: 'A durable delivery update.',
      url: env.PUBLIC_SITE_URL,
    };
    await sendPush(
      env,
      {
        endpoint: 'https://fcm.googleapis.com/fcm/send/' + crypto.randomUUID(),
        keys: { p256dh: b64url(publicReceiver), auth: b64url(authSecret) },
      },
      payload,
    );
    const headers = new Headers(pushRequest.headers),
      jwt = /t=([^,]+)/.exec(headers.get('Authorization'))[1];
    const parts = jwt.split('.');
    assert.equal(JSON.parse(new TextDecoder().decode(unb64url(parts[1]))).aud, 'https://fcm.googleapis.com');
    assert.equal(
      await crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        sender.publicKey,
        unb64url(parts[2]),
        new TextEncoder().encode(parts.slice(0, 2).join('.')),
      ),
      true,
    );
    const data = new Uint8Array(pushRequest.body),
      salt = data.slice(0, 16),
      serverPublic = data.slice(21, 21 + data[20]),
      serverKey = await crypto.subtle.importKey(
        'raw',
        serverPublic,
        { name: 'ECDH', namedCurve: 'P-256' },
        false,
        [],
      ),
      shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: serverKey }, receiver.privateKey, 256);
    const ikm = hkdfSync(
        'sha256',
        Buffer.from(shared),
        authSecret,
        Buffer.concat([Buffer.from('WebPush: info\0'), publicReceiver, serverPublic]),
        32,
      ),
      key = hkdfSync('sha256', Buffer.from(ikm), salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16),
      nonce = hkdfSync('sha256', Buffer.from(ikm), salt, Buffer.from('Content-Encoding: nonce\0'), 12);
    const plain = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: new Uint8Array(nonce) },
        await crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['decrypt']),
        data.slice(21 + data[20]),
      ),
    );
    assert.equal(plain.at(-1), 2);
    assert.deepEqual(JSON.parse(new TextDecoder().decode(plain.slice(0, -1))), payload);
  });
  await check('changing the owner password revokes previously signed sessions', async () => {
    const fresh = crypto.randomUUID(),
      response = await request('/settings/account', {
        method: 'PUT',
        body: { current_password: password, new_password: fresh },
      });
    assert.equal(response.status, 200);
    assert.equal(response.body.reauthenticate, true);
    assert.equal((await request('/auth/session')).status, 401);
    const updated = await request('/auth/login', { method: 'POST', body: { password: fresh }, token: '' });
    assert.equal(updated.status, 200);
    auth = updated.body.token;
    assert.equal((await request('/auth/session')).status, 200);
  });
  console.log(`${count} checks passed.`);
} finally {
  await Promise.all(waits);
  globalThis.fetch = nativeFetch;
  DB.close();
}
function parseJSONValue(value) {
  return JSON.parse(value);
}
