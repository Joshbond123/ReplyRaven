import test from 'node:test';
import assert from 'node:assert/strict';
import { SheetsClient, GoogleBusinessClient, APIError, requestJSON } from '../lib/api.js';
import { SCHEMA } from '../lib/core.js';
import { business, review, response } from './helpers.js';
test('API errors preserve status and Google messages', async () => {
  await assert.rejects(
    requestJSON('https://test.invalid', {}, async () => response({ error: { message: 'Denied' } }, 403)),
    (err) => err instanceof APIError && err.status === 403 && err.message === 'Denied',
  );
});
test('network errors do not expose request credentials', async () => {
  await assert.rejects(
    requestJSON('https://test.invalid', {}, async () => {
      throw new Error('secret');
    }),
    /Could not reach/,
  );
});
test('authenticated Sheets reads use Bearer and not API key in URL', async () => {
  let captured;
  const store = new SheetsClient({
    sheetId: 'sheet',
    apiKey: 'public-key',
    getToken: () => 'private-token',
    fetcher: async (url, init) => {
      captured = { url, init };
      return response({ values: [SCHEMA.Settings, ['a', 'b']] });
    },
  });
  const result = await store.read('Settings');
  assert.equal(result[0]._row, 2);
  assert.equal(captured.init.headers.Authorization, 'Bearer private-token');
  assert.ok(!captured.url.includes('public-key'));
  assert.match(decodeURIComponent(captured.url), /'Settings'!A1:B/);
});
test('API key fallback is read-only', async () => {
  const calls = [];
  const store = new SheetsClient({
    sheetId: 'sheet',
    apiKey: 'abc',
    fetcher: async (url) => {
      calls.push(url);
      return response({ values: [SCHEMA.Businesses] });
    },
  });
  await store.read('Businesses');
  assert.match(calls[0], /key=abc/);
  await assert.rejects(store.append('Businesses', [business]), /cannot authorize writes/);
  assert.equal(calls.length, 1);
});
test('append and update use RAW to prevent formula execution and ID rounding', async () => {
  const calls = [];
  const store = new SheetsClient({
    sheetId: 'sheet',
    getToken: () => 'token',
    fetcher: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return response({});
    },
  });
  await store.append('Reviews', [{ ...review, comment: '=NOW()' }]);
  await store.update('Reviews', { ...review, _row: 4 });
  assert.match(calls[0].url, /valueInputOption=RAW/);
  assert.equal(calls[0].body.values[0][5], '=NOW()');
  assert.equal(calls[1].body.valueInputOption, 'RAW');
  assert.equal(calls[1].body.data[0].range, "'Reviews'!A4:L4");
  await assert.rejects(store.update('Reviews', review), /Reload/);
});
test('ambiguous append failures are never blindly retried', async () => {
  let calls = 0;
  const store = new SheetsClient({
    sheetId: 'sheet',
    getToken: () => 'token',
    fetcher: async () => {
      calls++;
      return response({ error: { message: 'Overloaded' } }, 503);
    },
  });
  await assert.rejects(store.append('Reviews', [review]), /Overloaded/);
  assert.equal(calls, 1);
});
test('deletions run bottom-to-top and never delete headers', async () => {
  let batch;
  const store = new SheetsClient({
    sheetId: 'sheet',
    getToken: () => 'token',
    fetcher: async (url, init) => {
      if (url.includes('fields='))
        return response({ sheets: [{ properties: { title: 'Reviews', sheetId: 7 } }] });
      batch = JSON.parse(init.body);
      return response({});
    },
  });
  await store.deleteRows('Reviews', [2, 8, 5, 8]);
  assert.deepEqual(
    batch.requests.map((r) => r.deleteDimension.range.startIndex),
    [7, 4, 1],
  );
  await assert.rejects(store.deleteRows('Reviews', [1]), /Invalid row/);
});
test('Prepare sheet validates existing tabs before creating missing ones', async () => {
  let writes = 0;
  const store = new SheetsClient({
    sheetId: 'sheet',
    getToken: () => 'token',
    fetcher: async (url, init) => {
      if (init.method === 'POST') writes++;
      if (url.includes('fields='))
        return response({ sheets: [{ properties: { title: 'Businesses', sheetId: 1 } }] });
      return response({ values: [['Wrong header']] });
    },
  });
  await assert.rejects(store.initialize(), /headers/);
  assert.equal(writes, 0);
});
test('accounts and locations paginate and use exact read mask', async () => {
  const urls = [];
  const client = new GoogleBusinessClient({
    getToken: () => 'token',
    fetcher: async (url) => {
      urls.push(new URL(url));
      if (url.includes('/locations')) return response({ locations: [{ name: 'locations/1' }] });
      return urls.length === 1
        ? response({ accounts: [{ name: 'accounts/1' }], nextPageToken: 'next' })
        : response({ accounts: [{ name: 'accounts/2' }] });
    },
  });
  assert.equal((await client.accounts()).length, 2);
  assert.equal(urls[1].searchParams.get('pageToken'), 'next');
  await client.locations('accounts/1');
  assert.equal(urls[2].searchParams.get('readMask'), 'name,title,storefrontAddress');
});
test('review sync reads every page and preserves aggregate count/rating', async () => {
  let calls = 0;
  const client = new GoogleBusinessClient({
    getToken: () => 'token',
    fetcher: async () => {
      calls++;
      return calls === 1
        ? response({
            reviews: [{ reviewId: 'a' }],
            averageRating: 4.8,
            totalReviewCount: 2,
            nextPageToken: 'p2',
          })
        : response({ reviews: [{ reviewId: 'b' }], averageRating: 4.8, totalReviewCount: 2 });
    },
  });
  const result = await client.reviews(business);
  assert.equal(result.reviews.length, 2);
  assert.equal(result.totalReviewCount, 2);
  assert.equal(result.averageRating, 4.8);
});
test('repeated pagination tokens fail rather than looping forever', async () => {
  const client = new GoogleBusinessClient({
    getToken: () => 'token',
    fetcher: async () => response({ accounts: [], nextPageToken: 'same' }),
  });
  await assert.rejects(client.accounts(), /repeated page token/);
});
test('Google reply URL normalizes IDs, validates text, and deletes only owner replies', async () => {
  const calls = [];
  const client = new GoogleBusinessClient({
    getToken: () => 'token',
    fetcher: async (url, init) => {
      calls.push({ url, init });
      return response({ comment: 'Thanks!' });
    },
  });
  await client.postReply(
    { ...business, google_account_id: 'accounts/123', google_location_id: 'locations/456' },
    'r1',
    ' Thanks! ',
  );
  assert.match(calls[0].url, /accounts\/123\/locations\/456\/reviews\/r1\/reply$/);
  assert.deepEqual(JSON.parse(calls[0].init.body), { comment: 'Thanks!' });
  await client.deleteReply(business, 'r1');
  assert.equal(calls[1].init.method, 'DELETE');
  assert.throws(() => client.postReply(business, 'r1', ''), /between/);
});
test('malformed successful JSON responses fail instead of silently syncing empty data', async () => {
  await assert.rejects(
    requestJSON(
      'https://test.invalid',
      {},
      async () => new Response('<html>Error page</html>', { status: 200 }),
    ),
    /invalid JSON/,
  );
});
test('owner-reply PUTs are not blindly retried after an ambiguous server failure', async () => {
  let calls = 0;
  const client = new GoogleBusinessClient({
    getToken: () => 'token',
    fetcher: async () => {
      calls++;
      return response({ error: { message: 'Server failed after accepting request' } }, 503);
    },
  });
  await assert.rejects(client.postReply(business, 'r1', 'Thanks!'), /Server failed/);
  assert.equal(calls, 1);
});
