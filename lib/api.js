import { SCHEMA, rowValues, rowsFromValues, resourceId } from './core.js';
export class APIError extends Error {
  constructor(message, status = 0, data = null) {
    super(message);
    this.name = 'APIError';
    this.status = status;
    this.data = data;
  }
}
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export async function requestJSON(url, options = {}, fetcher = globalThis.fetch, retries = 2) {
  const { timeout = 45000, ...init } = options;
  for (let attempt = 0; ; attempt++) {
    let response;
    try {
      response = await fetcher(url, { ...init, signal: init.signal || AbortSignal.timeout(timeout) });
    } catch (error) {
      throw new APIError(
        error.name === 'TimeoutError'
          ? 'The request timed out. Please try again.'
          : 'Could not reach the service. Check your connection or browser CORS policy.',
        0,
      );
    }
    let data;
    const text = await response.text();
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      if (response.ok)
        throw new APIError('The service returned invalid JSON. Check the connection before retrying.', 502);
      data = {};
    }
    if (response.ok) return data;
    const idempotent = !init.method || ['GET', 'PUT', 'DELETE'].includes(init.method);
    if (attempt < retries && idempotent && [429, 500, 502, 503, 504].includes(response.status)) {
      const retryAfter = Number(response.headers?.get('retry-after'));
      await sleep(Math.min(15000, (retryAfter || 2 ** attempt) * 1000));
      continue;
    }
    const message =
      data.error?.message ||
      data.error_description ||
      (typeof data.error === 'string' && data.error) ||
      `Request failed (${response.status}).`;
    throw new APIError(message, response.status, data);
  }
}
const lastColumn = (tab) => String.fromCharCode(64 + SCHEMA[tab].length);
export class SheetsClient {
  constructor({ sheetId, apiKey = '', getToken = () => '', fetcher = globalThis.fetch }) {
    this.sheetId = String(sheetId || '').trim();
    this.apiKey = apiKey;
    this.getToken = getToken;
    this.fetcher = fetcher;
    this.base = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(this.sheetId)}`;
    this.sheetIds = null;
  }
  async call(path = '', options = {}, write = false) {
    if (!this.sheetId) throw new Error('Add your Google Sheet ID in Settings → Google first.');
    const token = await this.getToken();
    if (write && !token)
      throw new Error('Connect Google to edit your private sheet. An API key cannot authorize writes.');
    if (!token && !this.apiKey) throw new Error('Connect Google in Settings to read your private sheet.');
    const separator = path.includes('?') ? '&' : '?';
    const url = `${this.base}${path}${!token && this.apiKey ? `${separator}key=${encodeURIComponent(this.apiKey)}` : ''}`;
    return requestJSON(
      url,
      {
        ...options,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          'Content-Type': 'application/json',
          ...options.headers,
        },
      },
      this.fetcher,
    );
  }
  async read(tab) {
    const range = encodeURIComponent(`'${tab}'!A1:${lastColumn(tab)}`);
    const result = await this.call(`/values/${range}?valueRenderOption=FORMATTED_VALUE`);
    return rowsFromValues(tab, result.values);
  }
  async append(tab, rows) {
    if (!rows.length) return;
    const range = encodeURIComponent(`'${tab}'!A:${lastColumn(tab)}`);
    let result;
    for (let offset = 0; offset < rows.length; offset += 200) {
      result = await this.call(
        `/values/${range}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
        {
          method: 'POST',
          body: JSON.stringify({
            values: rows.slice(offset, offset + 200).map((row) => rowValues(tab, row)),
          }),
        },
        true,
      );
    }
    return result;
  }
  async update(tab, row) {
    return this.updateMany(tab, [row]);
  }
  async updateMany(tab, rows) {
    if (!rows.length) return;
    if (rows.some((row) => !Number.isInteger(row._row) || row._row < 2))
      throw new Error('Reload the sheet before updating this row.');
    // Chunk to stay comfortably within Google payload and quota limits.
    for (let i = 0; i < rows.length; i += 200) {
      await this.call(
        '/values:batchUpdate',
        {
          method: 'POST',
          body: JSON.stringify({
            valueInputOption: 'RAW',
            data: rows.slice(i, i + 200).map((row) => ({
              range: `'${tab}'!A${row._row}:${lastColumn(tab)}${row._row}`,
              values: [rowValues(tab, row)],
            })),
          }),
        },
        true,
      );
    }
  }
  async metadata() {
    const data = await this.call('?fields=spreadsheetId,properties(title),sheets(properties)');
    this.sheetIds = Object.fromEntries(
      (data.sheets || []).map((sheet) => [sheet.properties.title, sheet.properties.sheetId]),
    );
    return data;
  }
  async deleteRows(tab, rowNumbers) {
    if (!rowNumbers.length) return;
    if (rowNumbers.some((row) => !Number.isInteger(row) || row < 2))
      throw new Error('Invalid row to delete.');
    if (!this.sheetIds) await this.metadata();
    // Bottom to top so the remaining row numbers do not shift during the batch.
    const requests = [...new Set(rowNumbers)]
      .sort((a, b) => b - a)
      .map((row) => ({
        deleteDimension: {
          range: { sheetId: this.sheetIds[tab], dimension: 'ROWS', startIndex: row - 1, endIndex: row },
        },
      }));
    return this.call(':batchUpdate', { method: 'POST', body: JSON.stringify({ requests }) }, true);
  }
  async saveSettings(values) {
    const existing = await this.read('Settings');
    const updates = [],
      additions = [];
    for (const [key, value] of Object.entries(values)) {
      const found = existing.find((row) => row.key === key);
      (found ? updates : additions).push({ ...found, key, value: String(value) });
    }
    await this.updateMany('Settings', updates);
    await this.append('Settings', additions);
  }
  async initialize() {
    await this.metadata();
    const missing = Object.keys(SCHEMA).filter((tab) => this.sheetIds[tab] == null);
    // Validate all existing tabs first. Never overwrite existing non-matching headers.
    const blank = [];
    for (const tab of Object.keys(SCHEMA).filter((tab) => !missing.includes(tab))) {
      const data = await this.call(`/values/${encodeURIComponent(`'${tab}'!A1:Z1`)}`);
      if (!data.values?.[0]?.length) blank.push(tab);
      else rowsFromValues(tab, data.values);
    }
    if (missing.length)
      await this.call(
        ':batchUpdate',
        {
          method: 'POST',
          body: JSON.stringify({
            requests: missing.map((title) => ({
              addSheet: { properties: { title, gridProperties: { frozenRowCount: 1 } } },
            })),
          }),
        },
        true,
      );
    const tabs = [...missing, ...blank];
    if (tabs.length)
      await this.call(
        '/values:batchUpdate',
        {
          method: 'POST',
          body: JSON.stringify({
            valueInputOption: 'RAW',
            data: tabs.map((tab) => ({ range: `'${tab}'!A1`, values: [SCHEMA[tab]] })),
          }),
        },
        true,
      );
    await this.metadata();
    return tabs;
  }
}
export class GoogleBusinessClient {
  constructor({ getToken, fetcher = globalThis.fetch }) {
    this.getToken = getToken;
    this.fetcher = fetcher;
  }
  async call(url, options = {}, retries = 2) {
    const token = await this.getToken();
    if (!token)
      throw new Error(
        'Your Google session needs reconnecting. Open Settings → Google and connect your manager account.',
      );
    return requestJSON(
      url,
      {
        ...options,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...options.headers },
      },
      this.fetcher,
      retries,
    );
  }
  async pages(url, field, params = {}) {
    const results = [];
    let pageToken = '';
    const seen = new Set();
    do {
      const next = new URL(url);
      for (const [key, value] of Object.entries({ ...params, ...(pageToken ? { pageToken } : {}) }))
        next.searchParams.set(key, value);
      const data = await this.call(next.href);
      results.push(...(data[field] || []));
      pageToken = data.nextPageToken || '';
      if (pageToken && seen.has(pageToken))
        throw new Error('Google returned a repeated page token. Please try again.');
      seen.add(pageToken);
    } while (pageToken);
    return results;
  }
  accounts() {
    return this.pages('https://mybusinessaccountmanagement.googleapis.com/v1/accounts', 'accounts', {
      pageSize: '20',
    });
  }
  locations(account) {
    return this.pages(
      `https://mybusinessbusinessinformation.googleapis.com/v1/accounts/${encodeURIComponent(resourceId(account))}/locations`,
      'locations',
      { readMask: 'name,title,storefrontAddress', pageSize: '100' },
    );
  }
  reviewURL(business, reviewId = '') {
    const account = resourceId(business.google_account_id),
      location = resourceId(business.google_location_id);
    if (!account || !location)
      throw new Error('The business is missing its Google account or location ID. Scan it again.');
    return `https://mybusiness.googleapis.com/v4/accounts/${encodeURIComponent(account)}/locations/${encodeURIComponent(location)}/reviews${reviewId ? `/${encodeURIComponent(resourceId(reviewId))}` : ''}`;
  }
  async reviews(business) {
    const reviews = [];
    let pageToken = '',
      averageRating = 0,
      totalReviewCount = 0;
    const seen = new Set();
    do {
      const url = new URL(this.reviewURL(business));
      url.searchParams.set('pageSize', '50');
      url.searchParams.set('orderBy', 'updateTime desc');
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      const data = await this.call(url.href);
      reviews.push(...(data.reviews || []));
      averageRating = data.averageRating ?? averageRating;
      totalReviewCount = data.totalReviewCount ?? reviews.length;
      pageToken = data.nextPageToken || '';
      if (pageToken && seen.has(pageToken))
        throw new Error('Review pagination did not finish. Nothing has been synced.');
      seen.add(pageToken);
    } while (pageToken);
    return { reviews, averageRating, totalReviewCount };
  }
  getReview(business, reviewId) {
    return this.call(this.reviewURL(business, reviewId));
  }
  postReply(business, reviewId, comment) {
    const clean = String(comment || '').trim();
    if (!clean || clean.length > 4096) throw new Error('A reply must be between 1 and 4,096 characters.');
    if (!resourceId(reviewId))
      throw new Error('This review is missing its Google review ID. Sync the business first.');
    return this.call(
      `${this.reviewURL(business, reviewId)}/reply`,
      {
        method: 'PUT',
        body: JSON.stringify({ comment: clean }),
      },
      0,
    );
  }
  deleteReply(business, reviewId) {
    if (!resourceId(reviewId))
      throw new Error('This review is missing its Google review ID. Sync the business first.');
    return this.call(`${this.reviewURL(business, reviewId)}/reply`, { method: 'DELETE' }, 0);
  }
}
