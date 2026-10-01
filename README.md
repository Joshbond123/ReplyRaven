<p align="center"><img src="assets/raven.svg" width="56" alt="ReplyRaven"></p>
<h1 align="center">ReplyRaven</h1>
<p align="center"><strong>A little care. A lasting impression.</strong><br>A premium, self-hosted workspace for Google Business Profile reviews.<br>GitHub Pages + Google Sheets + GitHub Actions. No application database.</p>

## What’s included

- A responsive landing site, password gate, overview, unified review inbox, per-business reviews, OAuth callback, and settings.
- Light/dark themes, Inter, Tailwind CDN, Framer Motion CDN enhancements, Lucide CDN with a local fallback, animated cards, charts, skeletons, focus-trapped dialogs, and toasts. Inter and icons also work without the CDNs.
- **Scan businesses where I’m manager**: paginate accessible Google accounts and locations, compare against Sheets, select new locations, and add them. Owners and managers are both supported; it never discovers businesses your Google account cannot access.
- Manual sync, write/edit/delete owner replies, AI drafts, a WhatsApp share-link generator, filters, search, and CSV export.
- Opt-in 4–5 star auto-replies, customizable global/per-business prompts, round-robin AI keys, and failover across OpenAI/GPT, Gemini, Anthropic, and Groq.
- Scheduled sync every 15 minutes and replies every 30 minutes, with a shared writer lock, rate pacing, logs, and GitHub job summaries.
- A clearly labeled **interactive demo**. Demo changes are stored only on this device and never call Google or an AI provider. Real workspace data lives in Sheets; localStorage holds connection settings and UI preferences.
- Unit/API/automation tests and desktop/mobile browser tests, including mocked private-Sheets integration.

> **Important:** GitHub Pages is a static host. The local password is a convenience gate, **not server-side authentication**. This is a personal, single-user review workspace, not a secure multi-tenant SaaS. Keep the Sheet private, protect your Google OAuth credentials, and use a trusted device. Google API approval, OAuth, your Sheet, provider keys, and Actions secrets must be configured before live operations can work. The site and demo work immediately, without them.

## Quick start / preview

Use Node **20.12+** (or a newer LTS) for the local `.env` commands.

```bash
npm ci
npm run dev
```

Open `http://localhost:3000`. The server binds to `0.0.0.0`, accepts preview hosts, and requires no build. All browser app URLs are relative, so project subpaths such as `/ReplyRaven/` work on Pages.

- Click **Explore the demo** to try every workflow without credentials.
- Or sign in with the case-sensitive initial password **`ReplyRaven123`**.
- Change it in **Settings → Account**. The password and seven-day local session apply only to that browser/origin. They do not sign you into Google.
- A valid local session redirects both the landing and login pages to the dashboard. An expired session on an app page redirects to login. Logout clears the gate and returns to the landing page.

## Architecture

```text
Browser on GitHub Pages
  ├─ Google Identity Services → short-lived OAuth access token
  ├─ Google Business APIs → accounts, locations, reviews, owner replies
  ├─ Google Sheets API → the five private data tabs
  └─ AI provider API (or optional Apps Script AI relay) → reply drafts

GitHub Actions
  ├─ GitHub Secrets → OAuth client + offline refresh token + AI keys
  ├─ refresh access token → Google Business APIs
  ├─ google-spreadsheet / Sheets REST → same five private tabs
  └─ official OpenAI / Gemini SDKs (+ Anthropic REST) → safe reply queue
```

No Firebase, SQL, hosted application server, or paid ReplyRaven subscription. AI provider usage, API quotas, and any applicable GitHub Actions charges are your responsibility.

## 1. Create and approve your Google Cloud project

