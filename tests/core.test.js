import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SCHEMA,
  DEFAULT_PASSWORD,
  escapeHTML,
  isTrue,
  resourceId,
  starsNumber,
  rowValues,
  rowsFromValues,
  promptFor,
  reviewFromGoogle,
  autoReplyEligible,
  summarize,
  validSession,
} from '../lib/core.js';
import { business, review, remoteReview } from './helpers.js';
test('exact five-tab schema and consistent initial password', () => {
  assert.deepEqual(Object.keys(SCHEMA), ['Businesses', 'Reviews', 'AI_Keys', 'Settings', 'Logs']);
  assert.equal(SCHEMA.Businesses.length, 11);
  assert.equal(SCHEMA.Reviews.length, 12);
  assert.equal(DEFAULT_PASSWORD, 'ReplyRaven123');
});
test('boolean strings and Google enums normalize', () => {
  for (const value of [true, 'TRUE', 'true', '1', 'yes']) assert.equal(isTrue(value), true);
  for (const value of [false, 'FALSE', '', null]) assert.equal(isTrue(value), false);
  assert.equal(starsNumber('FIVE'), 5);
  assert.equal(starsNumber('TWO'), 2);
  assert.equal(starsNumber(99), 5);
  assert.equal(resourceId('accounts/123/locations/456'), '456');
});
test('untrusted HTML is escaped, including attributes', () => {
  assert.equal(
    escapeHTML('<img src=x onerror="alert(1)"> & \'test\''),
    '&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &#39;test&#39;',
  );
});
test('raw rows retain large numeric IDs and formula-looking comments', () => {
  const id = '123456789012345678901';
  const values = rowValues('Reviews', { ...review, google_review_id: id, comment: '=IMPORTXML("x")' });
  assert.equal(values[0], id);
  assert.equal(values[5], '=IMPORTXML("x")');
});
test('row indices include blank rows and never treat headers as data', () => {
  const rows = rowsFromValues('Settings', [SCHEMA.Settings, ['a', 'b'], [], ['c', 'd']]);
  assert.deepEqual(rows, [
    { key: 'a', value: 'b', _row: 2 },
    { key: 'c', value: 'd', _row: 4 },
  ]);
});
test('invalid headers and missing headers fail without changing data', () => {
  assert.throws(() => rowsFromValues('Settings', []), /Prepare sheet/);
  assert.throws(() => rowsFromValues('Settings', [['value', 'key']]), /headers/);
  assert.throws(() => rowsFromValues('Settings', [['key', 'value', 'extra']]), /headers/);
});
test('prompt substitutes every variable once; inserted review content is not interpreted', () => {
  const prompt = promptFor(
    { ...review, comment: '{business_name}' },
    business,
    '{business_name} {stars} {comment} {stars}',
  );
  assert.equal(prompt, 'A café 5 {business_name} 5');
});
test('sync follows Google reply status and preserves matching auto-reply attribution', () => {
  const existing = { ...review, reply_comment: 'Thanks!', is_replied: 'TRUE', is_auto_replied: 'TRUE' };
  const remote = remoteReview(review, { reviewReply: { comment: 'Thanks!', updateTime: '2026-09-02' } });
  assert.equal(reviewFromGoogle(remote, business, existing).is_auto_replied, 'TRUE');
  assert.equal(
    reviewFromGoogle({ ...remote, reviewReply: { comment: 'Edited elsewhere' } }, business, existing)
      .is_auto_replied,
    'FALSE',
  );
  const deleted = reviewFromGoogle(remoteReview(review), business, existing);
  assert.equal(deleted.is_replied, 'FALSE');
  assert.equal(deleted.reply_comment, '');
});
test('low stars get attention; anonymous and rating-only reviews work', () => {
  const row = reviewFromGoogle({ reviewId: 'abc', starRating: 'TWO' }, business);
  assert.equal(row.needs_attention, 'TRUE');
  assert.equal(row.reviewer_name, 'Anonymous reviewer');
  assert.equal(row.comment, '');
});
test('auto-reply requires active, matching, opted-in business and 4–5 stars', () => {
  assert.equal(autoReplyEligible(review, business), true);
  for (const patch of [{ star_rating: '3' }, { is_replied: 'TRUE' }, { google_location_id: 'other' }])
    assert.equal(autoReplyEligible({ ...review, ...patch }, business), false);
  for (const patch of [{ status: 'INACTIVE' }, { is_auto_reply: 'FALSE' }])
    assert.equal(autoReplyEligible(review, { ...business, ...patch }), false);
  assert.equal(autoReplyEligible(review, null), false);
});
test('stats use tracked businesses, real rows, and UTC reply dates', () => {
  const result = summarize(
    [business],
    [
      review,
      {
        ...review,
        google_review_id: 'r2',
        is_replied: 'TRUE',
        is_auto_replied: 'TRUE',
        reply_date: '2026-10-01T00:10:00Z',
      },
      { ...review, google_location_id: 'not-tracked' },
    ],
    new Date('2026-10-01T23:00:00Z'),
  );
  assert.deepEqual(result, { businesses: 1, reviews: 2, unreplied: 1, autoToday: 1 });
});
test('session requires true auth AND a strictly future expiry', () => {
  const memory = new Map([
    ['auth', 'true'],
    ['auth_expiry', '1000'],
  ]);
  const storage = { getItem: (key) => memory.get(key) };
  assert.equal(validSession(storage, 999), true);
  assert.equal(validSession(storage, 1000), false);
  memory.set('auth', 'false');
  assert.equal(validSession(storage, 999), false);
});
