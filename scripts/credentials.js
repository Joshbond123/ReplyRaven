import { readFile } from 'node:fs/promises';
const aliases = {
  cloudflareaccountid: 'CLOUDFLARE_ACCOUNT_ID',
  accountid: 'CLOUDFLARE_ACCOUNT_ID',
  cloudflareapitoken: 'CLOUDFLARE_API_TOKEN',
  cloudflaretoken: 'CLOUDFLARE_API_TOKEN',
  d1databaseid: 'CLOUDFLARE_D1_DATABASE_ID',
  cloudflared1databaseid: 'CLOUDFLARE_D1_DATABASE_ID',
  databaseid: 'CLOUDFLARE_D1_DATABASE_ID',
  googleclientid: 'GOOGLE_CLIENT_ID',
  clientid: 'GOOGLE_CLIENT_ID',
  googleclientsecret: 'GOOGLE_CLIENT_SECRET',
  clientsecret: 'GOOGLE_CLIENT_SECRET',
  googlerefreshtoken: 'GOOGLE_REFRESH_TOKEN',
  refreshtoken: 'GOOGLE_REFRESH_TOKEN',
  googleconnectedat: 'GOOGLE_CONNECTED_AT',
  adminpassword: 'ADMIN_PASSWORD',
  workspacepassword: 'ADMIN_PASSWORD',
  adminemail: 'ADMIN_EMAIL',
  notificationemail: 'ADMIN_EMAIL',
  resendapikey: 'RESEND_API_KEY',
  emailfrom: 'EMAIL_FROM',
  senderemail: 'EMAIL_FROM',
  publicsiteurl: 'PUBLIC_SITE_URL',
  domain: 'PUBLIC_SITE_URL',
  cloudflareworkerurl: 'CLOUDFLARE_WORKER_URL',
  openaiapikey: 'OPENAI_API_KEY',
  anthropicapikey: 'ANTHROPIC_API_KEY',
  geminiapikey: 'GEMINI_API_KEY',
  groqapikey: 'GROQ_API_KEY',
  sessionsecret: 'SESSION_SECRET',
  vaultsecret: 'VAULT_SECRET',
  vapidpublickey: 'VAPID_PUBLIC_KEY',
  vapidprivatekey: 'VAPID_PRIVATE_KEY',
  githubpat: 'DEPLOY_GITHUB_TOKEN',
  githubtoken: 'DEPLOY_GITHUB_TOKEN',
  githubpersonalaccesstoken: 'DEPLOY_GITHUB_TOKEN',
};
export async function readCredentials(path) {
  if (!path) return {};
  const raw = (await readFile(path, 'utf8')).replace(/^\uFEFF/, '');
  let source;
  try {
    source = JSON.parse(raw);
  } catch {}
  const result = {};
  function accept(label, value) {
    const normalized = label.toLowerCase().replace(/[^a-z0-9]/g, '');
    let name = aliases[normalized];
    if (!name && /^[A-Z][A-Z0-9_]+$/.exec(label))
      name = Object.values(aliases).includes(label) ? label : null;
    if (name && value !== undefined && value !== null) {
      const cleaned = String(value)
        .trim()
        .replace(/^["'`]|["'`]$/g, '');
      if (cleaned) result[name] = cleaned;
    }
  }
  if (source && typeof source === 'object' && !Array.isArray(source))
    for (const [label, value] of Object.entries(source)) accept(label, value);
  else {
    const lines = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    for (let index = 0; index < lines.length; index++) {
      const match = /^([A-Za-z][A-Za-z0-9 _-]{1,70})\s*[:=]\s*(.*)$/.exec(lines[index]);
      if (match) accept(match[1], match[2] || lines[index + 1]);
    }
  }
  return result;
}
export const credentialArgument = () => {
  const index = process.argv.indexOf('--credentials-file');
  return index >= 0 ? process.argv[index + 1] : process.env.REPLYRAVEN_CREDENTIALS_FILE;
};
