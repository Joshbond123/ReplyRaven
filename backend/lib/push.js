import { b64url, unb64url } from './security.js';
import { ensure } from './core.js';
const encode = (value) => new TextEncoder().encode(value);
const join = (...arrays) => {
  const result = new Uint8Array(arrays.reduce((sum, array) => sum + array.length, 0));
  let offset = 0;
  for (const array of arrays) {
    result.set(array, offset);
    offset += array.length;
  }
  return result;
};
async function hmac(key, value) {
  const material = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  return new Uint8Array(await crypto.subtle.sign('HMAC', material, value));
}
export function validateSubscription(value) {
  ensure(
    value?.endpoint && value.keys?.p256dh && value.keys?.auth,
    'The browser subscription is incomplete.',
  );
  const endpoint = new URL(value.endpoint);
  ensure(
    endpoint.protocol === 'https:' &&
      /^(?:fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|(?:[^.]+\.)*push\.apple\.com|web\.push\.apple\.com)$/.exec(
        endpoint.hostname,
      ),
    'This browser push service is not supported.',
  );
  ensure(
    value.endpoint.length < 3000 &&
      unb64url(value.keys.p256dh).length === 65 &&
      unb64url(value.keys.auth).length === 16,
    'The browser subscription keys are invalid.',
  );
  return { endpoint: value.endpoint, keys: { p256dh: value.keys.p256dh, auth: value.keys.auth } };
}
export async function sendPush(env, subscription, payload) {
  ensure(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY, 'Browser delivery is not configured.', 503);
  subscription = validateSubscription(subscription);
  const clientPublic = unb64url(subscription.keys.p256dh),
    auth = unb64url(subscription.keys.auth);
  const ephemeral = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ]);
  const serverPublic = new Uint8Array(await crypto.subtle.exportKey('raw', ephemeral.publicKey));
  const clientKey = await crypto.subtle.importKey(
    'raw',
    clientPublic,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: clientKey }, ephemeral.privateKey, 256),
  );
  const intermediate = await hmac(
    await hmac(auth, shared),
    join(encode('WebPush: info\0'), clientPublic, serverPublic, new Uint8Array([1])),
  );
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmac(salt, intermediate);
  const cek = (await hmac(prk, join(encode('Content-Encoding: aes128gcm\0'), new Uint8Array([1])))).slice(
    0,
    16,
  );
  const nonce = (await hmac(prk, join(encode('Content-Encoding: nonce\0'), new Uint8Array([1])))).slice(
    0,
    12,
  );
  const raw = encode(JSON.stringify(payload));
  ensure(raw.length < 3000, 'The browser notification is too large.');
  const contentKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, contentKey, join(raw, new Uint8Array([2]))),
  );
  const recordSize = new Uint8Array(4);
  new DataView(recordSize.buffer).setUint32(0, 4096);
  const body = join(salt, recordSize, new Uint8Array([65]), serverPublic, ciphertext);
  const publicKey = unb64url(env.VAPID_PUBLIC_KEY);
  ensure(publicKey.length === 65, 'The browser signing key is invalid.', 503);
  const signingKey = await crypto.subtle.importKey(
    'jwk',
    {
      kty: 'EC',
      crv: 'P-256',
      x: b64url(publicKey.slice(1, 33)),
      y: b64url(publicKey.slice(33)),
      d: env.VAPID_PRIVATE_KEY,
      ext: true,
    },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  const header = b64url(encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' }))),
    claims = b64url(
      encode(
        JSON.stringify({
          aud: new URL(subscription.endpoint).origin,
          exp: Math.floor(Date.now() / 1000) + 43200,
          sub: env.ADMIN_EMAIL ? `mailto:${env.ADMIN_EMAIL}` : new URL(env.PUBLIC_SITE_URL).origin,
        }),
      ),
    );
  const signature = b64url(
    await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signingKey, encode(`${header}.${claims}`)),
  );
  const response = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      Authorization: `vapid t=${header}.${claims}.${signature}, k=${env.VAPID_PUBLIC_KEY}`,
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: '86400',
      Urgency: 'normal',
    },
    body,
    signal: AbortSignal.timeout(20000),
  });
  return response;
}
