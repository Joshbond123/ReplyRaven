import { google } from 'googleapis';
import { GoogleSpreadsheet } from 'google-spreadsheet';
import { SheetsClient, GoogleBusinessClient, requestJSON, sleep } from '../../lib/api.js';
import { SCHEMA, rowsFromValues } from '../../lib/core.js';
import { appendFile } from 'node:fs/promises';
import { SDKAIKeyRotator } from './providers.js';

export function envConfig(env = process.env) {
  const values = {
    sheetId: env.GOOGLE_SHEET_ID || env.SHEET_ID,
    clientId: env.GOOGLE_CLIENT_ID || env.CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET || env.CLIENT_SECRET,
    refreshToken: env.GOOGLE_REFRESH_TOKEN || env.REFRESH_TOKEN,
  };
  const missing = Object.entries(values)
    .filter(([, value]) => !value)
    .map(([key]) => key);
  if (missing.length)
    throw new Error(
      `Missing required GitHub Secrets / local environment: ${missing.join(', ')}. See README.md.`,
    );
  return values;
}
export async function refreshAccessToken(
  { clientId, clientSecret, refreshToken },
  fetcher = globalThis.fetch,
) {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  const tokens = await requestJSON(
    'https://oauth2.googleapis.com/token',
    { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body },
    fetcher,
  );
  if (!tokens.access_token)
    throw new Error('Google did not return an access token. Reauthorize offline access.');
  return tokens;
}
export async function createRuntime(env = process.env) {
  const config = envConfig(env),
    tokens = await refreshAccessToken(config);
  const auth = new google.auth.OAuth2(config.clientId, config.clientSecret);
  auth.setCredentials({
    access_token: tokens.access_token,
    refresh_token: config.refreshToken,
    expiry_date: Date.now() + Number(tokens.expires_in || 3600) * 1000,
  });
  const doc = new GoogleSpreadsheet(config.sheetId, auth);
  await doc.loadInfo();
  // Sheets has separate per-user read/write quotas. Queue calls below 60/minute.
  const nextSlot = { read: 0, write: 0 };
  async function throttle(kind) {
    const now = Date.now(),
      wait = Math.max(0, nextSlot[kind] - now);
    nextSlot[kind] = Math.max(now, nextSlot[kind]) + 1150;
    if (wait) await sleep(wait);
  }
  class AutomationSheets extends SheetsClient {
    async call(path = '', options = {}, write = false) {
      await throttle(write ? 'write' : 'read');
      return super.call(path, options, write);
    }
    async read(tab) {
      const sheet = doc.sheetsByTitle[tab];
      if (!sheet)
        throw new Error(
          `Missing ${tab} tab. Use Prepare sheet in Settings or create it using the README headers.`,
        );
      await throttle('read');
      // Open-ended ranges avoid a stale cached rowCount after REST appends/deletes.
      const values = await sheet.getCellsInRange(`A1:${String.fromCharCode(64 + SCHEMA[tab].length)}`);
      return rowsFromValues(tab, values || []);
    }
  }
  const getToken = async () => {
    const { token } = await auth.getAccessToken();
    return token || '';
  };
  const store = new AutomationSheets({ sheetId: config.sheetId, getToken });
  const business = new GoogleBusinessClient({ getToken });
  const secrets = [config.clientSecret, config.refreshToken, tokens.access_token];
  try {
    secrets.push(
      ...JSON.parse(env.AI_KEYS_JSON || '[]')
        .map((key) => key.api_key || key.key)
        .filter(Boolean),
    );
  } catch {
    /* auto-reply validates malformed JSON before processing. */
  }
  const redact = (value) => {
    let text = String(value || '');
    for (const secret of secrets.filter((s) => s?.length > 5)) text = text.split(secret).join('[redacted]');
    return text;
  };
  return { store, google: business, redact, doc, AIEngine: SDKAIKeyRotator };
}
export async function writeSummary(title, lines) {
  const content = `## ${title}\n\n${lines.map((line) => `- ${line}`).join('\n')}\n`;
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, content);
  console.log(lines.join('\n'));
}
