# ReplyRaven

**AI that auto-replies to Google reviews in your brand voice.**

ReplyRaven’s static frontend is built for GitHub Pages. Its API, background jobs, credential vault, and five-minute scheduler run on Cloudflare Workers. Production application data lives in Cloudflare D1; Cloudflare Queues transports durable work. There is no browser-local business database.

## Product

- Server-verified owner authentication and seven-day signed sessions.
- Paginated discovery of accessible Google Business Profile accounts and locations.
- Business-specific brand learning from the authorized profile, public website, and up to twenty recent reviews.
- Editable learned voice, encrypted AI keys, automatic model discovery, round-robin rotation, and key health.
- New, unreplied **4–5 star** reviews only for automation. Previous reviews are opt-in.
- Optional seven-day trials and monthly, yearly, or custom subscriptions per business.
- Automatic billing pauses, recorded payments, and calculated renewal dates.
- Email, browser push, and durable in-app notifications with event-level preferences.
- Queue retries, deduplication, write leases, delivery records, and a retained failure backlog.
- Responsive desktop/mobile layouts, light/dark modes, local Inter/Lucide assets, and motion enhancements.

## Architecture

```text
GitHub Pages frontend → HTTPS Worker API → D1
                                  ↓
                         durable job outbox
                                  ↓
                        Cloudflare Queues
                                  ↓
                    brand learning / sync / replies
                                  ↓
                 Google, selected AI provider, notifications

Worker Cron Trigger → due-work scheduler, every five minutes
```

The frontend never contains Google secrets, AI keys, Cloudflare deployment credentials, or a default public owner password. `CLOUDFLARE_WORKER_URL` is a **public** build-time endpoint, injected into `runtime-config.js`.

## Before deployment

You need:

1. A Cloudflare account and an API token authorized to manage Workers, D1, and Queues. Deployment does not upgrade your paid plan automatically.
2. A Google Cloud project approved for Business Profile API access, with the Account Management and Business Information APIs enabled and review access available.
3. An OAuth web client and `business.manage` offline authorization for the Google account managing your locations.
4. A strong owner password, at least twelve characters.
5. A verified email sender with Resend, or a Cloudflare Email binding and verified destination.
6. Repository access to publish the website and enable Pages.

Keep private values in the hosting secret stores or a private, untracked environment file. Never commit a credential document, populated environment file, or private key.

## Private deployment configuration

Copy `.env.template` to an untracked `.env` and populate it locally. Node 22.13 or newer is required.

| Name                        | Purpose                                               |
| --------------------------- | ----------------------------------------------------- |
| `CLOUDFLARE_ACCOUNT_ID`     | Deployment account                                    |
| `CLOUDFLARE_API_TOKEN`      | Deployment only; never a Worker runtime secret        |
| `CLOUDFLARE_D1_DATABASE_ID` | Existing database; omit for first-time provisioning   |
| `ADMIN_PASSWORD`            | Hashed before being stored in the Worker secret store |
| `SESSION_SECRET`            | Stable session-signing secret, at least 32 characters |
| `VAULT_SECRET`              | Stable encryption secret, at least 32 characters      |
| `GOOGLE_CLIENT_ID`          | Runtime Google client ID                              |
| `GOOGLE_CLIENT_SECRET`      | Runtime Google client secret                          |
| `GOOGLE_REFRESH_TOKEN`      | Runtime offline refresh token                         |
| `GOOGLE_CONNECTED_AT`       | Token issue/connection timestamp, preferably ISO UTC  |
| `RESEND_API_KEY`            | Runtime email provider credential                     |
| `EMAIL_FROM`                | Verified notification sender                          |
| `ADMIN_EMAIL`               | Initial notification destination and push contact     |
| `PUBLIC_SITE_URL`           | Actual public website URL                             |
| `CORS_ORIGINS`              | Comma-separated allowed frontend origins              |
| `CLOUDFLARE_WORKER_URL`     | Deployed API endpoint used by the frontend build      |

