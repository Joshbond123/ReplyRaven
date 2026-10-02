import { AppError, ensure } from './core.js';
import { one, run, getSetting } from './db.js';
const encoder = new TextEncoder();
export function b64url(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}
export function unb64url(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(normalized), (c) => c.charCodeAt(0));
}
export async function digest(value) {
  return b64url(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
}
async function vaultKey(env) {
  ensure(
    env.VAULT_SECRET && env.VAULT_SECRET.length >= 32,
    'The credential vault is not configured.',
    503,
    'setup_required',
  );
  return crypto.subtle.importKey(
    'raw',
    await crypto.subtle.digest('SHA-256', encoder.encode(env.VAULT_SECRET)),
    'AES-GCM',
    false,
    ['encrypt', 'decrypt'],
  );
}
export async function seal(env, value, context) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(context) },
    await vaultKey(env),
    encoder.encode(value),
  );
  return `${b64url(iv)}.${b64url(ciphertext)}`;
}
export async function open(env, value, context) {
  try {
    const [iv, ciphertext] = value.split('.');
    return new TextDecoder().decode(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: unb64url(iv), additionalData: encoder.encode(context) },
        await vaultKey(env),
        unb64url(ciphertext),
      ),
    );
  } catch {
    throw new AppError(
      'The credential vault could not be opened. Check the vault secret.',
      503,
      'vault_unavailable',
    );
  }
}
export async function protectedValue(env, key) {
  const row = await one(env, 'SELECT ciphertext FROM protected_values WHERE key = ?', key);
  return row ? open(env, row.ciphertext, key) : env[key] || '';
}
export async function saveProtected(env, key, value) {
  await run(
    env,
    'INSERT INTO protected_values(key,ciphertext,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET ciphertext=excluded.ciphertext,updated_at=excluded.updated_at',
    key,
    await seal(env, value, key),
    Date.now(),
  );
}
async function hmac(secret, value) {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
}
function equal(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) difference |= left[index] ^ right[index];
  return difference === 0;
}
export async function hashPassword(password, salt = b64url(crypto.getRandomValues(new Uint8Array(16)))) {
  const material = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const hash = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: unb64url(salt), iterations: 100000, hash: 'SHA-256' },
    material,
    256,
  );
  return `pbkdf2$${salt}$${b64url(hash)}`;
}
export async function passwordMatches(password, encoded) {
  const [scheme, salt] = String(encoded || '').split('$');
  if (scheme !== 'pbkdf2' || !salt) return false;
  const actual = await hashPassword(password, salt);
  return equal(encoder.encode(actual), encoder.encode(encoded));
}
export async function ownerPassword(env) {
  return protectedValue(env, 'ADMIN_PASSWORD_HASH');
}
export async function session(env, request) {
  ensure(
    env.SESSION_SECRET && env.SESSION_SECRET.length >= 32,
    'Authentication is not configured.',
    503,
    'setup_required',
  );
  const authorization = request.headers.get('Authorization') || '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  const pieces = token.split('.');
  ensure(pieces.length === 3, 'Sign in to continue.', 401, 'unauthorized');
  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(unb64url(pieces[1])));
  } catch {
    throw new AppError('Your session is invalid. Sign in again.', 401, 'unauthorized');
  }
  const signature = await hmac(env.SESSION_SECRET, `${pieces[0]}.${pieces[1]}`);
  let supplied;
  try {
    supplied = unb64url(pieces[2]);
  } catch {
    supplied = new Uint8Array();
  }
  ensure(
    equal(signature, supplied) &&
      payload.sub === 'owner' &&
      payload.exp > Date.now() / 1000 &&
      payload.aud === 'replyraven',
    'Your session expired. Sign in again.',
    401,
    'unauthorized',
  );
  ensure(
    (payload.ver || 0) === (await getSetting(env, 'auth_version', 0)),
    'Your session was revoked. Sign in again.',
    401,
    'unauthorized',
  );
  return payload;
}
export async function login(env, request, password) {
  ensure(
    env.SESSION_SECRET && env.SESSION_SECRET.length >= 32,
    'Authentication is not configured.',
    503,
    'setup_required',
  );
  const identity = await digest(request.headers.get('CF-Connecting-IP') || 'unavailable');
  const now = Date.now();
  const attempt = await one(env, 'SELECT * FROM auth_attempts WHERE identity = ?', identity);
  ensure(
    !attempt || now - attempt.window_start > 300000 || attempt.attempts < 10,
    'Too many sign-in attempts. Try again in five minutes.',
    429,
    'rate_limited',
  );
  await run(
    env,
    'INSERT INTO auth_attempts(identity,window_start,attempts) VALUES(?,?,1) ON CONFLICT(identity) DO UPDATE SET window_start=CASE WHEN ?-window_start>300000 THEN ? ELSE window_start END,attempts=CASE WHEN ?-window_start>300000 THEN 1 ELSE attempts+1 END',
    identity,
    now,
    now,
    now,
    now,
  );
  const stored = await ownerPassword(env);
  ensure(stored, 'The owner password has not been configured.', 503, 'setup_required');
  ensure(
    await passwordMatches(String(password || ''), stored),
    'That password is not correct.',
    401,
    'invalid_password',
  );
  await run(env, 'DELETE FROM auth_attempts WHERE identity = ?', identity);
  const expiry = Math.floor(now / 1000) + 7 * 86400;
  const header = b64url(encoder.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const version = await getSetting(env, 'auth_version', 0);
  const payload = b64url(
    encoder.encode(
      JSON.stringify({
        ver: version,
        sub: 'owner',
        aud: 'replyraven',
        iat: Math.floor(now / 1000),
        exp: expiry,
      }),
    ),
  );
  const signature = b64url(await hmac(env.SESSION_SECRET, `${header}.${payload}`));
  return { token: `${header}.${payload}.${signature}`, expires_at: expiry * 1000 };
}
