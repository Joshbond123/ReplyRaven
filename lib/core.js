/** Shared, dependency-free data model. Imported by the browser and Actions. */
export const SCHEMA = Object.freeze({
  Businesses: [
    'google_account_id',
    'google_location_id',
    'business_name',
    'address',
    'is_auto_reply',
    'ai_prompt_template',
    'total_reviews',
    'avg_rating',
    'last_sync',
    'status',
    'unreplied_count',
  ],
  Reviews: [
    'google_review_id',
    'google_location_id',
    'business_name',
    'reviewer_name',
    'star_rating',
    'comment',
    'review_date',
    'reply_comment',
    'is_replied',
    'reply_date',
    'is_auto_replied',
    'needs_attention',
  ],
  AI_Keys: ['provider', 'api_key', 'is_active', 'request_count', 'last_used_at', 'model_name', 'id'],
  Settings: ['key', 'value'],
  Logs: ['timestamp', 'business_name', 'action', 'review_id', 'status', 'details', 'stars'],
});
export const DEFAULT_PASSWORD = 'ReplyRaven123';
export const DEFAULT_PROMPT =
  'Write a warm, specific, professional Google review reply for {business_name}. The customer gave {stars} stars and wrote: {comment}. Keep it under 70 words. Thank them, reference their experience if one is given, and do not invent facts, discounts, or promises. Return only the reply.';
export const SCOPES =
  'https://www.googleapis.com/auth/business.manage https://www.googleapis.com/auth/spreadsheets';
export const PROVIDER_MODELS = {
  openai: 'gpt-4o-mini',
  gpt: 'gpt-4o-mini',
  gemini: 'gemini-2.5-flash',
  anthropic: 'claude-sonnet-4-20250514',
  groq: 'llama-3.3-70b-versatile',
};
export const isTrue = (value) =>
  value === true || ['TRUE', '1', 'YES'].includes(String(value).trim().toUpperCase());
export const bool = (value) => (isTrue(value) ? 'TRUE' : 'FALSE');
export const starsNumber = (value) =>
  ({ ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 })[value] ?? Math.max(0, Math.min(5, Number(value) || 0));
export const resourceId = (value) =>
  String(value || '')
    .split('/')
    .filter(Boolean)
    .at(-1) || '';
export const reviewKey = (row) => `${resourceId(row.google_location_id)}:${resourceId(row.google_review_id)}`;
export const activeBusiness = (row) =>
  !['DELETED', 'INACTIVE', 'ARCHIVED'].includes(String(row.status || 'ACTIVE').toUpperCase());
export const autoReplyEligible = (review, business) =>
  Boolean(
    business &&
    activeBusiness(business) &&
    isTrue(business.is_auto_reply) &&
    !isTrue(review.is_replied) &&
    starsNumber(review.star_rating) >= 4 &&
    resourceId(review.google_location_id) === resourceId(business.google_location_id),
  );
export function escapeHTML(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
  );
}
export function rowValues(tab, object) {
  if (!SCHEMA[tab]) throw new Error(`Unknown sheet tab: ${tab}`);
  // RAW writes are intentional: no formulas from user reviews, and no rounding of Google IDs.
  return SCHEMA[tab].map((key) => (object[key] == null ? '' : String(object[key])));
}
export function rowsFromValues(tab, values = []) {
  const headers = SCHEMA[tab];
  if (!headers) throw new Error(`Unknown sheet tab: ${tab}`);
  if (!values.length)
    throw new Error(`${tab} is empty. Use “Prepare sheet” in Google settings to add the exact headers.`);
  if (headers.some((header, index) => values[0]?.[index] !== header) || values[0].length !== headers.length) {
    throw new Error(
      `${tab} headers do not match the ReplyRaven schema. See the setup guide; existing data has not been changed.`,
    );
  }
  return values
    .slice(1)
    .map((cells, index) =>
      Object.fromEntries([...headers.map((key, i) => [key, String(cells[i] ?? '')]), ['_row', index + 2]]),
    )
    .filter((row) => headers.some((key) => row[key] !== ''));
}
export function reviewFromGoogle(review, business, existing = {}) {
  const comment = review.reviewReply?.comment || '';
  const replied = Boolean(comment);
  const stars = starsNumber(review.starRating);
  // A manually changed reply must no longer be labeled as an automatic reply.
  const stillAuto = replied && isTrue(existing.is_auto_replied) && existing.reply_comment === comment;
  return {
    ...existing,
    google_review_id: resourceId(review.reviewId || review.name),
    google_location_id: resourceId(business.google_location_id),
    business_name: business.business_name,
    reviewer_name: review.reviewer?.displayName || 'Anonymous reviewer',
    star_rating: String(stars),
    comment: review.comment || '',
    review_date: review.createTime || review.updateTime || '',
    reply_comment: replied ? comment : !isTrue(existing.is_replied) ? existing.reply_comment || '' : '',
    is_replied: bool(replied),
    reply_date: review.reviewReply?.updateTime || '',
    is_auto_replied: bool(stillAuto),
    needs_attention: bool(stars <= 3 && !replied),
  };
}
export function promptFor(review, business, template = DEFAULT_PROMPT) {
  const values = {
    stars: starsNumber(review.star_rating),
    comment: review.comment || '(Rating only; no written comment.)',
    business_name: business.business_name,
  };
  return String(template || DEFAULT_PROMPT).replace(/\{(stars|comment|business_name)\}/g, (_, key) =>
    String(values[key]),
  );
}
export function summarize(businesses, reviews, now = new Date()) {
  const today = now.toISOString().slice(0, 10);
  const tracked = new Set(businesses.filter(activeBusiness).map((b) => resourceId(b.google_location_id)));
  const relevant = reviews.filter((r) => tracked.has(resourceId(r.google_location_id)));
  return {
    businesses: tracked.size,
    reviews: businesses.filter(activeBusiness).reduce((sum, b) => sum + (Number(b.total_reviews) || 0), 0),
    unreplied: relevant.filter((r) => !isTrue(r.is_replied)).length,
    autoToday: relevant.filter(
      (r) => isTrue(r.is_auto_replied) && isTrue(r.is_replied) && r.reply_date?.slice(0, 10) === today,
    ).length,
  };
}
export function normalizeAIKey(key, index = 0) {
  const provider = String(key.provider || 'openai').toLowerCase();
  return {
    ...key,
    provider,
    api_key: String(key.api_key || key.key || ''),
    model_name: key.model_name || key.model || PROVIDER_MODELS[provider],
    is_active: key.is_active == null ? 'TRUE' : bool(key.is_active),
    request_count: Number(key.request_count) || 0,
    id: String(key.id || `secret-${index + 1}`),
  };
}
export function validSession(storage, now = Date.now()) {
  return storage.getItem('auth') === 'true' && Number(storage.getItem('auth_expiry')) > now;
}
export function makeLog(business, action, status, details, review = null) {
  return {
    timestamp: new Date().toISOString(),
    business_name: business?.business_name || 'Workspace',
    action,
    review_id: review?.google_review_id || '',
    status,
    details: String(details || '').slice(0, 1500),
    stars: review?.star_rating || '',
  };
}
