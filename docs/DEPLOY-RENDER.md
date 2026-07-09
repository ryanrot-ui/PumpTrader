# Deploying to Render (with Neon PostgreSQL)

The repository ships a [Render Blueprint](../render.yaml) that deploys both
services — the web dashboard and the trading engine worker — from Dockerfiles.
The database schema is applied automatically on every boot (`prisma db push`,
idempotent and non-destructive), so **there is no manual database setup**.

## 1. Create the database (Neon)

1. Create a project at <https://neon.tech> (free tier works).
2. Copy the **pooled** connection string (the default Neon gives you; its host
   contains `-pooler`). That single string is your `DATABASE_URL` — you do
   **not** need to copy a second one.

   > **Neon and the schema push, explained.** `prisma db push` (which creates
   > the tables automatically on boot) needs a *direct* connection — it takes a
   > Postgres advisory lock and runs DDL that Neon's PgBouncer pooler cannot
   > handle. The containers derive that direct connection for you by removing
   > `-pooler` from `DATABASE_URL`, so schema init works with **only
   > `DATABASE_URL` set**. If your pooled and direct hosts happen to differ by
   > more than `-pooler`, set `DIRECT_URL` explicitly to the non-pooled URL;
   > otherwise leave it unset. Plain (non-Neon) Postgres also needs only
   > `DATABASE_URL`. The container refuses to start if the schema can't apply,
   > so you never serve an un-initialized app.

## 2. Deploy the Blueprint

1. Push this repository to GitHub.
2. In Render: **New → Blueprint**, select the repo. Render reads `render.yaml`
   and creates `pumptrader-web` (web) and `pumptrader-engine` (worker).
3. When prompted, fill in the environment variables. **Only `DATABASE_URL` is
   required** — everything else is generated for you or optional:

   | Variable | Service(s) | Required? | Value |
   |---|---|---|---|
   | `DATABASE_URL` | both | **Yes** | the Neon **pooled** connection string (paste the same value on both services) |
   | `NEXTAUTH_SECRET` | web | No — auto-generated | Render fills this in via `generateValue`; no action needed |
   | `WALLET_ENCRYPTION_KEY` | both (**must match**) | Only for **live** trading | `openssl rand -hex 32` (64 hex chars). Leave blank for paper trading. |
   | `SOLANA_RPC_URL` | both | No — recommended | a dedicated RPC (Helius/Triton/QuickNode). Defaults to the public mainnet endpoint, which rate-limits the scanner within seconds. |
   | `SOLANA_WS_URL` | engine | No | the matching `wss://` endpoint for the migration scanner |
   | `HELIUS_API_KEY` | engine | No | enables holder-count metrics (without it, `minHolders` rejects everything — safe, but the bot won't buy) |
   | `DIRECT_URL` | both | No — auto-derived | only if your direct host differs from the pooled host by more than `-pooler` |

4. Click **Apply**. First boot: each container applies the schema to Neon (a
   fresh, empty database is fine — no manual commands), the web health check
   (`/api/healthz`) goes green, and `https://<your-app>.onrender.com/register`
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

## Troubleshooting an empty token list

The dashboard and **Token scanner** page show five health indicators — **Engine
Running · RPC Connected · Scanner Active · Last Scan · Tokens Detected** — plus
the exact reason when detection is impaired. Read them top-to-bottom:

- **Engine Running = Offline.** The `pumptrader-engine` worker isn't running (or
  can't reach the database). Confirm the worker is deployed and shares the web
  service's `DATABASE_URL`. Nothing is detected while the engine is down.
- **RPC Connected shows "public"** (amber) **and Scanner Active = Polling.** You
  didn't set `SOLANA_RPC_URL`, so the engine is on the public mainnet endpoint.
  It **rejects the realtime scanner websocket (HTTP 403)** and rate-limits
  polling, so the token list stays empty or nearly so. **Fix:** set
  `SOLANA_RPC_URL` (and ideally `SOLANA_WS_URL`) on **both** services to a
  dedicated provider — a free [Helius](https://helius.dev) key works — then
  redeploy. This is the most common cause of an empty list.
- **Scanner RPC error banner.** The RPC is unreachable or rate-limiting; the
  exact message is shown and logged (source `scanner`). Check the RPC URL/limits.
- **All green but Tokens Detected = 0.** The scanner is healthy and simply hasn't
  seen a migration in the current window — Pump.fun → Raydium migrations are
  intermittent. New coins appear as they migrate. The engine also logs a
  periodic `[scanner] No migrations detected yet, but the scanner is active…`
  line so you can confirm it's working during quiet periods.

Detection runs in **paper mode** too — it does not depend on live trading being
enabled, so tokens populate the list as soon as the scanner has a working RPC.

## Notes

- **Plans:** the engine worker runs 24/7; Render free-tier web services spin
  down when idle, which is fine for the dashboard but the **engine must run on
  a paid plan** (or another always-on host) to trade continuously.
- **Scaling:** run exactly **one** engine instance. The web service is
  stateless and may scale horizontally (rate-limit counters are per-instance
  unless Redis is configured).
- **Restarts & graceful shutdown:** on deploy/restart Render sends `SIGTERM`;
  the engine finishes in-flight work, closes the database, and exits cleanly,
  then rebuilds its watchlist and open positions from PostgreSQL on the next
  boot. A DB-unique open-position key prevents duplicate buys across restarts.
  The engine reconnects to Solana RPC automatically on transient failures.
- **Schema updates:** deploys apply additive schema changes automatically. A
  deliberately destructive schema change (dropping/renaming columns) is
  refused by `db push` at boot — perform such migrations manually with
  `npx prisma migrate diff` / `db push` from a trusted machine.
- **Backups:** Neon keeps point-in-time restore history (7 days on free
  tier). For belt-and-braces, schedule `pg_dump` somewhere off-platform.