Optional `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, and `GROQ_API_KEY` are stored as Worker secrets. AI settings can fetch their available models without returning the keys to the browser. Keys pasted through the application are encrypted in D1 instead.

On an initial deployment, the deployment helper generates missing session/vault secrets and VAPID signing keys. On subsequent deployments, omitted values are left unchanged. **Do not rotate `VAULT_SECRET` without migrating the encrypted records.** The vault encryption context binds each ciphertext to its record.

A private credentials file can also be imported with `--credentials-file /private/path`. Recognized labels are parsed as data, never executed. A supplied GitHub token is used only for explicit repository deployment operations; it is excluded from the Worker’s runtime-secret whitelist.

## Deploy the Cloudflare backend

```bash
npm ci
node --env-file=.env scripts/deploy-cloudflare.js
```

The helper:

1. Checks account credentials and the owner password requirement.
2. Creates or locates D1, the work queue, and its dead-letter queue.
3. Applies `backend/migrations/0001.sql` with Wrangler.
4. Deploys the API and Cron Trigger.
5. Uploads runtime secrets privately.
6. Confirms database, queue, and authentication readiness at `/health`.

It writes public release metadata to the ignored `.cache/cloudflare-release.json`. No credential is included in a frontend artifact. Deployments stop rather than claim success if readiness fails.

To store the Cloudflare account ID, API token, and D1 ID in repository secrets during deployment, use `--save-repository-secrets`. The GitHub connection must have repository secret-management permission. An inaccessible secret store is reported as a partial deployment, not silently ignored.

For Cloudflare Email instead of Resend, configure email routing and a verified destination first, set `CLOUDFLARE_EMAIL=true`, and use a plain verified sender in `EMAIL_FROM`. A sender label is supported by Resend. Delivery cannot be guaranteed by an unconfigured or unavailable provider.

## Build and publish the website

```bash
CLOUDFLARE_WORKER_URL=https://YOUR_DEPLOYED_WORKER_HOST npm run build
```

The deployable static output is **`dist/`**. Only frontend files and public assets are collected. The build scans for retired content and does not copy backend code or environment files.

The deployment-only workflow `.github/workflows/deploy.yml` deploys the Worker and then uses `peaceiris/actions-gh-pages` to publish `dist/` to **`gh-pages`**. It runs on default-branch updates, session-branch updates, or manual dispatch, only when private deployment settings are present. Session-branch publication stays on the same branch. It is not an application scheduler.

Configure repository secrets with the private deployment names above, including the owner password. Configure `PUBLIC_SITE_URL`, `EMAIL_FROM`, and optionally `CLOUDFLARE_WORKER_URL` as repository variables. Then:

1. Merge the application into the default branch.
2. Run **Publish ReplyRaven**.
3. In **Settings → Pages**, select **Deploy from a branch → gh-pages → /(root)**.
4. Wait for the Pages publication to succeed.
5. Open the public URL and run the live verification command below.

### Session-branch publication

This development session is fixed to `arena/01a0f95f-replyraven`. To publish without writing another branch:

```bash
node --env-file=.env scripts/publish-branch.js
```

This first requires a healthy, deployed Worker, builds `dist/`, and mirrors the static output into `docs/`. Commit and push **the session branch only**, then select **arena/01a0f95f-replyraven → /docs** in Pages settings. When the release workflow runs from the session branch, its static artifacts are committed to that branch’s `docs/` folder without creating another branch. The default-branch `gh-pages` publisher is supplied for later use and must not be run to bypass the session branch restriction.

The hosting connection needs Pages administration permission to enable a site automatically. If it returns 403, a repository owner must configure the source directly. Code being pushed does not mean a website is live.

### Custom domain

Set `PUBLIC_SITE_URL` to your HTTPS domain before building. The builder creates the public `CNAME` file. Configure the domain’s DNS records for GitHub Pages and enable HTTPS there. Include that exact origin in the Worker’s `CORS_ORIGINS`. API traffic continues to the Worker URL; no private secret is put in DNS or browser JavaScript.

## Connect Google

The Google page contains only **Client ID**, **Client Secret**, and **Refresh Token**.

1. Select **Reconnect now** to open official OAuth Playground.
2. Open its gear menu and enable **Use your own OAuth credentials**.
3. Enter your Google client ID and secret in Playground. Register `https://developers.google.com/oauthplayground` as an authorized redirect URI on your web client.
4. Authorize `https://www.googleapis.com/auth/business.manage` and exchange the authorization code.
5. Save the new refresh token in ReplyRaven. The backend validates it before saving encrypted credentials.

A single click securely opens Playground; cross-origin browser rules prevent ReplyRaven from privately filling its secret fields. Client secrets and refresh tokens are never placed in reconnect URLs, localStorage, or sessionStorage.

For restricted OAuth consent applications, the renewal schedule uses a seven-day lifetime from the recorded issue/save timestamp. A day-six event warns: **“Your Google connection expires in 24 hours - Reconnect now.”** Published applications may have different token lifetimes. Revocation or `invalid_grant` is detected independently and pauses Google work. Google can invalidate a token earlier, so a calendar estimate is not proof of validity.

## Business onboarding and brand voice

Select **Add business**, choose accessible locations, and configure each business separately.

- Learning reads authorized Google profile data, website content when publicly available, and up to twenty recent reviews.
- Unsupported or unavailable websites are recorded as unavailable; content is not fabricated.
- The profile includes a summary, tone, language, audience, known facts, phrases to avoid, sign-off, and reply style.
- **View what AI learned** opens the profile and its source status. You can edit it or request relearning.
- Auto-reply is opt-in. New businesses do not automatically reply to historical reviews.
- To handle historical reviews, explicitly select a number or use **Reply to previous reviews**. The per-request safety limit is 1,000; repeated requests can handle larger queues.

Google review APIs require verified locations and appropriate manager permissions. Discovery can show accessible locations whose review endpoint is not yet available; failures are shown in the operation log.

