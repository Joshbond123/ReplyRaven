import { AppError, ensure, hasReply, identifier, publicURL, rating } from './core.js';
import { protectedValue } from './security.js';
const tokenCache = new Map();
export async function remoteJSON(url, options = {}, service = 'Remote service') {
  let response;
  try {
    response = await fetch(url, { ...options, signal: options.signal || AbortSignal.timeout(30_000) });
  } catch {
    throw new AppError(`${service} could not be reached.`, 502, 'remote_unavailable');
  }
  if (response.status === 204) return {};
  let data;
  try {
    data = await response.json();
  } catch {
    throw new AppError(`${service} returned an unreadable response.`, 502, 'remote_unavailable');
  }
  if (!response.ok) {
    const error = new AppError(
      `${service} returned HTTP ${response.status}.`,
      response.status,
      response.status === 429 ? 'rate_limited' : 'remote_error',
    );
    error.retryAfter = Number(response.headers.get('Retry-After')) || 60;
    if (service === 'Google authorization' && data.error === 'invalid_grant') {
      error.message = 'Reconnect Google: the refresh token was revoked or has expired.';
      error.code = 'google_expired';
    }
    // Google Business Profile quota / rate-limit details
    if (response.status === 429) {
      const details = Array.isArray(data?.error?.details) ? data.error.details : [];
      const info = details.find((d) => d['@type']?.includes('ErrorInfo')) || {};
      const meta = info.metadata || {};
      const limitValue = meta.quota_limit_value;
      const serviceName = meta.service || '';
      if (limitValue === '0' || limitValue === 0) {
        error.message =
          'Google Business Profile API quota is 0 for this Cloud project. Enable the “My Business Account Management API” and “My Business Business Information API” in Google Cloud Console, then request quota (or wait for default quota). Project: 893046235703.';
        error.code = 'google_quota_zero';
      } else {
        error.message = `Google rate-limited Business Profile requests (${serviceName || 'API'}). Wait about ${error.retryAfter}s and try again.`;
        error.code = 'google_rate_limited';
      }
    } else if (response.status === 403 && /business|Google/i.test(service)) {
      const msg = data?.error?.message || '';
      if (/API has not been used|disabled|not enabled/i.test(msg)) {
        error.message =
          'A required Google Business Profile API is not enabled on the Cloud project. Enable My Business Account Management API and My Business Business Information API, then retry.';
        error.code = 'google_api_disabled';
      }
    }
    throw error;
  }
  return data;
}
export async function googleCredentials(env) {
  const [clientId, clientSecret, refreshToken] = await Promise.all(
    ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN'].map((key) =>
      protectedValue(env, key),
    ),
  );
  return { clientId, clientSecret, refreshToken };
}
export class GoogleClient {
  constructor(credentials) {
    this.credentials = credentials;
  }
  async token() {
    const { clientId, clientSecret, refreshToken } = this.credentials;
    ensure(
      clientId && clientSecret && refreshToken,
      'Connect Google in Settings before managing businesses.',
      409,
      'google_not_connected',
    );
    const cacheKey = `${clientId}\0${clientSecret}\0${refreshToken}`;
    const cached = tokenCache.get(cacheKey);
    if (cached?.expires > Date.now() + 90_000) return cached.token;
    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    });
    const response = await remoteJSON(
      'https://oauth2.googleapis.com/token',
      { method: 'POST', body },
      'Google authorization',
    );
    ensure(response.access_token, 'Google did not return an access token.', 502);
    if (tokenCache.size > 100) tokenCache.clear();
    tokenCache.set(cacheKey, {
      token: response.access_token,
      expires: Date.now() + Number(response.expires_in || 3600) * 1000,
    });
    return response.access_token;
  }
  async call(url, options = {}) {
    return remoteJSON(
      url,
      {
        ...options,
        headers: {
          Authorization: `Bearer ${await this.token()}`,
          'Content-Type': 'application/json',
          ...options.headers,
        },
      },
      'Google Business Profile',
    );
  }
  async accounts(pageToken = '') {
    const query = new URLSearchParams({ pageSize: '20' });
    if (pageToken) query.set('pageToken', pageToken);
    return this.call(`https://mybusinessaccountmanagement.googleapis.com/v1/accounts?${query}`);
  }
  async locations(account, pageToken = '') {
    const accountId = identifier(account);
    ensure(accountId, 'Google account ID is missing.');
    const query = new URLSearchParams({
      pageSize: '100',
      readMask: 'name,title,storefrontAddress,websiteUri,categories,profile,metadata',
    });
    if (pageToken) query.set('pageToken', pageToken);
    try {
      return await this.call(
        `https://mybusinessbusinessinformation.googleapis.com/v1/accounts/${encodeURIComponent(accountId)}/locations?${query}`,
      );
    } catch (error) {
      // Managers sometimes fail with the full readMask — retry with a minimal mask.
      if ([400, 403].includes(error.status)) {
        const minimal = new URLSearchParams({
          pageSize: '100',
          readMask: 'name,title,storefrontAddress,websiteUri',
        });
        if (pageToken) minimal.set('pageToken', pageToken);
        return this.call(
          `https://mybusinessbusinessinformation.googleapis.com/v1/accounts/${encodeURIComponent(accountId)}/locations?${minimal}`,
        );
      }
      throw error;
    }
  }
  async profile(locationId) {
    const id = identifier(locationId);
    ensure(id, 'Google location ID is missing.');
    const masks = [
      'name,title,storefrontAddress,websiteUri,categories,profile,regularHours,metadata',
      'name,title,storefrontAddress,websiteUri,categories,profile',
      'name,title,storefrontAddress,websiteUri',
    ];
    let lastError;
    for (const readMask of masks) {
      try {
        return await this.call(
          `https://mybusinessbusinessinformation.googleapis.com/v1/locations/${encodeURIComponent(id)}?readMask=${encodeURIComponent(readMask)}`,
        );
      } catch (error) {
        lastError = error;
        if (![400, 403].includes(error.status)) throw error;
      }
    }
    throw lastError;
  }
  reviewsURL(business, reviewId = '') {
    const account = identifier(business.google_account_id),
      location = identifier(business.google_location_id);
    ensure(account && location, 'This business is missing its Google account or location ID.');
    const root = `https://mybusiness.googleapis.com/v4/accounts/${encodeURIComponent(account)}/locations/${encodeURIComponent(location)}/reviews`;
    return reviewId ? `${root}/${encodeURIComponent(identifier(reviewId))}` : root;
  }
  async reviews(business, pageToken = '', pageSize = 50) {
    const query = new URLSearchParams({ pageSize: String(pageSize), orderBy: 'updateTime desc' });
    if (pageToken) query.set('pageToken', pageToken);
    return this.call(`${this.reviewsURL(business)}?${query}`);
  }
  async review(business, reviewId) {
    ensure(identifier(reviewId), 'The review has no Google ID.');
    return this.call(this.reviewsURL(business, reviewId));
  }
  async post(business, reviewId, comment) {
    ensure(identifier(reviewId), 'The review has no Google ID.');
    ensure(
      typeof comment === 'string' && comment.trim().length > 0 && comment.length <= 4096,
      'Replies must contain between 1 and 4,096 characters.',
    );
    const reply = await this.call(`${this.reviewsURL(business, reviewId)}/reply`, {
      method: 'PUT',
      body: JSON.stringify({ comment: comment.trim() }),
    });
    ensure(
      typeof reply.comment === 'string' && reply.comment.trim() === comment.trim(),
      'Google did not confirm the posted reply content.',
      502,
      'remote_unavailable',
    );
    return reply;
  }
  async removeReply(business, reviewId) {
    ensure(identifier(reviewId), 'The review has no Google ID.');
    return this.call(`${this.reviewsURL(business, reviewId)}/reply`, { method: 'DELETE' });
  }
}
export const googleClient = async (env) => new GoogleClient(await googleCredentials(env));
export function normalizeLocation(location, account) {
  const address = location.storefrontAddress || {};
  return {
    google_location_id: identifier(location.name),
    google_account_id: identifier(account),
    name: String(location.title || '').trim(),
    address: [
      ...(address.addressLines || []),
      address.locality,
      address.administrativeArea,
      address.postalCode,
    ]
      .filter(Boolean)
      .join(', '),
    website: location.websiteUri || '',
    metadata: location,
  };
}
export function normalizeReview(remote) {
  const id = identifier(remote.reviewId || remote.name);
  ensure(id, 'Google returned a review without an ID. Sync has stopped safely.', 502);
  return {
    google_review_id: id,
    reviewer: remote.reviewer?.displayName || 'Google customer',
    rating: rating(remote.starRating),
    comment: remote.comment || '',
    created_at: Date.parse(remote.createTime) || Date.now(),
    updated_at: Date.parse(remote.updateTime || remote.createTime) || Date.now(),
    reply: hasReply(remote) ? remote.reviewReply?.comment || '' : null,
    replied_at: hasReply(remote) ? Date.parse(remote.reviewReply?.updateTime) || Date.now() : null,
    has_reply: hasReply(remote),
  };
}
export async function discover(env, cursor = null) {
  const client = await googleClient(env);
  let state =
    cursor && typeof cursor === 'object'
      ? cursor
      : { accountToken: '', accounts: [], index: 0, locationToken: '' };
  ensure(JSON.stringify(state).length <= 12000, 'The discovery cursor is too large.');
  if (!state.accounts?.length || state.index >= state.accounts.length) {
    const response = await client.accounts(state.accountToken || '');
    state = {
      accountToken: response.nextPageToken || '',
      accounts: (response.accounts || []).map((account) => ({
        id: account.name,
        name: account.accountName || account.name || '',
        type: account.type || account.organizationInfo?.registeredDomain || '',
        role: account.role || account.permissionLevel || '',
      })),
      index: 0,
      locationToken: '',
    };
    if (!state.accounts.length)
      return {
        locations: [],
        cursor: null,
        errors: [
          {
            account: 'Google',
            message:
              'No Google Business accounts were returned. Confirm the connected Google account is Owner or Manager on at least one Business Profile, and that the Business Profile APIs are enabled on the Google Cloud project.',
          },
        ],
      };
  }
  const account = state.accounts[state.index];
  let response,
    errors = [];
  try {
    response = await client.locations(account.id, state.locationToken || '');
  } catch (error) {
    if (error.code === 'google_expired') throw error;
    const status = error.status || 502;
    const hint =
      status === 403
        ? ' Manager access may be limited, or the Business Information API is not enabled for this project.'
        : status === 404
          ? ' This account may not expose locations via the Business Information API.'
          : '';
    errors.push({
      account: account.name || account.id,
      message: `Locations could not be read for this account (HTTP ${status}).${hint}`,
    });
    response = {};
  }
  const locations = (response.locations || []).map((location) => normalizeLocation(location, account.id));
  if (response.nextPageToken) {
    ensure(response.nextPageToken !== state.locationToken, 'Google repeated a pagination cursor.', 502);
    state.locationToken = response.nextPageToken;
  } else {
    state.index++;
    state.locationToken = '';
  }
  return {
    locations,
    errors,
    cursor: state.index < state.accounts.length || state.accountToken ? state : null,
  };
}
export async function websiteText(value) {
  if (!value) return { text: '', url: '', status: 'unavailable' };
  let url = publicURL(value);
  for (let count = 0; count < 4; count++) {
    const response = await fetch(url.toString(), {
      redirect: 'manual',
      signal: AbortSignal.timeout(15000),
      headers: { 'User-Agent': 'ReplyRaven/2.0 BrandVoice' },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      ensure(response.headers.get('Location'), 'The website redirect is incomplete.');
      url = publicURL(new URL(response.headers.get('Location'), url).toString());
      continue;
    }
    ensure(
      response.ok && /text\/html|text\/plain/.exec(response.headers.get('Content-Type') || ''),
      'The website could not be read.',
      502,
    );
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = '',
      size = 0;
    try {
      while (size < 120000) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        text += decoder.decode(chunk.value, { stream: true });
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    text = text
      .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;|&#160;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 14000);
    return { text, url: url.toString(), status: 'read' };
  }
  throw new AppError('The website has too many redirects.', 502);
}
