# Deploying to Render (with Neon PostgreSQL)

The repository ships a [Render Blueprint](../render.yaml) that deploys both
services — the web dashboard and the trading engine worker — from Dockerfiles.
The database schema is applied automatically on every boot (`prisma db push`,
idempotent and non-destructive), so **there is no manual database setup**.

## 1. Create the database (Neon)

1. Create a project at <https://neon.tech> (free tier works).
2. From the Neon dashboard copy **two** connection strings for the same
   database:
   - **Pooled** (host contains `-pooler`) → use as `DATABASE_URL`. This is the
     app's runtime connection.
   - **Direct / non-pooled** (same string without `-pooler`) → use as
     `DIRECT_URL`. This is used **only** to apply the schema at boot.

   > **Why both are required on Neon.** `prisma db push` (which creates the
   > tables automatically) needs a *direct* connection — it takes a Postgres
   > advisory lock and runs DDL that Neon's PgBouncer pooler cannot handle.
   > If `DIRECT_URL` is missing (or also points at the pooler), the schema
   > push fails, the database is left with **no tables**, and registration
   > errors with `table public.User does not exist`. With `DIRECT_URL` set to
   > the non-pooled endpoint, the container applies the full schema on first
   > boot and refuses to start if it can't — so you never serve an
   > un-initialized app. Plain (non-Neon) Postgres needs only `DATABASE_URL`;
   > `DIRECT_URL` falls back to it automatically.

## 2. Deploy the Blueprint

1. Push this repository to GitHub.
2. In Render: **New → Blueprint**, select the repo. Render reads `render.yaml`
   and creates `pumptrader-web` (web) and `pumptrader-engine` (worker).
3. When prompted, fill in the environment variables:

   | Variable | Service(s) | Value |
   |---|---|---|
   | `DATABASE_URL` | both | the Neon **pooled** connection string (host has `-pooler`) |
   | `DIRECT_URL` | both | the Neon **non-pooled** string (same, without `-pooler`) — required so the schema applies |
   | `NEXTAUTH_SECRET` | web | generated automatically by Render |
   | `WALLET_ENCRYPTION_KEY` | both (**must match**) | `openssl rand -hex 32` |
   | `SOLANA_RPC_URL` | both | a dedicated RPC (Helius/Triton/QuickNode). The public endpoint rate-limits the scanner within seconds. |
   | `SOLANA_WS_URL` | engine, optional | the matching `wss://` endpoint |
   | `HELIUS_API_KEY` | engine, optional | enables holder-count metrics (without it, `minHolders` rejects everything — safe, but the bot won't buy) |

4. Deploy. First boot: the container applies the schema to Neon, the health
   check (`/api/healthz`) goes green, and `https://<your-app>.onrender.com/register`
   serves the one-time administrator signup.

`NEXTAUTH_URL` is derived automatically from Render's `RENDER_EXTERNAL_URL`;
set it explicitly only when using a custom domain.

## 3. First-run checklist

1. Open `/register` and create the administrator account (works exactly once).
2. Settings → Security: enable 2FA.
3. Settings → Wallets: connect Phantom (watch-only) and/or import a dedicated
   bot wallet for auto-trading (encrypted with `WALLET_ENCRYPTION_KEY`).
4. Leave **paper trading ON**, press **Start auto** in the sidebar, and let it
   run against live market data.
5. Only after you trust the results: Dashboard → Trading mode → Live trading
   (requires explicit confirmation + an imported bot wallet).

## Redis (optional)

The platform needs no Redis: settings changes, engine control, health and the
live feed all flow through PostgreSQL (short polling). Adding Redis
(e.g. Render Key Value) and setting `REDIS_URL` on **both** services upgrades
those paths to instant pub/sub and shares rate-limit counters across
instances. Without it, nothing degrades except a few seconds of propagation
latency — and no logs are spammed.

## Google sign-in (optional)

1. Google Cloud Console → APIs & Services → Credentials → **Create OAuth
   client ID** (type: Web application).
2. Authorized redirect URI: `https://<your-app>.onrender.com/api/auth/callback/google`
   (must match `NEXTAUTH_URL` exactly, including https).
3. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` on the **web** service.

The "Continue with Google" button appears automatically once both variables
are set. Google sign-in only accepts the **existing administrator's email**
(the Google account's email must match it) — it never creates accounts. A
mismatched account shows "This Google account is not authorized" on the
login page.

## Troubleshooting login / registration

- **"Registration is disabled — administrator account already exists."**
  This is a single-administrator system: `/register` works exactly once. An
  account created during an earlier deployment attempt counts. To reset the
  password (or recreate the admin on an empty database), run — with the
  production `DATABASE_URL` exported:

  ```bash
  npm run admin:reset -- you@example.com 'a-new-strong-password' [--disable-2fa]
  ```

  (On Render: open a Shell on the web service, or run it locally against the
  Neon connection string.)
- **"The server cannot reach its database…"** on either page means exactly
  that: `DATABASE_URL` is missing/wrong or the database is down. The web
  container starts anyway so you can see the site; check the service logs —
  the entrypoint prints the schema-sync result on every boot.
- **Login always says invalid credentials:** after 5 failed attempts per
  email+IP the account locks for 15 minutes (brute-force protection). Wait it
  out, or restart the web service (counters are in-memory unless Redis is
  configured).

## Notes

- **Plans:** the engine worker runs 24/7; Render free-tier web services spin
  down when idle, which is fine for the dashboard but the **engine must run on
  a paid plan** (or another always-on host) to trade continuously.
- **Scaling:** run exactly **one** engine instance. The web service is
  stateless and may scale horizontally (rate-limit counters are per-instance
  unless Redis is configured).
- **Schema updates:** deploys apply additive schema changes automatically. A
  deliberately destructive schema change (dropping/renaming columns) is
  refused by `db push` at boot — perform such migrations manually with
  `npx prisma migrate diff` / `db push` from a trusted machine.
- **Backups:** Neon keeps point-in-time restore history (7 days on free
  tier). For belt-and-braces, schedule `pg_dump` somewhere off-platform.