1. Create a project at [Google Cloud Console](https://console.cloud.google.com/).
2. Read [Business Profile API prerequisites](https://developers.google.com/my-business/content/prereqs) and [request API access](https://developers.google.com/my-business/content/basic-setup). **Google must approve Business Profile API access.** Merely enabling the services does not grant a usable quota. Check your approved quota if accounts/locations return 403/429.
3. Enable these services in **APIs & Services → Library**:

   | Console API                                          | Service                                        |
   | ---------------------------------------------------- | ---------------------------------------------- |
   | My Business Account Management API                   | `mybusinessaccountmanagement.googleapis.com`   |
   | My Business Business Information API                 | `mybusinessbusinessinformation.googleapis.com` |
   | Google My Business API / Business Profile v4 reviews | `mybusiness.googleapis.com`                    |
   | Google Sheets API                                    | `sheets.googleapis.com`                        |

4. Use a Gmail/Google account that is actually an **owner or manager** of the Business Profiles you want to manage. Reviews are available for verified locations. API availability and Google quotas, not ReplyRaven, determine how many calls can run.
5. Configure the OAuth consent screen / Google Auth Platform. Add your own Google account as a test user if the app is in Testing.
6. Configure these scopes:

   ```text
   https://www.googleapis.com/auth/business.manage
   https://www.googleapis.com/auth/spreadsheets
   ```

**Refresh token lifespan:** external apps in OAuth **Testing** can receive refresh tokens that expire after seven days for these scopes. Publishing the consent configuration to Production, and completing any Google verification required for your use case, is necessary for stable unattended use. Tokens can also be revoked by the account owner. Reauthorize if Actions reports `invalid_grant`.

## 2. Host the frontend on GitHub Pages

The repository already contains every static file. No bundling or application server is needed.

### Option A — branch deployment (simple, main / root)

1. Merge the completed files into your repository’s default branch.
2. In **Repository Settings → Pages**, select **Deploy from a branch**.
3. Choose **main** and **`/ (root)`**, then Save.
4. Wait for GitHub’s Pages build. For this repository the URL is:

   ```text
   https://Joshbond123.github.io/ReplyRaven/
   ```

5. Open that URL and click Get started. `.nojekyll` prevents Jekyll processing.

The optional `pages.yml` deployment job is skipped by default, so it does not compete with branch-based Pages deployment.

### Option B — GitHub Actions deployment (only frontend files published)

1. In **Settings → Pages**, select **GitHub Actions** as Source.
2. Set the repository **Actions variable** `PAGES_DEPLOY_MODE` to `actions`.
3. Run **Deploy GitHub Pages** manually once. Future pushes to `main` deploy automatically.

This workflow publishes only the HTML, CSS, frontend JavaScript, shared browser modules, demo data, and assets—not Node scripts, tests, workflows, or `.env` files. Use your own default branch name in this optional workflow if it is not `main`.

For a fork/custom domain, substitute your own URL in the Google setup. The settings page calculates the exact callback URL for the current origin/subpath. Repository help/Actions links target `Joshbond123/ReplyRaven`; update those links if using a fork.

## 3. Create a web OAuth client

1. In **APIs & Services → Credentials**, create an OAuth client of type **Web application**.
2. Add the **origin only** under Authorized JavaScript origins:

   ```text
   https://Joshbond123.github.io
   ```

3. Add the **full, case-sensitive** callback under Authorized redirect URIs:

   ```text
   https://Joshbond123.github.io/ReplyRaven/callback.html
   ```

   In general: `https://USERNAME.github.io/REPO/callback.html`. The Google settings tab displays your actual URI and a Copy button. Register your custom domain instead if you use one.

4. For local development, additionally register `http://localhost:3000` as an origin and `http://localhost:3000/callback.html` as a redirect URI. The address registered in Google must match the address in your browser.
5. For an Arena/live preview, register the actual `https://…e2b.app` preview origin and callback shown in Settings. Do not use localhost in browser-facing production code.
6. Keep the client ID handy. Store the **client secret offline** for the token helper and in GitHub Secrets. The **Connect Google** button does not require a client secret.

## 4. Create your private Google Sheet

Create a spreadsheet in the same manager account, or share it with that account as an **Editor**. Keep general access **Restricted**. Never publish the entire spreadsheet or the `AI_Keys` tab.

You can create a blank Sheet and use **Settings → Google connection → Prepare sheet** after connecting Google. This creates missing tabs and headers without overwriting existing non-matching data. Preparing an existing sheet preserves your reply prompt and automation settings.

For manual creation, make these **five exact tab names**, with these **exact row 1 headers**, in this order. Paste each comma-separated line into A1, then use **Data → Split text to columns → Comma** if Sheets puts it in one cell.

### Businesses

```csv
google_account_id,google_location_id,business_name,address,is_auto_reply,ai_prompt_template,total_reviews,avg_rating,last_sync,status,unreplied_count
```

### Reviews

```csv
google_review_id,google_location_id,business_name,reviewer_name,star_rating,comment,review_date,reply_comment,is_replied,reply_date,is_auto_replied,needs_attention
```

### AI_Keys

```csv
provider,api_key,is_active,request_count,last_used_at,model_name,id
```

### Settings

```csv
key,value
```

### Logs

```csv
timestamp,business_name,action,review_id,status,details,stars
```

Find the Sheet ID in `https://docs.google.com/spreadsheets/d/SHEET_ID/edit`. You may paste the full Sheet URL into the Google connection form; it extracts the ID.

Data conventions:

- Google account/location/review IDs are stored as **strings**, not spreadsheet numbers. This avoids rounding long Google IDs.
- Boolean values are `TRUE` or `FALSE`; active businesses have `status=ACTIVE`.
- Dates are ISO timestamps. Dashboard daily counters/charts use **UTC**, like the workflows.
- Auto-reply starts **off** for newly scanned businesses.
- `needs_attention=TRUE` means an unreplied 1–3 star review.
- The scripts update edited reviews and remote reply status, not just newly added rows. After successfully fetching all review pages, deleted remote reviews and duplicate cached review rows are removed.
- All writes use `valueInputOption=RAW`, deliberately rather than `USER_ENTERED`: reviews cannot inject Sheets formulas, and long IDs are preserved. CSV export also neutralizes formula-looking cells.
- Do not sort, insert, delete, or edit sheet rows while a sync/reply run is writing. Rows are re-resolved before important updates, but Sheets is not a transactional database.

## 5. Connect the live browser workspace

1. Sign in with **`ReplyRaven123`**. If you are in the demo, click **Set up my workspace** first. Demo fixtures are isolated from live configuration.
2. Open **Settings → Google connection**.
3. Enter the web OAuth **client ID** and **Sheet ID**.
4. Click **Connect Google**, choose your manager account, and grant both scopes.
5. Click **Save connection** and **Prepare sheet** (for a new sheet).
6. Click **Test connection**. This tests the Account Management API; it does not pretend that a successful accounts call also validates every location or the Sheet.
7. Go to Overview, click **Scan businesses**, select the new locations, and **Add selected businesses**.
8. Click a business’s sync icon (or View reviews → Sync reviews) to bring in reviews. The background Sync workflow will also do this once configured.

**Browser token expiry:** Google access tokens are short-lived (usually about an hour), independently of the seven-day local workspace session. Reconnect Google when needed. The static app does **not** use an exposed client secret/refresh token to silently refresh browser tokens. Actions uses its private offline credentials separately.

### API key (optional)

If you need it, create an API key in Google Cloud Credentials, restrict it to the Sheets API and your own allowed website referrers, and paste it into Settings.

An API key can only read publicly accessible spreadsheet data; **it cannot authorize private reads or any writes**. OAuth is the recommended/default path. **Do not make your live ReplyRaven Sheet public just to use an API key**, because that would expose customer data and any AI keys in it. The client prefers Bearer OAuth over the API-key fallback.

Non-sensitive connection metadata, prompts, and automation rules are saved to the `Settings` tab. Client secrets, refresh/access tokens, API keys, bridge tokens, and the dashboard password are **not** written to that tab. If you explicitly enter browser secrets, they are saved on this device; browser storage is not a vault.

## 6. Add AI keys and choose your voice

Open **Settings → AI keys**. Select a provider, enter a key, choose an available model, and Add.

| Provider          | Default model              | Implementation                       |
| ----------------- | -------------------------- | ------------------------------------ |
| `openai` or `gpt` | `gpt-4o-mini`              | OpenAI API / official SDK in Actions |
| `gemini`          | `gemini-2.5-flash`         | Gemini API / official SDK in Actions |
| `anthropic`       | `claude-sonnet-4-20250514` | Messages API                         |
| `groq`            | `llama-3.3-70b-versatile`  | OpenAI-compatible Groq endpoint      |

Model availability depends on your provider account and can change. Enter a supported replacement model if a default is unavailable.

- Only active keys participate.
- Round-robin advances for **each attempted request**, with bounded failover on rate limits, provider errors, invalid keys, or connection failures. It never invents a reply when all keys fail.
- Request counts and last-used timestamps update in Sheets.
- Browser rotation uses `localStorage.ai_index`; Actions rotation persists `ai_rotation_index` in Settings.
- Keys in GitHub Secrets are authoritative for Actions. A matching key marked inactive in Sheets cannot be re-enabled by a stale secret. Deleting a key from Sheets does not revoke it or remove it from GitHub Secrets—update both.
- Browser AI requests expose credentials to the trusted browser/device; Anthropic’s explicit direct-browser header is used. Browser CORS policies can block individual providers. Use the optional relay below if needed.

Set your default voice in **Settings → Account**. Use variables `{stars}`, `{comment}`, and `{business_name}`. Each business card’s options menu also has **Customize AI voice** for a per-business override. Customer text is treated as untrusted content, not as instructions.

A generated draft is **not** posted automatically from the reply dialog. You can edit it before clicking **Post to Google**. **Bulk reply 4–5 stars** is an explicit, confirmed generate-and-post operation; lower-star reviews are excluded.

## 7. Obtain the offline refresh token locally

Do this on your own trusted machine—not in chat, a public runner, or a shared device.

```bash
npm ci
cp .env.example .env
```

In the untracked `.env`, set:

```dotenv
GOOGLE_CLIENT_ID=YOUR_WEB_CLIENT_ID
GOOGLE_CLIENT_SECRET=YOUR_CLIENT_SECRET
GOOGLE_REDIRECT_URI=https://Joshbond123.github.io/ReplyRaven/callback.html
```

Generate authorization in either of these ways:

- **Browser:** Settings → Google connection → **Build offline OAuth URL** → Authorize offline access. This stores a random state in the same browser tab and verifies the callback.
- **Local helper:**

  ```bash
  node --env-file=.env scripts/get-token.js --url
  ```

  Open the URL yourself. A URL generated locally cannot be matched to the browser tab’s session state, so the callback warns about its unverified source. This is expected for the local helper; exchange only a code from the flow **you** initiated.

On `callback.html`, copy the one-time code. Then run:

```bash
node --env-file=.env scripts/get-token.js
```

Paste the code at the interactive prompt. Alternatively (beware shell history):

```bash
node --env-file=.env scripts/get-token.js 'YOUR_ONE_TIME_CODE'
```

The helper posts to `https://oauth2.googleapis.com/token` and prints the access token, refresh token, and scopes. Copy the **refresh token** into GitHub Secrets. You can use the access token temporarily in the browser, but the Connect Google button is easier for future sessions.

Codes expire quickly and can be used only once. The redirect URI must **exactly match** the URI used when authorizing. If no refresh token is returned, reauthorize with `access_type=offline` and `prompt=consent`; if necessary revoke the previous application grant in your Google account before authorizing again.

### Advanced browser exchange

If you deliberately saved the client secret on this device, a state-verified callback offers a browser exchange button. It does not exchange automatically. Unverified callbacks disable it. CORS or Google policies can block browser exchange; the local helper is the reliable recommended path. Never expose your client secret as a committed frontend configuration.

## 8. Configure GitHub Actions

In **Repository Settings → Secrets and variables → Actions → New repository secret**, create:

| Secret                 | Value                                        |
| ---------------------- | -------------------------------------------- |
| `GOOGLE_SHEET_ID`      | The private spreadsheet ID                   |
| `GOOGLE_CLIENT_ID`     | Web OAuth client ID                          |
| `GOOGLE_CLIENT_SECRET` | Its client secret (from your offline `.env`) |
| `GOOGLE_REFRESH_TOKEN` | Token from the local helper                  |
| `AI_KEYS_JSON`         | JSON array of active provider keys           |

**Settings → GitHub secrets** provides copy buttons and an explicit reveal/copy export for active keys. You do not need to paste your offline secret or refresh token into the browser; copy them directly into GitHub.

Example JSON shape (replace placeholders privately):

```json
[
  {
    "id": "a-stable-id-matching-the-AI_Keys-row",
    "provider": "openai",
    "api_key": "YOUR_PRIVATE_PROVIDER_KEY",
    "model_name": "gpt-4o-mini",
    "is_active": "TRUE"
  },
  {
    "id": "another-stable-id",
    "provider": "gemini",
    "api_key": "YOUR_PRIVATE_PROVIDER_KEY",
    "model_name": "gemini-2.5-flash",
    "is_active": "TRUE"
  }
]
```

- `key` / `model` aliases are accepted by the local scripts, but the UI exports canonical names.
- Keep IDs unique and stable for accounting. IDs omitted from manually written JSON become `secret-1`, `secret-2`, etc.
- Secret-only keys get metadata-only `AI_Keys` rows; the runner does not copy the secret’s plaintext key into Sheets.
- Secret-only metadata rows cannot produce a usable secret export without their keys; keep your original JSON offline, or use the relay for browser AI.

Then:

1. Enable Actions in the repository (forks can have schedules disabled initially).
2. On the **default branch**, run **Actions → Sync → Run workflow**.
3. Verify review rows and business metrics in your Sheet and the workflow summary.
4. Add an active AI key/secret and toggle auto-reply **on for one test business**.
5. Confirm the master switch in **Settings → Automation** is on. Run **Auto-Reply** manually.
6. Verify a real 4–5 star reply on Google and the `AUTO_REPLY` log. Then enable other businesses as appropriate.

The cron schedules are:

```yaml
# sync.yml
cron: '*/15 * * * *'
# reply.yml
cron: '*/30 * * * *'
```

Actions receives `SHEET_ID`, `CLIENT_ID`, `CLIENT_SECRET`, and `REFRESH_TOKEN` mapped from those secrets. The scripts also accept the `GOOGLE_…` names for local use.

**Operational guardrails**

- Both workflows use concurrency group `replyraven-sheet-writer`, with no cancellation of a running job. They serialize scheduled sheet writes. A queued run can still be delayed/replaced by GitHub; cron is best-effort, not a real-time scheduler.
- Sync prioritizes never-synced and least-recently-synced businesses, so a large partial run does not starve later locations. Google Sheets has a finite cell/storage limit and Actions has a finite job duration; “unlimited businesses” means no ReplyRaven per-location cap, not unbounded infrastructure.
- Schedules run only from the repository default branch. GitHub can disable public-repository schedules after prolonged inactivity; check Actions periodically.
- The queue processes oldest reviews first. By default, each run posts at most **100** replies, configurable from **1–1,000** in Automation. No application limit is placed on the number of businesses.
- At least **2 seconds** between replies (configurable up to 30). Additional Sheets read/write pacing keeps each quota stream below 60 calls/minute, so large runs take longer. Provider and Google limits still apply.
- Opt-in active businesses only; 1–3 star reviews never auto-reply, even if the rating changed after sync.
- Before generation and again immediately before PUT, Google is checked for an existing reply. Existing replies are reconciled into Sheets and skipped. The API does not offer a conditional/transactional reply PUT; a tiny race with another manager’s simultaneous post cannot be eliminated on this architecture. Avoid manual/automated writes at the same time.
- If a Google PUT succeeds but a sheet update fails, a later run checks the remote reply and reconciles it instead of posting again. Workflows log per-review errors and fail visibly, rather than claiming success.
- Changing automation cadence requires editing the workflow YAML; saving the UI guardrails does not rewrite workflow files.
- Master automation can be paused without affecting review sync. All newly discovered businesses start opted out.

## Optional: Apps Script AI-only relay

This solves browser CORS restrictions and can keep provider credentials out of the browser’s key table. It does not provide multi-tenant authentication, and its bridge token must be treated like an API key.

1. Create a Google Apps Script project, and paste `scripts/apps-script.gs` into its editor.
2. Set **Project Settings → Script Properties**:
   - `BRIDGE_TOKEN`: a random secret of at least 32 characters. Generate locally, e.g. `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
   - `GOOGLE_SHEET_ID`: your private sheet ID.
   - Optional `AI_KEYS_JSON`: private provider keys with IDs matching the `AI_Keys` metadata rows. If omitted, the bridge reads actual keys from the private `AI_Keys` tab.
3. Deploy as a **Web app**, **Execute as: Me**, **Who has access: Anyone**. Approve the script’s own Spreadsheet/UrlFetch permissions. Requests without the bridge token are rejected; only the AI generation action is supported.
4. Paste the deployed `https://script.google.com/macros/s/…/exec` URL and bridge token into **Google connection → Advanced settings**, then Save connection.
5. If you keep keys in Script Properties, leave `api_key` blank in the matching Sheet rows. Keep `id`, `provider`, `model_name`, and `is_active=TRUE`. Browser rotation can use these metadata-only rows with the relay.

The browser sends a simple POST containing the key ID and prompt—not the provider secret. The bridge only calls hard-coded supported provider hosts; it cannot proxy arbitrary URLs, write arbitrary sheets, or exchange Google tokens. Apps Script quotas and deployment/CORS policies still apply. To update the script, redeploy its web app version.

## Daily use

- **Overview**: live Sheet-derived stats, recent review activity, search/filter/sort, sync icons, auto-reply toggles, CSV export, and recent logs.
- **Scan**: only locations not already tracked are offered. Accessible account failures are shown without hiding results from successful accounts.
- **View reviews**: per-business inbox. Sidebar Review inbox aggregates all tracked businesses.
- **Generate AI reply**: opens an editable draft. Post, edit, and delete act on the **owner reply**, never the customer’s review.
- **Bulk reply**: confirmed 4–5 star operation, irrespective of whether background auto-reply is enabled. Existing remote replies and ratings are rechecked.
- **WhatsApp**: click the send icon to open a prefilled share link. Optional recipient in Account settings. It never sends a message silently or integrates a WhatsApp bot.
- **Remove business**: removes tracking and cached reviews from Sheets, not the Google Business Profile or manager permissions. Historical Logs stay.
- **Themes**: header toggle or Account preference. Saved on this device.

## Test and maintain

```bash
npm test              # unit, API-contract, key rotation, sync and reply safety
npm run test:e2e      # offline-capable Chromium desktop/mobile flows + mocked Sheets
npm audit
```

The browser tests use an npm-distributed Chromium plus local Inter/Lucide assets. No live credentials are needed, and external calls are blocked/mocked. A Chrome executable can be supplied with `PLAYWRIGHT_CHROMIUM_EXECUTABLE=/path/to/chrome`. The included fallback is intended for Linux; on macOS/Windows supply your installed Chrome path. CI runs both suites on Ubuntu/Node 20.

Run automation locally only with your own untracked `.env`:

```bash
node --env-file=.env scripts/sync-reviews.js
node --env-file=.env scripts/auto-reply.js
```

These are **live** operations, not simulations. The scripts will post real replies if automation is enabled, a business is opted in, and eligible reviews exist.

## Troubleshooting

| Symptom                                | What to check                                                                                                                                                     |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local login fails                      | Initial password is `ReplyRaven123`, case-sensitive. It is per-browser. Enable local storage. Forgot password shows the default hint.                             |
| Changed password forgotten             | On your own device, remove only `dashboard_password`, `auth`, and `auth_expiry` from this site’s localStorage; reload login. No Google account reset is involved. |
| OAuth `redirect_uri_mismatch`          | Exact origin, protocol, repository case, subpath, callback filename, and the URI used by `get-token.js`.                                                          |
| Popup/origin error                     | Register the current origin on a Web OAuth client, allow popups, and use a supported browser.                                                                     |
| Google 401                             | Browser token expired: reconnect. Actions: regenerate/revoke-and-reauthorize the offline token if needed.                                                         |
| Google 403 / no Business API quota     | Project approval, enabled APIs, scopes, consent test user, correct manager account, and verified locations.                                                       |
| Sheet read/write 403                   | The manager account needs access to the Sheet and spreadsheet scope. An API key is not write authorization.                                                       |
| Header/schema error                    | Verify all five exact tab names and header order. Prepare sheet refuses to overwrite mismatched non-empty headers.                                                |
| No businesses found                    | Account must manage locations; all already-tracked locations are excluded. Review any partial-scan account errors.                                                |
| Provider fails / 429                   | Check key permissions, quota, supported model, active switch, and CORS. Try the optional relay or a different provider/key.                                       |
| Actions sees no keys                   | `AI_KEYS_JSON` must be a JSON array of active keys, not a quoted JSON string. Update it after key changes.                                                        |
| Actions does not run on time           | Cron is best-effort, default-branch-only, serialized, and can be disabled on inactive/forked repositories. Run manually and inspect job logs.                     |
| Reply on Google but not in Sheets      | Sync the business. Do not manually repost: the runner checks the remote reply on the next run.                                                                    |
| Demo data appears instead of live data | Use “Set up my workspace.” Demo has its own browser-local sample store.                                                                                           |

## Files

```text
index.html             public landing page
login.html             local seven-day password gate
dashboard.html         overview and business management
business.html          per-location / unified review inbox
settings.html          Google, AI, automation, secrets, account
callback.html          one-time OAuth code callback
app.js / auth.js       browser controllers and synchronous route guards
styles.css / assets/   design system, brand art, font/icon fallbacks
lib/                   shared schema, REST APIs, AI rotation, safe operations
data/demo.js           explicitly sample-only interactive fixtures
scripts/sync-reviews.js
scripts/auto-reply.js
scripts/get-token.js
scripts/apps-script.gs optional AI relay
scripts/lib/           OAuth, SDK providers, Actions orchestration, test browser
.github/workflows/     sync, reply, checks, optional Pages deployment
package.json / package-lock.json
tests/ / playwright.config.js
```

The landing dashboard/review preview and perspective quotes are explicitly illustrative, not verified customer testimonials or live service metrics. Inter and Lucide licenses are included with the local assets.
