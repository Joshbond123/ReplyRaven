export const DAY = 86_400_000;
export const PROVIDERS = ['openai', 'anthropic', 'gemini', 'groq'];
export const INTERVALS = [15, 30, 60, 120, 360];
export const EVENT_KINDS = [
  'google_expiry',
  'trial_ending',
  'monthly_due',
  'yearly_due',
  'reply_failed',
  'reply_success',
];
export const DEFAULT_AUTOMATION = { enabled: false, interval: 15, delay_min: 5, delay_max: 30 };
export const DEFAULT_NOTIFICATIONS = {
  enabled: true,
  email: false,
  browser: false,
  in_app: true,
  email_address: '',
  ...Object.fromEntries(EVENT_KINDS.map((kind) => [kind, true])),
};
export class AppError extends Error {
  constructor(message, status = 400, code = 'invalid_request') {
    super(message);
    this.status = status;
    this.code = code;
  }
}
export function ensure(condition, message, status = 400, code) {
  if (!condition) throw new AppError(message, status, code);
}
export const identifier = (value) =>
  String(value || '')
    .split('/')
    .filter(Boolean)
    .at(-1) || '';
export function boundedInt(value, min, max, fallback = min) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.floor(number))) : fallback;
}
export function normalizeAutomation(value = {}) {
  const interval = Number(value.interval);
  const low = boundedInt(value.delay_min, 5, 30, 5),
    high = boundedInt(value.delay_max, low, 30, 30);
  return {
    enabled: Boolean(value.enabled),
    interval: INTERVALS.includes(interval) ? interval : 15,
    delay_min: low,
    delay_max: high,
  };
}
export function normalizeNotifications(value = {}) {
  const result = { ...DEFAULT_NOTIFICATIONS };
  for (const key of ['enabled', 'email', 'browser', 'in_app', ...EVENT_KINDS])
    if (typeof value[key] === 'boolean') result[key] = value[key];
  result.email_address = String(value.email_address || '')
    .trim()
    .slice(0, 254);
  ensure(
    !result.email || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.exec(result.email_address),
    'Enter a valid email address to enable email notifications.',
  );
  return result;
}
export function nextDue(now, cycle, customDays = 30) {
  if (cycle === 'custom') return now + boundedInt(customDays, 1, 3650, 30) * DAY;
  const date = new Date(now),
    day = date.getUTCDate();
  date.setUTCDate(1);
  if (cycle === 'yearly') date.setUTCFullYear(date.getUTCFullYear() + 1);
  else date.setUTCMonth(date.getUTCMonth() + 1);
  const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, last));
  return date.getTime();
}
export function billingAllows(business, now = Date.now()) {
  if (!business.billing_enabled) return true;
  if (['expired', 'cancelled'].includes(business.payment_status)) return false;
  if (business.payment_status === 'trial')
    return Boolean(business.trial_enabled && business.trial_ends_at > now);
  return !business.subscription_enabled || Boolean(business.next_due_at > now);
}
export function hasReply(review) {
  return review?.reviewReply !== null && review?.reviewReply !== undefined;
}
export function rating(value) {
  return { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 }[value] || boundedInt(value, 0, 5);
}
export function automatedEligibility(business, review, settings, now = Date.now()) {
  return Boolean(
    settings.enabled &&
    business.auto_reply &&
    !business.deleted_at &&
    billingAllows(business, now) &&
    business.voice_status === 'ready' &&
    review.rating >= 4 &&
    review.rating <= 5 &&
    !review.reply &&
    !review.had_reply &&
    !review.archived &&
    review.reply_state === 'scheduled' &&
    review.eligible_at <= now,
  );
}
export function randomDelay(low, high) {
  const array = new Uint32Array(1);
  crypto.getRandomValues(array);
  return (low + (array[0] / 0x100000000) * (high - low)) * 60_000;
}
export function publicBusiness(row) {
  return {
    ...row,
    metadata: parseJSON(row.metadata, {}),
    voice_profile: parseJSON(row.voice_profile, null),
    voice_sources: parseJSON(row.voice_sources, {}),
    auto_reply: Boolean(row.auto_reply),
    billing_enabled: Boolean(row.billing_enabled),
    trial_enabled: Boolean(row.trial_enabled),
    subscription_enabled: Boolean(row.subscription_enabled),
    billing_allowed: billingAllows(row),
  };
}
export function parseJSON(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}
export function safeMessage(error) {
  const message = String(error?.message || 'The operation could not be completed.');
  return message
    .replace(/(?:Bearer\s+)[^\s]+/gi, 'Bearer [redacted]')
    .replace(/(?:sk-|gsk_|AIza|gh[pousr]_)[A-Za-z0-9_-]{12,}/g, '[redacted]')
    .slice(0, 500);
}
export function publicURL(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new AppError('Enter a valid public HTTPS website URL.');
  }
  const host = url.hostname.toLowerCase();
  ensure(
    url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443'),
    'Only public HTTPS websites are supported.',
  );
  ensure(
    !/^(?:localhost|.*\.local|.*\.internal|\[|\d+(?:\.\d+){3}$)/.exec(host) && host.includes('.'),
    'This website address is not public.',
  );
  return url;
}
