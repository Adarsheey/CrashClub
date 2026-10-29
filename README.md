# Crash Club

A clean-slate food-event intel and friendship app. The interface may joke about snacks; access controls must not.

## Phase 1 foundation

- React + Vite frontend and Express + TypeScript API
- PostgreSQL with Prisma ORM 7 and the `pg` driver adapter
- A health endpoint that checks the API and database
- The initial relational schema and migration
- API health tests, production builds, and a database smoke test

## Phase 3: Complete Social Platform

The authenticated app now includes an intel feed, friendships, direct messages, events, invitations, a post-count leaderboard, notifications, reporting, and a basic moderation desk. To publish an event, use the single **Share event intel** form in Intel. One submission creates the event, its linked intel record, and any selected invitations. Events appear in the Events section rather than as duplicate cards in the Intel feed. Event access and feed-post audience have separate controls to preserve their independent privacy rules. The Events page is for search and RSVP.

Phase 3 adds forward-only migrations for post categories, recorded revocation of friends-only post access, and linking event intel posts to events. They do not reset the database or alter account/session tables.

Start the app with `npm run dev`, then open the Vite URL shown in the terminal. Sign in with an existing account or register a new one. The dashboard contains Intel, Friends, Events, Messages, Hall of Hunger, Notifications, My profile, and (for moderator/admin accounts) Moderation.

### Social privacy rules

- Friends-only posts save the selected accepted-friend IDs when published. New friends are not added later. Unfriending or blocking marks that person's grant revoked; becoming friends again does not restore it.
- Public posts remain visible in the community, including to blocked members. Blocking hides member profiles where practical and disables friend requests, invitations, and new messages.
- Invite-only events are visible only to their creator and invitees. Public events are searchable. Event and post visibility are separate.
- Conversation history stays available to its two participants after unfriending/blocking. Sending new messages requires an active friendship and no block.
- The Hall of Hunger counts published posts regardless of audience. Drafts and soft-deleted posts do not count; edits do not add another point.

### API map

All `/api/social` routes require a valid session cookie. Friend actions use `/friends`, `/friend-requests`, and `/blocks`; posts use `/posts` and `/leaderboard`; events use `/events`; direct messages use `/conversations`; notifications use `/notifications`; reports and staff tools use `/reports` and `/moderation`. See `backend/src/social.ts` for request fields and responses. Public member cards remain available at `GET /api/users/:username` unless the viewer and member have blocked one another.

Socket.IO uses the same HTTP server and requires the signed-in session cookie. The Vite development proxy forwards both `/api` and `/socket.io` to the API. A production reverse proxy must forward WebSocket upgrades for `/socket.io` to the API service as well as `/api` requests. The browser receives notification events and refreshes the corresponding private data through its authenticated API calls; message bodies are not broadcast to unrelated users.

### Phase 3 database changes

The migration `20261029100000_social_access_fields` adds `Post.category` (default `GENERAL`) and `PostRecipient.revokedAt`. The migration `20261029103000_event_intel_posts` adds `Post.eventId` so a feed item stays connected to its event. Both have been applied with `npm run db:deploy`; this command only applies pending migrations. To check schema changes locally, run `npm run db:generate` after editing Prisma. Never use `prisma migrate reset` against the development database.

### Tests

`npm test` runs API health checks plus database-backed authentication and social-platform integration tests. The social integration test creates uniquely named temporary members, sessions, posts, friendships, conversations, events, and reports, then deletes only those test members (their dependent test data cascades). It checks private audience isolation and revocation, unchanged post counts on edits, draft/deleted leaderboard behavior, historical message access, blocked contact prevention, public post/event visibility, invite-only event privacy, RSVP, notifications, and report authorization. Use a development database, never production data.

## Prerequisites

- Node.js 24 LTS (or another supported even-numbered LTS release)
- npm
- A Neon account and a PostgreSQL project for development

## Create and configure a Neon development database

