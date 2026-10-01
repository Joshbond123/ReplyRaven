import {
  activeBusiness,
  autoReplyEligible,
  bool,
  DEFAULT_PROMPT,
  isTrue,
  makeLog,
  normalizeAIKey,
  resourceId,
  reviewFromGoogle,
  reviewKey,
} from '../../lib/core.js';
import { AIKeyRotator } from '../../lib/ai.js';
import { sleep } from '../../lib/api.js';
import { persistReply, syncBusiness, recountBusiness } from '../../lib/operations.js';

export function parseSecretKeys(json) {
  let values;
  try {
    values = JSON.parse(json || '[]');
  } catch {
    throw new Error('AI_KEYS_JSON must be a valid JSON array. Export it in Settings → GitHub secrets.');
  }
  if (!Array.isArray(values)) throw new Error('AI_KEYS_JSON must be an array of provider keys.');
  const keys = values.map(normalizeAIKey).filter((key) => isTrue(key.is_active) && key.api_key);
  if (!keys.length)
    throw new Error('AI_KEYS_JSON has no active keys. Add keys, then update your GitHub Secret.');
  if (new Set(keys.map((key) => key.id)).size !== keys.length)
    throw new Error('AI_KEYS_JSON key IDs must be unique.');
  return keys;
}
export async function runSync({ store, google, redact = String, onProgress = console.log }) {
  const businesses = (await store.read('Businesses'))
    .filter(activeBusiness)
    .sort((a, b) => (Date.parse(a.last_sync) || 0) - (Date.parse(b.last_sync) || 0));
  const summary = { businesses: businesses.length, synced: 0, newReviews: 0, errors: [] };
  for (const business of businesses) {
    try {
      const result = await syncBusiness(store, google, business);
      summary.synced++;
      summary.newReviews += result.added;
      onProgress(`Synced ${business.business_name}: ${result.reviews.length} reviews, ${result.added} new.`);
    } catch (error) {
      const message = redact(error.message);
      summary.errors.push(`${business.business_name}: ${message}`);
      await store.append('Logs', [makeLog(business, 'SYNC', 'ERROR', message)]).catch(() => {});
      onProgress(`Sync failed for ${business.business_name}: ${message}`);
    }
    await sleep(300);
  }
  return summary;
}
export async function runAutoReply({
  store,
  google,
  keys,
  redact = String,
  fetcher = globalThis.fetch,
  delay = sleep,
  onProgress = console.log,
  AIEngine = AIKeyRotator,
}) {
  const settings = Object.fromEntries((await store.read('Settings')).map((row) => [row.key, row.value]));
  const summary = { eligible: 0, replied: 0, skipped: 0, errors: [], paused: false };
  if (!isTrue(settings.automation_enabled ?? 'TRUE')) {
    summary.paused = true;
    return summary;
  }
  const [businesses, reviews, metadata] = await Promise.all([
    store.read('Businesses'),
    store.read('Reviews'),
    store.read('AI_Keys'),
  ]);
  const businessMap = new Map(
    businesses.filter(activeBusiness).map((b) => [resourceId(b.google_location_id), b]),
  );
  const metaMap = new Map(metadata.map((key) => [key.id, key]));
  // A disabled sheet key cannot be re-enabled by a stale GitHub Secret.
  const enabledKeys = keys.filter((key) => !metaMap.has(key.id) || isTrue(metaMap.get(key.id).is_active));
  if (!enabledKeys.length)
    throw new Error('All secret keys are disabled in AI_Keys. Enable one in Settings.');
  for (const key of enabledKeys) {
    if (!metaMap.has(key.id))
      await store.append('AI_Keys', [{ ...key, api_key: '', request_count: '0', last_used_at: '' }]);
  }
  const engine = new AIEngine(enabledKeys, {
    index: Number(settings.ai_rotation_index) || 0,
    fetcher,
    onRotate: async (index) => store.saveSettings({ ai_rotation_index: String(index) }),
    onAttempt: async (key) => {
      const current = (await store.read('AI_Keys')).find((row) => row.id === key.id);
      if (current)
        await store.update('AI_Keys', {
          ...current,
          request_count: String((Number(current.request_count) || 0) + 1),
          last_used_at: new Date().toISOString(),
        });
    },
  });
  const maxReplies = Math.max(1, Math.min(1000, Number(settings.max_replies_per_run) || 100));
  const delaySeconds = Math.max(2, Math.min(30, Number(settings.reply_delay_seconds) || 2));
  // Stable oldest-first queue avoids starving older feedback when new reviews arrive.
  const eligible = reviews
    .filter((review) => autoReplyEligible(review, businessMap.get(resourceId(review.google_location_id))))
    .sort((a, b) => a.review_date.localeCompare(b.review_date));
  summary.eligible = eligible.length;
  for (const review of eligible) {
    if (summary.replied >= maxReplies) break;
    const business = businessMap.get(resourceId(review.google_location_id));
    try {
      // Honor a master/business pause made during a long run.
      const liveSettings = Object.fromEntries(
        (await store.read('Settings')).map((row) => [row.key, row.value]),
      );
      if (!isTrue(liveSettings.automation_enabled ?? 'TRUE')) {
        summary.paused = true;
        break;
      }
      const liveBusiness = (await store.read('Businesses')).find(
        (row) => resourceId(row.google_location_id) === resourceId(business.google_location_id),
      );
      if (!liveBusiness || !isTrue(liveBusiness.is_auto_reply) || !activeBusiness(liveBusiness)) {
        summary.skipped++;
        continue;
      }
      const latest = await google.getReview(liveBusiness, review.google_review_id);
      if (latest.reviewReply?.comment) {
        const fresh = (await store.read('Reviews')).find((row) => reviewKey(row) === reviewKey(review));
        if (fresh) await store.update('Reviews', reviewFromGoogle(latest, liveBusiness, fresh));
        await recountBusiness(store, liveBusiness);
        summary.skipped++;
        continue;
      }
      const freshReview = reviewFromGoogle(latest, liveBusiness, review);
      // A customer may have edited their rating since the last sync.
      if (!autoReplyEligible(freshReview, liveBusiness)) {
        const current = (await store.read('Reviews')).find((row) => reviewKey(row) === reviewKey(review));
        if (current) await store.update('Reviews', { ...freshReview, _row: current._row });
        summary.skipped++;
        continue;
      }
      const liveMetadata = await store.read('AI_Keys');
      engine.keys = enabledKeys.filter(
        (key) =>
          key.model_name &&
          (!liveMetadata.some((row) => row.id === key.id) ||
            isTrue(liveMetadata.find((row) => row.id === key.id).is_active)),
      );
      if (!engine.keys.length) {
        summary.errors.push('All AI keys were paused during the run. No more replies were posted.');
        break;
      }
      const { reply, key } = await engine.generate(
        freshReview,
        liveBusiness,
        liveBusiness.ai_prompt_template || liveSettings.default_ai_prompt || DEFAULT_PROMPT,
      );
      const [finalSettingsRows, finalBusinesses] = await Promise.all([
        store.read('Settings'),
        store.read('Businesses'),
      ]);
      const finalSettings = Object.fromEntries(finalSettingsRows.map((row) => [row.key, row.value]));
      if (!isTrue(finalSettings.automation_enabled ?? 'TRUE')) {
        summary.paused = true;
        break;
      }
      const finalBusiness = finalBusinesses.find(
        (row) => resourceId(row.google_location_id) === resourceId(liveBusiness.google_location_id),
      );
      if (!finalBusiness || !activeBusiness(finalBusiness) || !isTrue(finalBusiness.is_auto_reply)) {
        summary.skipped++;
        continue;
      }
      const beforePost = await google.getReview(liveBusiness, review.google_review_id);
      if (
        beforePost.reviewReply?.comment ||
        Number(reviewFromGoogle(beforePost, liveBusiness).star_rating) < 4
      ) {
        const current = (await store.read('Reviews')).find((row) => reviewKey(row) === reviewKey(review));
        if (current) await store.update('Reviews', reviewFromGoogle(beforePost, liveBusiness, current));
        await recountBusiness(store, liveBusiness);
        summary.skipped++;
        continue;
      }
      const posted = await google.postReply(liveBusiness, review.google_review_id, reply);
      // If this write fails after PUT, the next run will find the remote reply and reconcile it.
      await persistReply(store, liveBusiness, review, posted, true);
      await store.append('Logs', [
        makeLog(
          liveBusiness,
          'AUTO_REPLY',
          'SUCCESS',
          `GitHub Actions posted a ${freshReview.star_rating}-star reply using ${key.provider} / ${key.model_name}.`,
          review,
        ),
      ]);
      summary.replied++;
      onProgress(`Replied to a ${freshReview.star_rating}-star review for ${liveBusiness.business_name}.`);
    } catch (error) {
      const message = redact(error.message);
      summary.errors.push(`${business.business_name} / ${review.google_review_id}: ${message}`);
      if (error.status === 404) {
        const current = (await store.read('Reviews')).find((row) => reviewKey(row) === reviewKey(review));
        if (current) await store.deleteRows('Reviews', [current._row]);
      }
      await store.append('Logs', [makeLog(business, 'AUTO_REPLY', 'ERROR', message, review)]).catch(() => {});
      onProgress(`Reply failed for ${business.business_name}: ${message}`);
    }
    await delay(delaySeconds * 1000);
  }
  return summary;
}