## Automation and reply safety

The Cloudflare trigger ticks every five minutes. The owner-selected interval—15, 30, 60, 120, or 360 minutes—controls when each business is due for review synchronization. Small page-sized jobs keep work bounded; large account sets progress through queues instead of an application business cap.

Reply targets receive a random **5–30 minute** delay from detection. Queue/provider load can postpone execution; the delay is a target, not a delivery SLA.

Every automatic post requires:

- Master automation enabled and business opt-in.
- A ready, editable brand voice.
- Valid trial/subscription state if billing is enabled.
- An unreplied 4–5 star review, re-read from Google before generation.
- Another Google read before PUT, fresh billing/automation checks, and an internal write lease.

Owner replies already present are reconciled and skipped. Low-star edits and customer edits during generation prevent the stale draft from being sent. Google PUTs are never blindly replayed. Ambiguous results are marked **uncertain**, and synchronization/explicit inspection must reconcile them before another operation.

Google does not expose a conditional reply PUT. The final remote checks and internal serialization prevent intentional overwrites and concurrent ReplyRaven writers, but no client can atomically exclude another manager posting in the milliseconds between Google’s GET and PUT. Avoid simultaneous external-manager writes when automation is active.

## Per-business billing

Billing is optional. Enable a trial and/or subscription only for businesses that need the guardrails.

- Trial: seven days from onboarding when enabled.
- Subscription: monthly, yearly, or custom day interval with amount, currency, method, and next due date.
- Trial/subscription expiry blocks automatic replies immediately at the posting guard, even before the scheduler has updated the visible payment status.
- Trial reminders: two days, one day, and expiry.
- Monthly/yearly reminders: three days, one day, and due day.
- **Mark as Paid** records receipt, calculates the next period, and clears the billing pause. It does not force master automation or business opt-in on.
- Expired/cancelled statuses cannot be reset to active with the ordinary settings form.

Cash, transfer, Stripe, and PayPal are receipt labels. ReplyRaven does not silently charge a card, create a checkout session, or fabricate a successful payment.

## Notifications and reliability

Notifications have a global switch, three channel choices, and six event switches. The in-app inbox is stored durably in D1. Email and push use queue consumers and channel-specific delivery records.

The source of truth is the D1 outbox, not an ephemeral queue message. Deduplication avoids repeated reminders. Failed channels retain their error state, retry with backoff, and remain visible; exhausted external queue retries do not erase the durable job. Notification failures are periodically reopened for further delivery attempts. The inbox and delivery log distinguish **queued**, **delayed**, and **accepted by provider**.

Enable browser permission on the published HTTPS site. Browser permission, push-service retention, network availability, verified senders, and provider outages all affect delivery. **Zero-failure delivery cannot be promised.** A durable record and visible retries are the guarantee this application can enforce; provider acceptance is not proof the recipient read the message.

## Verification

```bash
npm run verify
npm run verify:browser
npm run verify:bundle
npm run format:check
npm audit
CLOUDFLARE_WORKER_URL=/api npm run build
```

The isolated verification suite runs the real API handlers, encryption, SQL migrations, job transitions, billing gates, and provider adapters with outbound responses controlled. It does not post to Google or send mail.

Local development uses SQLite’s D1-compatible interface only in the development tool; the deployed Worker binds Cloudflare D1. No businesses are seeded into the development UI.

```bash
npm run dev:api
npm run dev
```

The browser uses relative `/api` requests; the static development server proxies them to the local API. Private local owner access is generated in ignored `.cache/local/owner-access.json`. The backend and static server bind `0.0.0.0` for preview access.

### Live release checks

```bash
PUBLIC_SITE_URL=https://YOUR_PUBLIC_SITE/ npm run verify:live
```

With `ADMIN_PASSWORD` privately supplied, the script also verifies authenticated routes on the published site. It checks the actual Pages response, backend URL, CORS, D1/queue/authentication readiness, current headline, mobile overflow, and browser exceptions.

A full live integration sign-off additionally requires an authorized business, working Google approval/credentials, a real selected AI model, a verified notification sender, and deliberate approval to post an eligible owner reply. Do not create a false customer review to exercise the flow. Record observed results separately from isolated checks. No deployment or provider success is claimed solely because code builds.

## Source map

```text
index.html / login.html                 public product and sign-in
 dashboard.html / business.html        business and review workspace
 settings.html / notifications.html    connection, AI, automation, billing alerts
 app.js / auth.js                       frontend controller and route gate
 runtime-config.js / service-worker.js  public endpoint and browser push
 backend/index.js                      authenticated Worker API and handlers
 backend/lib/                          vault, providers, jobs, notifications
 backend/migrations/0001.sql            D1 schema
 wrangler.jsonc                        Worker and cron defaults
 scripts/                              build, provision, publish, verification
 checks/                               isolated verification
 .github/workflows/                    verification and release publishing only
```