1. Sign in or create an account at [Neon Console](https://console.neon.tech/).
2. Create a project named `crash-club-dev`. Choose a region close to you and keep the default primary branch, database, and role for development.
3. In the project, select **Connect**. Choose the primary branch, compute, database, and role.
4. Keep **Connection pooling** on (Neon's default) and copy the pooled connection string. This is appropriate for the web app, and Neon supports Prisma migrations through its pooler. The `pg` driver supports Neon’s standard PostgreSQL connection protocol.
5. Copy the full connection string. It contains a database password; do not paste it into chat, source files, screenshots, or issue reports.
6. In the project root, copy `.env.example` to `.env` only if `.env` does not already exist. If it exists, edit only its `DATABASE_URL` value. Paste the copied string there on one line and keep it inside quotes. Set `sslmode=verify-full`; preserve `channel_binding=require` if Neon supplied it. Neon recommends `verify-full` for hostname and certificate verification ([connection security](https://neon.com/docs/connect/connect-securely)).

Neon provides both direct and pooled connection strings in the **Connect** dialog. The pooled URL includes `-pooler` in its hostname. This project has successfully applied its initial Prisma migration and run the database smoke test using the pooled URL. Use the copied URL as `DATABASE_URL`.

The root `.gitignore` excludes `.env` and other `.env.*` files while allowing `.env.example`. Never commit `.env`. If a real database URL is accidentally committed, rotate its database password in Neon.

## Apply the existing migration and verify the database

From the project root, run:

```powershell
npm install
npm run db:generate
npm run db:deploy
npm run db:smoke
```

`db:deploy` runs Prisma's deployment migration command. It applies pending migration files and does not reset the database. Do not use `prisma migrate reset` for this setup.

The smoke test confirms the connection, confirms the initial `User` table exists, and creates/inserts/reads a row in a temporary table inside a transaction. PostgreSQL drops that temporary table at commit; the test does not leave sample rows in the project database.

`db:generate` also runs a small compatibility script for Prisma's generated PostgreSQL runtime imports. It only adjusts generated imports when the ESM runtime files are absent and matching `.js` modules are available; it does not change the schema or database.

After both commands pass, start the app with `npm run dev` and open the Vite URL shown in the terminal (normally `http://localhost:5173`). The API health endpoint is `http://localhost:3000/api/health`.

## Phase 2: accounts and profiles

The account foundation uses the existing `User`, `Session`, and `EmailActionToken` database tables. Phase 2 did not change the Prisma schema, so it adds no migration; `npm run db:deploy` safely confirms/applies any already-recorded pending migrations and never resets data.

For local development, an actual inbox or verification link is not required: use a valid-looking email address, create the account, and sign in. Local development automatically verifies new accounts to keep the test flow simple. To manually test email verification, set `DEV_AUTO_VERIFY_EMAIL=false`; the link will then be printed in the API terminal. Production always requires verification and sends links through the configured email provider, so users need an address they can access.

Add these non-secret values to the root `.env` (or leave the matching defaults in code):

```dotenv
APP_ORIGIN=http://localhost:5173
NODE_ENV=development
```

Registration and password-reset links are printed only in the API developer terminal in development. Open the complete link there in your browser. The API response contains a generic status message and never contains the token. In production, configure `APP_ORIGIN`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, and `EMAIL_FROM` in the hosting provider's secret manager; production startup fails if required email settings are missing. Production tokens are delivered by email and are never logged.

Passwords must be 8–128 characters and are stored as Argon2id hashes. There are no symbol or character-mix rules. Sessions use a random HttpOnly, SameSite=Lax cookie; only the SHA-256 digest is stored in PostgreSQL. Cookies are marked Secure in production. Verification links expire after 24 hours; password-reset links expire after 30 minutes and are single-use. Password reset revokes all active sessions. Profile responses omit email addresses, password hashes, session identifiers, and action-token hashes. If an existing block relationship is present, the two accounts cannot view each other's public profile.

The `npm test` command runs API checks and a database-backed account lifecycle test against the configured development database. The integration test creates uniquely named temporary accounts and removes only those accounts afterward. It covers duplicate registration, invalid credentials, verification success/invalid/expired/reused links, session-required profile access, profile updates and public profile privacy, blocked-profile hiding, reset success/invalid/expired links, session revocation, logout, and authentication rate limiting. Do not point it at production data.

During local development, each auth route allows up to 100 attempts per IP per 15 minutes so testing one flow does not lock out another. Production uses separate limits for registration, sign-in, email actions, and password resets; `AUTH_RATE_LIMIT` can override those production per-IP limits. Production deployments behind a reverse proxy should configure Express `trust proxy` to match the hosting provider so rate limits see the real client IP.

Account endpoints:

- `POST /api/auth/register`, `/api/auth/verify-email`, `/api/auth/resend-verification`
- `POST /api/auth/login`, `/api/auth/logout`; `GET /api/auth/me`; `PATCH /api/auth/me`
- `POST /api/auth/password-reset/request`, `/api/auth/password-reset/confirm`
- `GET /api/users/:username` for a public profile

## Other commands

- `npm test`: run API health, authentication, and social-platform integration tests.
- `npm run build`: build the backend and frontend.
- `npm run db:deploy`: apply pending migrations without resetting data.
- `npm run db:smoke`: run the live PostgreSQL connection and basic-operation check.
- `npm run db:up` / `npm run db:down`: optional local Docker PostgreSQL commands.

For a future schema change, create a reviewed migration in development with `npm --workspace backend run db:migrate -- --name describe-change`, then deploy committed migrations with `npm run db:deploy`.

## Secrets and deployment

Keep connection strings and all real credentials in local environment files or the deployment platform's secret manager. `.env.example` contains placeholders only. Production database URLs must be configured as deployment secrets; never bake them into frontend assets or commit them to Git.

Production deployment and live email-provider delivery still require your hosting account and secret configuration. Configure `DATABASE_URL`, `APP_ORIGIN`, `NODE_ENV=production`, the `SMTP_*` values, `EMAIL_FROM`, `AUTH_RATE_LIMIT`, `SOCIAL_RATE_LIMIT`, and `TRUST_PROXY_HOPS` in the hosting platform's secret manager. Do not put server secrets in `VITE_*` variables or frontend code. Uploaded avatar files need durable storage in production; see the Render setup below.

### Deploy the app on Render

The repository includes a Render Blueprint in `render.yaml` for a single Node web service. The Express server serves the built React app and handles `/api`, avatar files, and Socket.IO from the same origin. This keeps session cookies and real-time connections on one host, without a separate frontend proxy. Render's Node web services must bind to the `PORT` environment variable on `0.0.0.0`; this project does both. See Render's [Node/Express deployment guide](https://render.com/docs/deploy-node-express-app) and [Blueprint reference](https://render.com/docs/blueprint-spec).

1. Push this repository to GitHub. Confirm `.env` is not tracked (`.gitignore` excludes it); only `.env.example` belongs in Git.
2. In Render, choose **New → Blueprint**, connect the repository, and apply the configuration from `render.yaml`.
3. Add the prompted `DATABASE_URL` from Neon and SMTP credentials in the Render service's environment settings. Use the Neon pooled PostgreSQL URL and never commit or share it. The Blueprint sets production mode, rate limits, the Render proxy hop, and SMTP port/security defaults.
4. Render builds with `npm ci && npm run db:generate && npm run build`. Its start command is `npm start`, which applies pending Prisma migrations with `prisma migrate deploy` (no reset) before starting the server. The `/api/health` check confirms database connectivity.
5. On the standard Render domain, the server uses Render's `RENDER_EXTERNAL_URL` for verification and password-reset links. If you attach a custom domain, set `APP_ORIGIN` to that exact `https://` origin in the service environment.
6. After deployment, open the service URL and check `/api/health`, registration/email verification, login/logout, profile image upload, and messaging. Verify SMTP delivery before inviting real users.

**Uploaded profile photos need persistent storage.** The included free-tier Blueprint does not attach a disk, so avatars saved there can disappear on redeploy/restart. Before public use, attach a persistent disk through Render if your chosen service plan supports it, mount it at `/var/data`, and set `AVATAR_UPLOAD_DIR=/var/data/avatars`; otherwise use a durable object-storage service in a later change. Confirm the disk's cost and limits in your Render dashboard before enabling it.

The Blueprint uses a single app instance and runs migrations on startup, which keeps the beginner setup simple. For scaled production deployments, move migrations to a dedicated pre-deploy step and use shared/durable storage for uploads and rate-limit state. Render's [deployment guide](https://render.com/docs/deploys) describes its migration/pre-deploy behavior; pre-deploy commands require a paid web service.

### Profile pictures

Members can upload JPEG, PNG, or WebP profile pictures up to 1.5 MB from **My profile & settings**. The authenticated upload endpoint checks the file signature, generates a random filename, and serves images through `/uploads/avatars/`. Public profile responses include the image path so photos appear on member cards and event/conversation screens. Local uploads are stored in `backend/uploads/avatars/`, which is excluded from Git. For production, configure `AVATAR_UPLOAD_DIR` to a persistent disk path; ephemeral deployment storage will lose uploaded pictures when the service restarts or redeploys.
