import {
  AppError,
  DEFAULT_AUTOMATION,
  automatedEligibility,
  billingAllows,
  ensure,
  hasReply,
  normalizeAutomation,
  parseJSON,
  randomDelay,
  safeMessage,
} from './core.js';
import { all, business, getSetting, log, one, run, setSetting } from './db.js';
import { googleClient, normalizeReview as reviewData, websiteText } from './google.js';
import { draftReply, learnVoice } from './ai.js';
import { claim, dispatch, enqueue, recover } from './outbox.js';
import { deliverNotification, notify, reminders } from './notifications.js';

export async function reviewWriteLease(env, reviewId, owner) {
  return one(
    env,
    'UPDATE reviews SET write_owner=?,write_lease_until=? WHERE id=? AND (write_lease_until IS NULL OR write_lease_until<?) RETURNING *',
    owner,
    Date.now() + 300000,
    reviewId,
    Date.now(),
  );
}
export async function releaseWrite(env, reviewId, owner) {
  await run(
    env,
    'UPDATE reviews SET write_owner=NULL,write_lease_until=NULL WHERE id=? AND write_owner=?',
    reviewId,
    owner,
  );
}
async function recordRemote(env, row, remote) {
  const item = reviewData(remote);
  await run(
    env,
    "UPDATE reviews SET rating=?,comment=?,reviewer=?,updated_at=?,reply=?,replied_at=?,reply_state=CASE WHEN ?=1 THEN 'replied' WHEN reply_state='uncertain' THEN 'uncertain' WHEN ?<4 OR reply_state='replied' THEN 'unreplied' ELSE reply_state END,had_reply=MAX(had_reply,?),eligible_at=CASE WHEN ?=1 OR ?<4 THEN NULL ELSE eligible_at END,reply_source=CASE WHEN ? IS NULL THEN NULL WHEN reply=? THEN reply_source ELSE 'google' END WHERE id=?",
    item.rating,
    item.comment,
    item.reviewer,
    item.updated_at,
    item.reply,
    item.replied_at,
    item.has_reply ? 1 : 0,
    item.rating,
    item.has_reply ? 1 : 0,
    item.has_reply ? 1 : 0,
    item.rating,
    item.reply,
    item.reply,
    row.id,
  );
  return item;
}
export async function refreshReview(env, biz, row) {
  const google = await googleClient(env);
  const remote = await google.review(biz, row.google_review_id);
  return { google, remote, item: await recordRemote(env, row, remote) };
}
async function syncJob(env, job, payload) {
  let biz = await business(env, job.entity_id);
  if (!biz) return;
  const runId = payload.run || job.id,
    now = Date.now();
  if (biz.sync_run && biz.sync_run !== runId && biz.sync_heartbeat > now - 1800000) return;
  if (payload.run && biz.sync_run !== payload.run) return;
  await run(
    env,
    'UPDATE businesses SET sync_run=?,sync_heartbeat=?,sync_error=NULL WHERE id=?',
    runId,
    now,
    biz.id,
  );
  const google = await googleClient(env),
    response = await google.reviews(biz, payload.page_token || '', 20);
  const settings = normalizeAutomation(await getSetting(env, 'automation', DEFAULT_AUTOMATION));
  const unique = new Map();
  for (const remote of response.reviews || []) {
    const item = reviewData(remote),
      prior = unique.get(item.google_review_id);
    if (!prior || item.updated_at >= prior.updated_at) unique.set(item.google_review_id, item);
  }
  const statements = [];
  for (const item of unique.values()) {
    const historical = item.created_at < biz.created_at,
      scheduled = !historical && item.rating >= 4 && !item.has_reply && biz.auto_reply && settings.enabled;
    const eligible = scheduled ? Date.now() + randomDelay(settings.delay_min, settings.delay_max) : null;
    statements.push(
      env.DB.prepare(
        `INSERT INTO reviews(id,business_id,google_review_id,reviewer,rating,comment,created_at,updated_at,detected_at,reply,replied_at,reply_source,reply_state,had_reply,historical,eligible_at,seen_run)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(business_id,google_review_id) DO UPDATE SET
      reviewer=CASE WHEN excluded.updated_at>=reviews.updated_at THEN excluded.reviewer ELSE reviews.reviewer END,
      rating=CASE WHEN excluded.updated_at>=reviews.updated_at THEN excluded.rating ELSE reviews.rating END,
      comment=CASE WHEN excluded.updated_at>=reviews.updated_at THEN excluded.comment ELSE reviews.comment END,
      updated_at=MAX(reviews.updated_at,excluded.updated_at),
      reply=CASE WHEN excluded.updated_at>=reviews.updated_at THEN excluded.reply ELSE reviews.reply END,
      replied_at=CASE WHEN excluded.updated_at>=reviews.updated_at THEN excluded.replied_at ELSE reviews.replied_at END,
      reply_source=CASE WHEN excluded.reply IS NOT NULL AND excluded.reply!=COALESCE(reviews.reply,'') THEN 'google' ELSE reviews.reply_source END,
      had_reply=MAX(reviews.had_reply,excluded.had_reply),
      reply_state=CASE WHEN excluded.reply IS NOT NULL THEN 'replied' WHEN excluded.rating<4 THEN 'unreplied' ELSE reviews.reply_state END,
      eligible_at=CASE WHEN excluded.reply IS NOT NULL OR excluded.rating<4 THEN NULL ELSE reviews.eligible_at END,
      seen_run=excluded.seen_run,archived=0`,
      ).bind(
        crypto.randomUUID(),
        biz.id,
        item.google_review_id,
        item.reviewer,
        item.rating,
        item.comment,
        item.created_at,
        item.updated_at,
        now,
        item.reply,
        item.replied_at,
        item.has_reply ? 'google' : null,
        item.has_reply ? 'replied' : scheduled ? 'scheduled' : 'unreplied',
        item.has_reply ? 1 : 0,
        historical ? 1 : 0,
        eligible,
        runId,
      ),
    );
  }
  if (statements.length) await env.DB.batch(statements);
  if (settings.enabled && biz.auto_reply)
    await run(
      env,
      `INSERT OR IGNORE INTO jobs(id,dedupe_key,kind,entity_id,payload,available_at,created_at,updated_at) SELECT lower(hex(randomblob(16))),'reply:'||id||':'||eligible_at,'reply',id,'{}',eligible_at,?,? FROM reviews WHERE business_id=? AND reply_state='scheduled' AND reply IS NULL AND had_reply=0 AND archived=0 AND eligible_at IS NOT NULL`,
      Date.now(),
      Date.now(),
      biz.id,
    );
  const next = response.nextPageToken;
  if (next) {
    ensure(next !== payload.page_token, 'Google repeated a review pagination cursor.', 502);
    await enqueue(env, 'sync', biz.id, { run: runId, page_token: next }, `sync-page:${runId}:${next}`);
  } else {
    await run(
      env,
      'UPDATE reviews SET archived=1 WHERE business_id=? AND (seen_run IS NULL OR seen_run!=?)',
      biz.id,
      runId,
    );
    await run(
      env,
      'UPDATE businesses SET review_count=?,average_rating=?,last_sync=?,next_sync=?,sync_run=NULL,sync_heartbeat=NULL,sync_error=NULL WHERE id=?',
      Number(response.totalReviewCount) || unique.size,
      Number(response.averageRating) || 0,
      Date.now(),
      Date.now() + settings.interval * 60000,
      biz.id,
    );
    await log(env, 'reviews_synced', 'All available Google review pages were synchronized.', biz.id);
    if (biz.backfill_limit > 0)
      await enqueue(env, 'backfill', biz.id, { limit: biz.backfill_limit }, `initial-backfill:${biz.id}`);
  }
}
async function learnJob(env, job) {
  const biz = await business(env, job.entity_id);
  if (!biz) return;
  await run(env, "UPDATE businesses SET voice_status='learning',voice_error=NULL WHERE id=?", biz.id);
  const google = await googleClient(env),
    profile = await google.profile(biz.google_location_id);
  let website = { text: '', url: biz.website || profile.websiteUri || '', status: 'unavailable' };
  try {
    website = await websiteText(biz.website || profile.websiteUri || '');
  } catch {
    website.status = 'unavailable';
  }
  const remote = await google.reviews(biz, '', 20),
    reviews = (remote.reviews || []).map(reviewData);
  const voice = await learnVoice(env, biz, profile, website, reviews);
  const sources = {
    google_profile: true,
    website_url: website.url,
    website_status: website.status,
    review_count: reviews.length,
    learned_at: Date.now(),
  };
  await run(
    env,
    "UPDATE businesses SET voice_status='ready',voice_profile=?,voice_sources=?,voice_error=NULL,updated_at=? WHERE id=?",
    JSON.stringify(voice),
    JSON.stringify(sources),
    Date.now(),
    biz.id,
  );
  await log(
    env,
    'voice_learned',
    'Brand voice learned from the authorized profile, available website content, and recent reviews.',
    biz.id,
  );
}
async function backfillJob(env, job, payload) {
  const biz = await business(env, job.entity_id);
  if (!biz) return;
  if (biz.sync_run || !biz.last_sync) return { defer: 300, reason: 'Waiting for complete review sync.' };
  const settings = normalizeAutomation(await getSetting(env, 'automation', DEFAULT_AUTOMATION)),
    limit = Math.min(1000, Math.max(1, Number(payload.limit) || 1));
  const rows = await all(
    env,
    "SELECT id FROM reviews WHERE business_id=? AND rating>=4 AND reply IS NULL AND had_reply=0 AND archived=0 AND reply_state IN ('unreplied','paused') ORDER BY created_at LIMIT ?",
    biz.id,
    Math.min(20, limit),
  );
  if (rows.length)
    await env.DB.batch(
      rows.map((row) =>
        env.DB.prepare(
          "UPDATE reviews SET reply_state='scheduled',eligible_at=? WHERE id=? AND reply IS NULL AND had_reply=0",
        ).bind(Date.now() + randomDelay(settings.delay_min, settings.delay_max), row.id),
      ),
    );
  if (limit > rows.length && rows.length === 20)
    await enqueue(env, 'backfill', biz.id, { limit: limit - rows.length }, `backfill-page:${job.id}`);
  await run(env, 'UPDATE businesses SET backfill_limit=0 WHERE id=?', biz.id);
  await log(
    env,
    'previous_reviews_scheduled',
    `${rows.length} eligible previous reviews scheduled. Existing owner replies are excluded.`,
    biz.id,
  );
}
export async function postUnreplied(
  env,
  biz,
  row,
  comment,
  source = 'manual',
  owner = crypto.randomUUID(),
  automated = false,
) {
  ensure(
    await reviewWriteLease(env, row.id, owner),
    'Another reply operation is already in progress.',
    409,
    'review_busy',
  );
  try {
    const currentWrite = await one(env, 'SELECT reply_state FROM reviews WHERE id=?', row.id);
    ensure(
      currentWrite?.reply_state !== 'uncertain',
      'Verify the previous Google write before another reply attempt.',
      409,
      'reply_uncertain',
    );
    const google = await googleClient(env),
      remote = await google.review(biz, row.google_review_id);
    if (hasReply(remote)) {
      await recordRemote(env, row, remote);
      throw new AppError(
        'Google already has an owner reply. Nothing was overwritten.',
        409,
        'already_replied',
      );
    }
    if (automated) {
      const current = await business(env, biz.id),
        settings = normalizeAutomation(await getSetting(env, 'automation', DEFAULT_AUTOMATION));
      ensure(
        current &&
          settings.enabled &&
          current.auto_reply &&
          billingAllows(current) &&
          current.voice_status === 'ready',
        'Automation or billing paused before posting. No reply was sent.',
        409,
        'automation_paused',
      );
      ensure(
        reviewData(remote).rating >= 4,
        'This review no longer has a 4–5 star rating.',
        409,
        'rating_changed',
      );
      if (row.observed_update !== undefined)
        ensure(
          reviewData(remote).updated_at === row.observed_update,
          'The customer edited this review during generation. The reply must be regenerated.',
          409,
          'review_changed',
        );
    }
    let response;
    try {
      response = await google.post(biz, row.google_review_id, comment);
    } catch (error) {
      if (error.status >= 500 || !error.status) {
        await run(env, "UPDATE reviews SET reply_state='uncertain',eligible_at=NULL WHERE id=?", row.id);
        throw new AppError(
          'Google’s reply result is uncertain. Sync and check Google before any further post.',
          502,
          'reply_uncertain',
        );
      }
      throw error;
    }
    const time = Date.parse(response.updateTime) || Date.now();
    try {
      await run(
        env,
        "UPDATE reviews SET reply=?,replied_at=?,reply_source=?,reply_state='replied',had_reply=1,updated_at=MAX(updated_at,?),eligible_at=NULL WHERE id=?",
        comment.trim(),
        time,
        source,
        time,
        row.id,
      );
    } catch {
      try {
        await run(env, "UPDATE reviews SET reply_state='uncertain',eligible_at=NULL WHERE id=?", row.id);
      } catch {}
      throw new AppError(
        'Google accepted the reply but the cache update failed. Sync to reconcile; do not repost.',
        502,
        'reply_uncertain',
      );
    }
    await log(env, 'reply_posted', 'An owner reply was posted after checking for an existing reply.', biz.id);
    await notify(
      env,
      'reply_success',
      `${biz.name}: review replied successfully`,
      source === 'ai'
        ? 'A new owner reply was posted in your brand voice.'
        : 'Your owner reply was accepted by Google.',
      `replied:${row.id}:${time}`,
      biz.id,
      `business.html?id=${biz.id}`,
    );
    return { comment: comment.trim(), posted_at: time };
  } finally {
    await releaseWrite(env, row.id, owner);
  }
}
async function replyJob(env, job) {
  let row = await one(env, 'SELECT * FROM reviews WHERE id=?', job.entity_id);
  if (!row || row.reply !== null || row.had_reply || row.archived || row.reply_state === 'uncertain') return;
  let biz = await business(env, row.business_id);
  if (!biz) return;
  let settings = normalizeAutomation(await getSetting(env, 'automation', DEFAULT_AUTOMATION));
  if (!settings.enabled || !biz.auto_reply || !billingAllows(biz)) {
    await run(env, "UPDATE reviews SET reply_state='paused' WHERE id=?", row.id);
    return { blocked: true, reason: 'Automation or billing is paused.' };
  }
  if (biz.voice_status !== 'ready') return { defer: 900, reason: 'Waiting for a ready brand voice.' };
  const google = await googleClient(env),
    remote = await google.review(biz, row.google_review_id);
  if (hasReply(remote)) {
    await recordRemote(env, row, remote);
    return;
  }
  const item = reviewData(remote);
  if (item.rating < 4) {
    await recordRemote(env, row, remote);
    return;
  }
  ensure(
    automatedEligibility(biz, { ...row, rating: item.rating }, settings),
    'This review is not eligible for automatic reply.',
    409,
  );
  const draft = await draftReply(env, biz, { ...row, ...item });
  biz = await business(env, biz.id);
  settings = normalizeAutomation(await getSetting(env, 'automation', DEFAULT_AUTOMATION));
  if (!settings.enabled || !biz?.auto_reply || !billingAllows(biz)) {
    await run(env, "UPDATE reviews SET reply_state='paused' WHERE id=?", row.id);
    return { blocked: true, reason: 'Automation or billing paused during generation.' };
  }
  try {
    await postUnreplied(
      env,
      biz,
      { ...row, observed_update: item.updated_at },
      draft.text,
      'ai',
      job.id,
      true,
    );
  } catch (error) {
    if (['already_replied', 'rating_changed'].includes(error.code)) return;
    if (error.code === 'automation_paused') return { blocked: true, reason: error.message };
    throw error;
  }
}
export async function resumeJobs(env, businessId = null) {
  const now = Date.now(),
    settings = normalizeAutomation(await getSetting(env, 'automation', DEFAULT_AUTOMATION));
  if (!settings.enabled) return;
  if (businessId) {
    const current = await business(env, businessId);
    if (!current || !current.auto_reply || !billingAllows(current)) return;
    await run(
      env,
      "UPDATE reviews SET reply_state='scheduled',eligible_at=? WHERE business_id=? AND (reply_state='paused' OR (reply_state='unreplied' AND historical=0)) AND rating BETWEEN 4 AND 5 AND reply IS NULL AND had_reply=0",
      now + randomDelay(settings.delay_min, settings.delay_max),
      businessId,
    );
    await run(
      env,
      "UPDATE jobs SET state='pending',available_at=?,last_dispatched=NULL,lease_until=NULL,updated_at=? WHERE state='blocked' AND kind='reply' AND entity_id IN (SELECT id FROM reviews WHERE business_id=?)",
      now + settings.delay_min * 60000,
      now,
      businessId,
    );
  } else {
    await run(
      env,
      "UPDATE reviews SET reply_state='scheduled',eligible_at=? WHERE (reply_state='paused' OR (reply_state='unreplied' AND historical=0)) AND rating BETWEEN 4 AND 5 AND reply IS NULL AND had_reply=0 AND business_id IN (SELECT id FROM businesses WHERE deleted_at IS NULL AND auto_reply=1 AND (billing_enabled=0 OR (payment_status='trial' AND trial_ends_at>?) OR (payment_status='active' AND (subscription_enabled=0 OR next_due_at>?))))",
      now + settings.delay_min * 60000,
      now,
      now,
    );
    await run(
      env,
      "UPDATE jobs SET state='pending',available_at=?,last_dispatched=NULL,lease_until=NULL,updated_at=? WHERE state='blocked' AND kind='reply'",
      now + settings.delay_min * 60000,
      now,
    );
  }
}
export async function scheduler(env) {
  await recover(env);
  const now = Date.now();
  await enqueue(env, 'maintenance', null, {}, `maintenance:${Math.floor(now / 300000)}`);
  const connection = await getSetting(env, 'google_connection', {});
  if (connection.expired) return dispatch(env);
  const due = await all(
    env,
    'SELECT id,last_sync FROM businesses WHERE deleted_at IS NULL AND next_sync<=? ORDER BY COALESCE(last_sync,0),id LIMIT 5',
    now,
  );
  for (const biz of due) await enqueue(env, 'sync', biz.id, {}, `sync:${biz.id}:${Math.floor(now / 300000)}`);
  const settings = normalizeAutomation(await getSetting(env, 'automation', DEFAULT_AUTOMATION));
  if (settings.enabled) {
    const ready = await all(
      env,
      "SELECT r.id,r.eligible_at FROM reviews r JOIN businesses b ON b.id=r.business_id WHERE b.deleted_at IS NULL AND b.auto_reply=1 AND r.reply IS NULL AND r.had_reply=0 AND r.archived=0 AND r.reply_state='scheduled' AND r.eligible_at<=? ORDER BY r.eligible_at LIMIT 5",
      now,
    );
    for (const row of ready) await enqueue(env, 'reply', row.id, {}, `reply:${row.id}:${row.eligible_at}`);
  }
  return dispatch(env);
}
export async function processJob(env, id) {
  const job = await claim(env, id);
  if (!job) return { completed: true };
  const payload = parseJSON(job.payload, {});
  try {
    let result;
    if (job.kind === 'sync') result = await syncJob(env, job, payload);
    else if (job.kind === 'learn') result = await learnJob(env, job);
    else if (job.kind === 'backfill') result = await backfillJob(env, job, payload);
    else if (job.kind === 'reply') result = await replyJob(env, job);
    else if (job.kind === 'notification')
      result = await deliverNotification(env, job.entity_id, payload.cursor || '');
    else if (job.kind === 'maintenance') result = await reminders(env);
    else throw new AppError('This background operation is not supported.');
    const state = result?.blocked ? 'blocked' : result?.defer ? 'pending' : 'done';
    await run(
      env,
      'UPDATE jobs SET state=?,lease_until=NULL,last_dispatched=NULL,available_at=?,error=?,updated_at=? WHERE id=?',
      state,
      Date.now() + (result?.defer || 0) * 1000,
      result?.reason || null,
      Date.now(),
      job.id,
    );
    return { completed: true };
  } catch (error) {
    if (error.code === 'google_expired') {
      const connection = await getSetting(env, 'google_connection', {});
      await setSetting(env, 'google_connection', { ...connection, expired: true });
      await notify(
        env,
        'google_expiry',
        'Your Google connection has expired',
        'Reconnect in Google settings before replies can continue.',
        `google-revoked:${connection.connected_at || 'current'}`,
        null,
        'settings.html#google',
      );
    }
    let bizId =
      job.kind === 'reply'
        ? (await one(env, 'SELECT business_id FROM reviews WHERE id=?', job.entity_id))?.business_id
        : job.entity_id;
    const uncertain = error.code === 'reply_uncertain',
      terminal = uncertain || error.code === 'google_expired' || job.attempts >= 8;
    const delay = Math.min(3600, Math.max(60, error.retryAfter || 0, 30 * 2 ** Math.min(job.attempts, 7)));
    await run(
      env,
      'UPDATE jobs SET state=?,available_at=?,last_dispatched=NULL,lease_until=NULL,error=?,updated_at=? WHERE id=?',
      terminal ? 'failed' : 'pending',
      Date.now() + delay * 1000,
      safeMessage(error),
      Date.now(),
      job.id,
    );
    if (job.kind === 'learn')
      await run(
        env,
        "UPDATE businesses SET voice_status='failed',voice_error=? WHERE id=?",
        safeMessage(error),
        bizId,
      );
    if (job.kind === 'sync')
      await run(
        env,
        'UPDATE businesses SET sync_error=?,sync_run=CASE WHEN ? THEN NULL ELSE sync_run END WHERE id=?',
        safeMessage(error),
        terminal ? 1 : 0,
        bizId,
      );
    if (job.kind === 'reply' && terminal && !uncertain)
      await run(env, "UPDATE reviews SET reply_state='failed' WHERE id=? AND reply IS NULL", job.entity_id);
    await log(env, `${job.kind}_failed`, safeMessage(error), bizId || null, 'error');
    if (job.kind === 'reply')
      await notify(
        env,
        'reply_failed',
        'An automatic reply needs attention',
        safeMessage(error),
        `reply-error:${job.entity_id}:${new Date().toISOString().slice(0, 10)}`,
        bizId,
        `business.html?id=${bizId}`,
      );
    return { completed: terminal, retry_after: delay };
  }
}
