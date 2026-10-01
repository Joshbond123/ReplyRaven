import { bool, isTrue, reviewFromGoogle, reviewKey, resourceId, makeLog } from './core.js';
/** Upsert edited reviews and replies, then remove deleted reviews only after all pages succeed. */
export async function syncBusiness(store, google, business) {
  const remote = await google.reviews(business);
  const existing = await store.read('Reviews');
  const byKey = new Map(existing.map((row) => [reviewKey(row), row]));
  const updates = [],
    additions = [],
    fresh = [];
  const remoteById = new Map();
  for (const review of remote.reviews) {
    const id = resourceId(review.reviewId || review.name);
    if (!id) throw new Error('Google returned a review without an ID. No cached reviews were changed.');
    const previous = remoteById.get(id);
    if (
      !previous ||
      (review.updateTime || review.createTime || '') >= (previous.updateTime || previous.createTime || '')
    )
      remoteById.set(id, review);
  }
  for (const review of remoteById.values()) {
    const key = `${resourceId(business.google_location_id)}:${resourceId(review.reviewId || review.name)}`;
    const previous = byKey.get(key);
    const next = reviewFromGoogle(review, business, previous);
    fresh.push(next);
    (previous ? updates : additions).push(next);
  }
  await store.updateMany('Reviews', updates);
  await store.append('Reviews', additions);
  const liveIds = new Set(fresh.map(reviewKey));
  const deleted = existing.filter(
    (row) =>
      resourceId(row.google_location_id) === resourceId(business.google_location_id) &&
      (!liveIds.has(reviewKey(row)) || byKey.get(reviewKey(row))?._row !== row._row),
  );
  await store.deleteRows(
    'Reviews',
    deleted.map((row) => row._row),
  );
  // Resolve the current business row again in case a concurrent browser write moved it.
  const current = (await store.read('Businesses')).find(
    (row) => resourceId(row.google_location_id) === resourceId(business.google_location_id),
  );
  if (!current)
    throw new Error(
      'The business was removed while syncing. Reviews were synced, but no business row was overwritten.',
    );
  const updated = {
    ...current,
    total_reviews: String(remote.totalReviewCount),
    avg_rating: String(remote.averageRating),
    last_sync: new Date().toISOString(),
    unreplied_count: String(fresh.filter((row) => !isTrue(row.is_replied)).length),
    status: current.status || 'ACTIVE',
  };
  await store.update('Businesses', updated);
  await store.append('Logs', [
    makeLog(
      business,
      'SYNC',
      'SUCCESS',
      `Synced ${fresh.length} reviews; ${additions.length} new, ${deleted.length} removed.`,
    ),
  ]);
  return { business: updated, reviews: fresh, added: additions.length };
}
/** Update just the matching review, without stale sheet row numbers or duplicate IDs. */
export async function persistReply(store, business, review, reply, automatic = false) {
  const current = (await store.read('Reviews')).find((row) => reviewKey(row) === reviewKey(review));
  if (!current)
    throw new Error(
      'Google saved the reply, but this review no longer exists in Sheets. Sync to reconcile it.',
    );
  const updated = {
    ...current,
    reply_comment: reply.comment,
    reply_date: reply.updateTime || new Date().toISOString(),
    is_replied: 'TRUE',
    is_auto_replied: bool(automatic),
    needs_attention: 'FALSE',
  };
  await store.update('Reviews', updated);
  await recountBusiness(store, business);
  return updated;
}
export async function recountBusiness(store, business) {
  const [businesses, reviews] = await Promise.all([store.read('Businesses'), store.read('Reviews')]);
  const current = businesses.find(
    (row) => resourceId(row.google_location_id) === resourceId(business.google_location_id),
  );
  if (!current) return;
  await store.update('Businesses', {
    ...current,
    unreplied_count: String(
      reviews.filter(
        (row) =>
          resourceId(row.google_location_id) === resourceId(business.google_location_id) &&
          !isTrue(row.is_replied),
      ).length,
    ),
  });
}
