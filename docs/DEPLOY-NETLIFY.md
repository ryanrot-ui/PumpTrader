# Deploying to Netlify (directly from GitHub, with Neon PostgreSQL)

The repository is configured for Netlify's Next.js Runtime: fork/clone →
connect the repo in Netlify → set four environment variables → Deploy.
There is no Docker, no shell access, and no manual database step anywhere:
the build applies the database schema automatically, and the trading engine
runs as Netlify Functions.

## How the pieces map to Netlify

| Piece | Where it runs |
|---|---|
| Dashboard + API routes (incl. NextAuth) | Netlify Next.js Runtime (serverless functions + edge middleware) |
| Database schema setup | during the build (`scripts/netlify-build.mjs` → `prisma db push`, idempotent) |
| Trading engine | `engine-tick` scheduled function (every minute) relaunches `engine-runner-background`, a Background Function running full-fidelity ~13-minute engine cycles (5s position monitoring, migration scanning, exits) |
| Engine coordination | PostgreSQL (`EngineState` row: heartbeat lease, control queue, scanner cursor) — no Redis required |

## 1. Create the database (Neon)

1. Create a project at <https://neon.tech> (free tier works).
2. Copy the connection string — the default **pooled** one is fine. The
   build derives the direct endpoint it needs for schema setup
   automatically (set `DIRECT_URL` explicitly only if your non-pooled host
   is not simply the pooled host without `-pooler`).

## 2. Deploy from GitHub

1. Fork or push this repository to GitHub.
2. In Netlify: **Add new project → Import an existing project**, pick the
   repo. `netlify.toml` supplies the build command and functions setup.
3. Before the first deploy, add the environment variables (**Site
   configuration → Environment variables**):

   | Variable | Required | Value |
   |---|---|---|
   | `DATABASE_URL` | ✅ | the Neon connection string |
   | `NEXTAUTH_SECRET` | ✅ | `openssl rand -base64 32` |
   | `WALLET_ENCRYPTION_KEY` | ✅ | `openssl rand -hex 32` — encrypts wallet keys & 2FA secrets at rest |
   | `SOLANA_RPC_URL` | strongly recommended | a dedicated RPC (Helius/Triton/QuickNode). The public endpoint rate-limits the scanner within seconds. |
   | `SOLANA_RPC_URLS` | optional | comma-separated failover RPC endpoints |
   | `HELIUS_API_KEY` | optional | enables holder-count metrics (without it `minHolders` rejects everything — safe, but the bot won't buy) |
   | `NEXTAUTH_URL` | optional | only for custom domains — otherwise derived from Netlify's `URL` automatically |
   | `ENGINE_CRON_SECRET` | optional | dedicated secret for the engine-runner endpoint (defaults to `NEXTAUTH_SECRET`) |
   | `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | optional | Google sign-in (redirect URI: `https://<site>/api/auth/callback/google`) |
   | `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` / `DISCORD_WEBHOOK_URL` | optional | trade notifications |
   | `ANTHROPIC_API_KEY` | optional | AI meme-quality assessment |
   | `TWITTER_BEARER_TOKEN` | optional | X mention counts (paid API tier) |

   If a required variable is missing or malformed, **the build fails with a
   message telling you exactly what to set** — a misconfigured site never
   goes live.

4. Deploy. The build validates the environment, applies the schema to Neon
   (retrying through cold starts), and publishes the app. Then open
   `https://<your-site>.netlify.app/register` and create the administrator
   account (works exactly once).

## 3. First-run checklist

1. `/register` → create the administrator account.
2. Settings → Security: enable 2FA.
3. Settings → Wallets: connect Phantom (watch-only, requires a signed
   ownership proof) and/or import a dedicated bot wallet for auto-trading.
4. Leave **paper trading ON**, press **Start auto** in the sidebar, and let
   it run against live market data.
5. Only after you trust the results: Dashboard → Trading mode → Live
   trading (requires explicit confirmation + an imported bot wallet).

## How the serverless engine behaves (read this before live trading)

- A scheduled function fires every minute. If no engine cycle is active it
  launches a Background Function that runs the full engine for ~13 minutes:
  positions are monitored every 5 seconds, migrations are scanned by
  polling with a persisted cursor, and all buy/exit rules run exactly as in
  the long-running worker. Between cycles there is a gap of up to ~1 minute
  (typically seconds) during which positions are not monitored.
- **Background Functions require a Netlify plan that includes them.** If
  the background launch fails, the scheduler transparently degrades to one
  bounded engine pass per minute — exits, scanning and buying still happen,
  but positions are only checked once a minute. That is a meaningful
  difference for fast-moving meme coins; check the function logs for
  `inline-tick` vs `runner-launched` to see which mode you're in.
- Exactly one engine cycle can hold the database lease at a time (atomic
  conditional claim) — concurrent cycles that could double-sell are
  impossible by construction.
- The emergency stop works from the dashboard as always (DB control queue,
  consumed within ~5s by an active cycle, or at the next tick otherwise)
  and survives cycle boundaries.
- For the tightest exit latency (constant 5s monitoring with no gaps), run
  the long-running worker somewhere that keeps a process alive
  (`npm run engine` on any VPS) — it uses the same database and coexists
  with the Netlify site; the lease prevents double-running automatically.

## Limits inherited from serverless

- **SSE live feed:** the dashboard's live feed stream reconnects
  periodically (functions have bounded execution); the UI handles this
  automatically via EventSource reconnection.
- **Rate limiting / login lockout** counters are per-function-instance
  without Redis. They still work, but a distributed brute-force attempt is
  throttled less precisely than with Redis. Optionally set `REDIS_URL`
  (e.g. Upstash) to share counters and get instant pub/sub propagation.
- **Manual Phantom trades:** the submit endpoint waits for on-chain
  confirmation; on a slow network this can hit the function's execution
  limit. The transaction is still submitted — the position reconciler picks
  it up — but the UI may show a timeout. A dedicated RPC makes this rare.

## Troubleshooting

- **Build fails with "Deployment configuration is incomplete":** the
  message lists exactly which variable to set and how to generate it.
- **"The database schema is not initialized" on /register:** the build's
  schema push did not reach the database — check the deploy log for the
  `[build] schema in sync` line and that `DATABASE_URL` points at the right
  database.
- **"Registration is disabled — administrator account already exists":**
  single-administrator system; an account from an earlier deploy attempt
  counts. Reset locally with the production `DATABASE_URL` exported:
  `npm run admin:reset -- you@example.com 'a-new-strong-password'`
- **Engine shows offline:** open the Netlify function logs for
  `engine-tick` — it runs every minute and prints what it did
  (`runner-active`, `runner-launched`, `inline-tick`). No log entries at
  all means scheduled functions aren't enabled for the site (redeploy after
  confirming `netlify.toml` is present).
