import test from 'node:test';
import assert from 'node:assert/strict';
import { syncBusiness, persistReply } from '../lib/operations.js';
import { runSync, runAutoReply } from '../scripts/lib/automation.js';
import { MemoryStore, business, review, aiKey, remoteReview, response } from './helpers.js';
const silent = () => {};
const aiFetch = async () => response({ choices: [{ message: { content: 'Thank you for visiting!' } }] });
function runtime(data = {}) {
  const store = new MemoryStore({ Businesses: [business], Reviews: [review], AI_Keys: [aiKey], ...data });
  const posts = [];
  const google = {
    reviews: async () => ({
      reviews: store.data.Reviews.filter((r) => r.google_location_id === '456').map((r) =>
        remoteReview(
          r,
          r.is_replied === 'TRUE'
            ? { reviewReply: { comment: r.reply_comment, updateTime: r.reply_date } }
            : {},
        ),
      ),
      averageRating: 4.8,
      totalReviewCount: store.data.Reviews.length,
    }),
    getReview: async (b, id) => {
      const r = store.data.Reviews.find((r) => r.google_review_id === id);
      return remoteReview(
        r,
        r.is_replied === 'TRUE'
          ? { reviewReply: { comment: r.reply_comment, updateTime: r.reply_date } }
          : {},
      );
    },
    postReply: async (b, id, comment) => {
      posts.push({ b, id, comment });
      return { comment, updateTime: '2026-10-01T10:00:00Z' };
    },
  };
  return { store, google, posts, keys: [aiKey], fetcher: aiFetch, delay: async () => {}, onProgress: silent };
}
test('sync upserts edits, adds new rows, removes deleted reviews and duplicates', async () => {
  const store = new MemoryStore({
    Businesses: [business],
    Reviews: [review, { ...review, google_review_id: 'gone' }, { ...review }],
  });
  const google = {
    reviews: async () => ({
      reviews: [
        remoteReview({ ...review, comment: 'Edited', star_rating: '2' }),
        remoteReview({ ...review, google_review_id: 'new' }),
      ],
      averageRating: 3.5,
      totalReviewCount: 2,
    }),
  };
  const result = await syncBusiness(store, google, business);
  assert.equal(result.added, 1);
  assert.equal(store.data.Reviews.length, 2);
  assert.equal(store.data.Reviews.find((r) => r.google_review_id === 'r1').comment, 'Edited');
  assert.equal(store.data.Reviews.find((r) => r.google_review_id === 'r1').needs_attention, 'TRUE');
  assert.equal(store.data.Businesses[0].total_reviews, '2');
  assert.equal(store.data.Businesses[0].avg_rating, '3.5');
  assert.equal(store.data.Logs[0].status, 'SUCCESS');
});
test('failed review pagination does not mutate cached reviews or metrics', async () => {
  const rt = runtime();
  rt.google.reviews = async () => {
    throw new Error('network failure');
  };
  await assert.rejects(syncBusiness(rt.store, rt.google, business), /network failure/);
  assert.equal(rt.store.data.Reviews[0].comment, review.comment);
  assert.equal(rt.store.writes.length, 0);
});
test('persistReply re-resolves sheet row after a deletion moves it', async () => {
  const store = new MemoryStore({
    Businesses: [business],
    Reviews: [{ ...review, google_review_id: 'first' }, review],
  });
  const stale = (await store.read('Reviews'))[1];
  await store.deleteRows('Reviews', [2]);
  await persistReply(store, business, stale, { comment: 'Thanks!', updateTime: '2026-10-01' }, true);
  assert.equal(store.data.Reviews.length, 1);
  assert.equal(store.data.Reviews[0].reply_comment, 'Thanks!');
  assert.equal(store.data.Reviews[0].is_auto_replied, 'TRUE');
  assert.equal(store.data.Businesses[0].unreplied_count, '0');
});
test('scheduled replies use only opted-in 4–5-star unreplied reviews', async () => {
  const rt = runtime({
    Businesses: [business, { ...business, google_location_id: 'other', is_auto_reply: 'FALSE' }],
    Reviews: [
      review,
      { ...review, google_review_id: 'low', star_rating: '3' },
      { ...review, google_review_id: 'done', is_replied: 'TRUE', reply_comment: 'Existing' },
      { ...review, google_review_id: 'not-opted-in', google_location_id: 'other' },
    ],
  });
  const result = await runAutoReply(rt);
  assert.equal(result.replied, 1);
  assert.equal(rt.posts.length, 1);
  assert.equal(rt.posts[0].id, 'r1');
  assert.equal(rt.store.data.Reviews.find((r) => r.google_review_id === 'low').is_replied, 'FALSE');
  assert.equal(rt.store.data.AI_Keys[0].request_count, '1');
  assert.ok(rt.store.data.Settings.some((r) => r.key === 'ai_rotation_index'));
  assert.equal(rt.store.data.Logs[0].action, 'AUTO_REPLY');
});
test('existing remote replies are reconciled, never overwritten', async () => {
  const rt = runtime();
  rt.google.getReview = async () =>
    remoteReview(review, { reviewReply: { comment: 'Posted by another manager', updateTime: '2026-10-01' } });
  const result = await runAutoReply(rt);
  assert.equal(result.skipped, 1);
  assert.equal(rt.posts.length, 0);
  assert.equal(rt.store.data.Reviews[0].reply_comment, 'Posted by another manager');
  assert.equal(rt.store.data.AI_Keys[0].request_count, '0');
});
test('a rating edited down to 1–3 stars is never auto-replied', async () => {
  const rt = runtime();
  rt.google.getReview = async () => remoteReview({ ...review, star_rating: '1' });
  const result = await runAutoReply(rt);
  assert.equal(result.skipped, 1);
  assert.equal(rt.posts.length, 0);
  assert.equal(rt.store.data.Reviews[0].star_rating, '1');
  assert.equal(rt.store.data.Reviews[0].needs_attention, 'TRUE');
});
test('a reply posted during AI generation is caught by a second Google check', async () => {
  const rt = runtime();
  let calls = 0;
  rt.google.getReview = async () => {
    calls++;
    return remoteReview(
      review,
      calls === 2 ? { reviewReply: { comment: 'New human reply', updateTime: '2026-10-01' } } : {},
    );
  };
  const result = await runAutoReply(rt);
  assert.equal(rt.posts.length, 0);
  assert.equal(result.skipped, 1);
  assert.equal(rt.store.data.Reviews[0].reply_comment, 'New human reply');
});
test('the master pause prevents all AI/Google calls', async () => {
  const rt = runtime({ Settings: [{ key: 'automation_enabled', value: 'FALSE' }] });
  rt.google.getReview = async () => assert.fail('Google should not be called');
  rt.fetcher = async () => assert.fail('AI should not be called');
  const result = await runAutoReply(rt);
  assert.equal(result.paused, true);
  assert.equal(result.replied, 0);
});
test('maximum replies per run caps successful posts without starving oldest reviews', async () => {
  const rt = runtime({
    Reviews: [{ ...review, google_review_id: 'newer', review_date: '2026-09-05' }, review],
    Settings: [{ key: 'max_replies_per_run', value: '1' }],
  });
  const result = await runAutoReply(rt);
  assert.equal(result.eligible, 2);
  assert.equal(result.replied, 1);
  assert.equal(rt.posts[0].id, 'r1');
});
test('disabled sheet keys cannot be enabled by stale secret JSON', async () => {
  const rt = runtime({ AI_Keys: [{ ...aiKey, is_active: 'FALSE' }] });
  await assert.rejects(runAutoReply(rt), /disabled/);
  assert.equal(rt.posts.length, 0);
});
test('secret-only keys add accounting metadata, not plaintext secrets, to Sheets', async () => {
  const rt = runtime({ AI_Keys: [] });
  const result = await runAutoReply(rt);
  assert.equal(result.replied, 1);
  assert.equal(rt.store.data.AI_Keys[0].api_key, '');
  assert.equal(rt.store.data.AI_Keys[0].id, aiKey.id);
  assert.equal(rt.store.data.AI_Keys[0].request_count, '1');
});
test('AI failures are logged and do not mark a review replied', async () => {
  const rt = runtime();
  rt.fetcher = async () => response({ error: { message: 'Rate limited' } }, 429);
  const result = await runAutoReply(rt);
  assert.equal(result.errors.length, 1);
  assert.equal(rt.posts.length, 0);
  assert.equal(rt.store.data.Reviews[0].is_replied, 'FALSE');
  assert.equal(rt.store.data.Logs[0].status, 'ERROR');
});
test('a failed Sheets write after PUT is reconciled on the next run', async () => {
  const rt = runtime();
  let remoteReply = null;
  rt.google.getReview = async () => remoteReview(review, remoteReply ? { reviewReply: remoteReply } : {});
  rt.google.postReply = async (b, id, comment) => {
    rt.posts.push(id);
    remoteReply = { comment, updateTime: '2026-10-01' };
    return remoteReply;
  };
  const originalUpdate = rt.store.update.bind(rt.store);
  rt.store.update = async (tab, row) => {
    if (tab === 'Reviews') throw new Error('Sheet unavailable');
    return originalUpdate(tab, row);
  };
  const first = await runAutoReply(rt);
  assert.equal(first.errors.length, 1);
  rt.store.update = originalUpdate;
  const second = await runAutoReply(rt);
  assert.equal(second.skipped, 1);
  assert.equal(rt.posts.length, 1);
  assert.equal(rt.store.data.Reviews[0].is_replied, 'TRUE');
});
test('sync continues other businesses and records per-business failures', async () => {
  const rt = runtime({ Businesses: [{ ...business, google_location_id: 'bad' }, business] });
  const original = rt.google.reviews;
  rt.google.reviews = async (b) =>
    b.google_location_id === 'bad' ? Promise.reject(new Error('Access denied')) : original(b);
  const result = await runSync(rt);
  assert.equal(result.synced, 1);
  assert.equal(result.errors.length, 1);
  assert.ok(rt.store.data.Logs.some((log) => log.status === 'ERROR'));
});
test('a business paused during AI generation does not receive a reply', async () => {
  const rt = runtime();
  rt.fetcher = async () => {
    rt.store.data.Businesses[0].is_auto_reply = 'FALSE';
    return response({ choices: [{ message: { content: 'A draft, not posted.' } }] });
  };
  const result = await runAutoReply(rt);
  assert.equal(result.skipped, 1);
  assert.equal(rt.posts.length, 0);
});
test('a master pause during generation stops posting immediately', async () => {
  const rt = runtime();
  rt.fetcher = async () => {
    await rt.store.saveSettings({ automation_enabled: 'FALSE' });
    return response({ choices: [{ message: { content: 'Not posted.' } }] });
  };
  const result = await runAutoReply(rt);
  assert.equal(result.paused, true);
  assert.equal(rt.posts.length, 0);
});
test('duplicate remote review IDs are upserted only once', async () => {
  const rt = runtime({ Reviews: [] });
  rt.google.reviews = async () => ({
    reviews: [remoteReview(review), remoteReview({ ...review, comment: 'Newer edit' })],
    averageRating: 5,
    totalReviewCount: 1,
  });
  await syncBusiness(rt.store, rt.google, business);
  assert.equal(rt.store.data.Reviews.length, 1);
  assert.equal(rt.store.data.Businesses[0].unreplied_count, '1');
});
