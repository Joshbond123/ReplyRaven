import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { randomBytes } from 'node:crypto';
import { requestJSON } from '../lib/api.js';
import { SCOPES } from '../lib/core.js';
const clientId = process.env.GOOGLE_CLIENT_ID || process.env.CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET || process.env.CLIENT_SECRET;
const redirectURI = process.env.GOOGLE_REDIRECT_URI || process.env.REDIRECT_URI;
try {
  if (!clientId || !redirectURI)
    throw new Error(
      'Set GOOGLE_CLIENT_ID and GOOGLE_REDIRECT_URI in your local .env. The redirect URI must exactly match your OAuth client and Pages callback URL.',
    );
  if (process.argv.includes('--url')) {
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    Object.entries({
      client_id: clientId,
      redirect_uri: redirectURI,
      response_type: 'code',
      scope: SCOPES,
      access_type: 'offline',
      prompt: 'consent',
      state: randomBytes(24).toString('hex'),
      include_granted_scopes: 'true',
    }).forEach(([key, value]) => url.searchParams.set(key, value));
    console.log(
      `Open this URL in your own browser, approve access, then copy the code from callback.html:\n\n${url.href}\n\nA URL generated here cannot be verified by the browser's session state; exchange only the code from the flow you initiated.`,
    );
  } else {
    if (!clientSecret) throw new Error('Set GOOGLE_CLIENT_SECRET locally. Never commit your .env.');
    let code = process.argv[2];
    if (!code) {
      if (!stdin.isTTY)
        throw new Error(
          'Supply the one-time code: node --env-file=.env scripts/get-token.js CODE. In an interactive terminal you can omit CODE and paste it at the prompt.',
        );
      const prompt = createInterface({ input: stdin, output: stdout });
      code = (await prompt.question('Paste the one-time Google authorization code: ')).trim();
      prompt.close();
    }
    if (!code?.trim()) throw new Error('No authorization code supplied.');
    const tokens = await requestJSON('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: code.trim(),
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectURI,
        grant_type: 'authorization_code',
      }),
    });
    console.log(
      '\nPRIVATE OUTPUT — copy to your own GitHub Secrets / browser settings. Never commit or share.\n',
    );
    console.log(`Access token (expires in ${tokens.expires_in} seconds):\n${tokens.access_token}\n`);
    if (tokens.refresh_token) console.log(`GOOGLE_REFRESH_TOKEN:\n${tokens.refresh_token}\n`);
    else
      console.warn(
        'No refresh token returned. Reauthorize with prompt=consent and access_type=offline. If needed, revoke the existing application grant in your Google account and authorize again.',
      );
    console.log(`Granted scopes:\n${tokens.scope || SCOPES}\n`);
  }
} catch (error) {
  console.error(`Token helper: ${error.message}`);
  process.exitCode = 1;
}
