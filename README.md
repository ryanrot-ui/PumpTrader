# PumpTrader — Pump.fun Migration Trading Platform

An automated trading platform for **newly migrated Pump.fun tokens on Raydium**. It
continuously watches for bonding-curve migrations, scores every token 0–100 against
dozens of quality indicators (green flags up, red flags down), buys only tokens that
clear **all** configurable rules, and exits positions by take-profit / stop-loss /
trailing-stop / time / emergency-rug rules — **selling the entire position at +100%
profit by default**.

> ⚠️ **Read this first.** Newly migrated meme tokens are among the most dangerous
> assets in crypto: most go to zero, and rugs happen in seconds. This software gives
> you filters, scoring transparency, and risk controls — it does **not** and cannot
> guarantee profitable trades. No signal in this codebase predicts profit. Start in
> **paper trading mode** (the default), and only ever fund the bot wallet with money
> you can afford to lose entirely.

---

## Architecture

```
┌────────────┐        ┌──────────────┐        ┌─────────────────────────────┐
│  Next.js   │        │  PostgreSQL  │        │        Trading Engine        │
│  frontend  │◄──────►│   (Prisma)   │◄──────►│  (separate Node worker)      │
│  + API     │        │ source of    │        │                              │
└────────────┘        │ truth for    │        │  MigrationScanner (WebSocket │
                      │ settings,    │        │   onLogs + polling fallback) │
   optional           │ engine state,│        │  Collectors → Scoring        │
   fast path:         │ trades, logs │        │  Buy rules → Risk manager    │
  ┌───────────┐       └──────────────┘        │  Executor (Jupiter/Raydium   │
  │   Redis   │  pub/sub: instant reload,     │   route or paper fills)      │
  │ (OPTIONAL)│  control, live feed           │  Position monitor (exits)    │
  └───────────┘                               └─────────────────────────────┘
```

- **Frontend** — Next.js (App Router), React, TypeScript, TailwindCSS. Dark,
  Photon/Axiom-inspired dashboard. Mobile responsive.
- **Backend API** — Next.js route handlers: auth, settings, wallets, tokens,
  positions, trades, stats, logs, bot control, SSE live feed.
- **Trading engine** — standalone worker (`npm run engine`), communicates with the
  web app only through Postgres (plus optional Redis pub/sub), so either side can
  restart independently.
- **Database** — PostgreSQL via Prisma: users, wallets, settings, engine state
  (status/heartbeat/health/control), detected tokens, score records (full
  breakdowns), snapshots, trades, positions, logs, daily stats. The schema is
  applied automatically on boot — no manual setup.
- **Redis (optional)** — never required: with `REDIS_URL` set, settings reloads,
  emergency stop and the dashboard live feed become instant (pub/sub) and
  rate-limit counters are shared across instances; without it, the same features
  run on short DB polling.

## Quick start

```bash
cp .env.example .env
# fill in: NEXTAUTH_SECRET (openssl rand -base64 32),
#          WALLET_ENCRYPTION_KEY (openssl rand -hex 32),
#          SOLANA_RPC_URL / SOLANA_WS_URL (a dedicated RPC — Helius, Triton,
#          QuickNode; the public endpoint rate-limits the scanner immediately)

docker compose up -d postgres   # (optionally: postgres redis)
npm install
npx prisma db push        # create schema
npm run dev               # web app on :3000
npm run engine            # trading engine worker (separate terminal)
```

Or run the whole stack in Docker: `docker compose up --build` (includes nightly
Postgres backups to `./backups`, and `restart: always` gives the engine automatic
crash recovery — it rebuilds its watchlist and open positions from Postgres on boot).

### Deploying to Render + Neon

One-click Blueprint deployment (web + engine worker, Neon PostgreSQL, automatic
schema initialization, no manual database steps):
see [`docs/DEPLOY-RENDER.md`](docs/DEPLOY-RENDER.md).

### Running reliably on Neon Free

Neon's free tier suspends the database compute after inactivity and drops
pooled connections when it does; the platform is built to ride that out
instead of spamming logs or crashing:

- **Connection strings.** `DATABASE_URL` must be Neon's **pooled** endpoint
  (hostname contains `-pooler`) — that's what both services query at runtime.
  Schema application needs the **direct** endpoint; the containers derive it
  automatically by stripping `-pooler`, so set `DIRECT_URL` only if your hosts
  differ by more than that. A wrong pairing is called out with a
  `[database] configuration warning:` line at boot.
- **Wake-friendly timeouts.** The Prisma datasource URL automatically gets
  `connect_timeout=15` and `pool_timeout=15` (your own URL params always win),
  so the very query that wakes a suspended compute doesn't time out at
  Prisma's 5s default and masquerade as an outage. Optional:
  `DB_CONNECTION_LIMIT=<n>` caps the pool size per process.
- **One client per process.** The web app and the engine each hold a single
  shared `PrismaClient`; nothing else opens connections.
- **Circuit breaker + offline queue (engine).** The first transient failure
  marks the database offline; scanning and scoring continue with writes
  captured in a bounded in-memory queue, probes retry on exponential backoff
  (5s → 60s cap, forever), and the first success flushes the queue in order
  with original timestamps. Status is one throttled log line per minute, not
  hundreds of Prisma stack traces — and the same applies to a database that
  is down when the engine boots (it starts scanning and recovers later).
- **Quiet web app.** Identical Prisma connectivity errors are collapsed to one
  line per minute with a repeat count, and the polled dashboard APIs answer
  `503 database temporarily unavailable` instead of a stack-traced 500.
- **Live visibility.** `/diagnostics` shows database status, last successful /
  failed query, retry countdown, queued writes, connection latency, Prisma
  version, and engine state.

Create the **administrator account** at `http://localhost:3000/register` (works
exactly once — registration is permanently disabled after the admin exists;
this is a single-operator system). Locked out or the account was created during
an earlier deployment attempt? Reset it against the production database:
`npm run admin:reset -- you@example.com 'new-password' [--disable-2fa]`. Then:

1. **Settings → Wallets → Connect Phantom** (watch-only: balances + deposits).
2. Create a **fresh wallet in Phantom** to act as the bot wallet, fund it with a
   small amount, export its private key, and **Import bot wallet**. The key is
   encrypted with AES-256-GCM (`WALLET_ENCRYPTION_KEY`) before it touches the
   database and is decrypted only in the engine at signing time.
3. Leave **paper trading ON** until you trust your configuration.
4. Press **Start** in the sidebar.

### Why can't Phantom itself trade for the bot?

Phantom (by design) requires a human click to approve every transaction — no
extension wallet can auto-sign for a server-side bot. Every serious trading platform
(Photon, BullX, Axiom) works the same way this app does: a dedicated hot wallet held
by the engine executes trades, while your main wallet stays in Phantom untouched.

## How trading decisions are made (fully transparent)

1. **Scanner** (`src/engine/scanner/migrationScanner.ts`) — WebSocket `onLogs`
   subscription on the Pump.fun Raydium migration authority detects migrations within
   seconds; a 30s polling fallback catches anything missed during disconnects.
2. **Collectors** (`src/engine/analysis/collectors.ts`) — DexScreener (price,
   liquidity, volume, buys/sells), Solana RPC (mint/freeze authority, top holders),
   optional Helius (holder counts), plus derived series: volume growth, holder
   growth, momentum, momentum acceleration, volatility, liquidity drift, slippage
   estimate, wash-trading and artificial-volume heuristics. **Missing data is scored
   neutral — never in a token's favor.**
3. **Scoring** (`src/engine/analysis/scoring.ts`) — 13 weighted metric groups →
   base score, plus green flags (bounded bonus) and red flags (explicit penalties).
   Critical flags (honeypot suspicion, active mint/freeze authority, liquidity
   removal, dev dumping) **block buying regardless of score**. Weights and all
   thresholds live in one file and every contribution is stored per evaluation and
   rendered in the Scanner UI.
4. **Buy rules** (`src/engine/trading/rules.ts`) — score ≥ threshold (default 85),
   liquidity/market-cap/holders/volume minimums, positive volume trend, rising
   momentum, slippage cap, zero critical flags. Every rejected token is stored with
   its exact rejection reasons.
5. **Risk manager** (`src/engine/trading/riskManager.ts`) — max SOL/trade, max open
   positions, max exposure, daily loss limit, daily profit target, loss cooldown,
   emergency stop. Position size is clamped to remaining exposure headroom.
6. **Exits** (`src/engine/trading/exitRules.ts`) — priority: emergency rug exit
   (liquidity draining / sells failing) → stop loss → trailing stop → take profit
   (default: sell 100% at +100%) → time exit.
7. Every trade stores its **entry/exit reason**, tx signature, and PnL.

## Configuration

Everything on the Settings page hot-reloads into the engine — no restart: buy
amount, confidence threshold, liquidity/mcap/holder/volume minimums, max
slippage, take profit, stop loss, trailing stop, time exit, sell portion, max
SOL/trade, max open positions, daily loss limit, daily profit target, max exposure,
loss cooldown, bot on/off, emergency stop (kill switch that also exits all open
positions). Propagation is instant with Redis configured, or within ~5 seconds via
DB polling without it.

**Paper ↔ Live** is a dedicated, server-enforced switch (Dashboard → Trading
mode): enabling live trading requires an explicit confirmation dialog *and* an
imported bot wallet — the API refuses the switch otherwise. The choice persists
per user in the database, the engine picks it up immediately, and in paper mode
no transaction is ever broadcast (fills are simulated at observed prices with a
slippage haircut, using the identical decision pipeline).

## Security

- **Single administrator** — registration self-disables after first use; Google
  OAuth only signs in the existing admin, never creates accounts.
- **argon2id password hashing** (legacy hashes upgraded transparently on login),
  brute-force lockout (5 fails / 15 min per identity+IP), audit-logged attempts.
- **Optional TOTP 2FA** (Google Authenticator/Authy), secret encrypted at rest.
- Sessions: JWT, 8h expiry, HTTP-only + Secure cookies on HTTPS, 30-min
  inactivity auto-logout; CSRF protection built into NextAuth.
- Content-Security-Policy (same-origin), HSTS, X-Frame-Options and friends.
- Bot wallet keys: AES-256-GCM, key material only in env, decrypted only at
  signing, never logged, never returned by any API, never sent to the client.
- Phantom linking requires a signed ownership proof (free `signMessage`,
  verified ed25519 server-side with account binding + a 10-minute replay
  window) — arbitrary addresses can never be attached to an account.
- Input validation: zod on every mutating endpoint; SQLi prevented by Prisma
  parameterized queries; XSS by React escaping; rate limiting on sensitive
  endpoints (Redis-backed when configured, in-memory otherwise).
- `npm audit --omit=dev`: 0 known vulnerabilities at time of audit.
- Nightly automated Postgres backups (docker compose `backup` service).
- Full audit report: [`docs/AUDIT.md`](docs/AUDIT.md) — read the "manual
  verification" list before trading real funds.

## Narrative & social intelligence

Meme coins move on attention, not fundamentals — so alongside the technical
score, every watched token is continuously researched by a **Narrative
Intelligence Engine** (`src/engine/narrative/`):

- **Sources** — DexScreener social profile + paid-boost status + windowed
  activity acceleration (always on, no keys); Reddit public search (mention
  velocity, engagement, title sentiment); Telegram public channel pages
  (community size and growth between snapshots); optional X mention counts
  (`TWITTER_BEARER_TOKEN`); optional AI meme-quality assessment via the
  Claude API (`ANTHROPIC_API_KEY`, one small structured request per token).
  Every source degrades gracefully: missing data scores **neutral, never
  bullish**, and the missing sources are listed on the report.
- **Scores (0–100, all explained factor-by-factor)** — **Narrative** (social
  presence, attention velocity, mention velocity, engagement, community
  growth, cross-platform confirmation, sentiment; weights configurable via
  `narrativeWeights`; paid DexScreener boosts cap the score — bought attention
  isn't organic), **Meme strength** (AI-judged originality/humor/trend
  relevance/branding blended with observed spread), and **Rug risk** (an
  evidence-based *estimate* from mint/freeze authority, LP lock, liquidity
  level and trend, holder concentration, dev behavior, suspicious wallets,
  trading anomalies, sell pressure — it can never claim certainty).
- **Decision engine** — buys require the technical score *and* every
  configured narrative gate (`minNarrativeScore`, `minMemeScore`,
  `maxRugRiskScore`); a configured gate with missing narrative data fails
  closed. Every pass/fail reason is recorded on the token and the trade.
- **Continuous monitoring** — open positions are re-researched every minute;
  on deterioration (rug-risk spike, narrative collapse vs entry, strongly
  negative sentiment) the bot alerts or exits per `narrativeExitMode`
  (off / alert / execute).
- **Learning** — the full signal snapshot at entry is stored on every
  position; the **Intelligence** page compares signals against realized
  outcomes (win rate and average ROI per signal bucket) so strategies are
  tuned on this bot's own history rather than assumptions.

## Trading modes

- **Paper** (default) — real market data, real scoring, simulated fills; no
  transaction is ever broadcast. Every simulated trade is stored exactly like a
  real one and appears in the same analytics (filterable Paper/Live).
- **Live** — real swaps via Jupiter with the encrypted bot wallet. Enabled only
  through the confirmation dialog; requires an imported bot wallet.
- **Manual** — connect Phantom (official wallet adapter); every trade is built
  server-side, signed by you in the Phantom popup, and submitted. No key ever
  leaves the extension.
- **Auto** — the engine trades a dedicated, encrypted bot wallet under the
  configured rules. The active mode (and paper/live/read-only state) is always
  shown in the sidebar.
- **Read-only** — the engine scans and scores but executes nothing.
- **Emergency stop** — halts buying and exits every open position (with
  confirmation).

## Testing

```bash
npm test          # vitest: scoring, buy rules, risk manager, exit rules, crypto
npm run typecheck
```

Paper mode **is** the integration environment: the full pipeline (scanner →
scoring → rules → risk → executor → position monitor) runs identically, with fills
simulated at observed prices minus a slippage haircut.

## Project layout

```
prisma/schema.prisma          # full data model
src/lib/                      # prisma, redis, crypto, auth, validation, rate limit
src/engine/                   # the trading engine worker
  scanner/migrationScanner.ts
  analysis/{types,collectors,scoring}.ts
  trading/{rules,riskManager,exitRules,executor}.ts
  notify/  logging/  config.ts  index.ts
src/app/                      # Next.js pages + API routes
src/components/               # dashboard UI, charts (TradingView lightweight-charts)
tests/                        # unit tests for all decision logic
```

## Extending

- **Weights**: edit `DEFAULT_WEIGHTS` in `scoring.ts` (or lift them into Settings).
- **New metric**: add a field to `TokenMetrics`, populate it in a collector, score
  it in `scoring.ts` — the UI breakdown picks it up automatically.
- **New data source**: add a collector; failures degrade gracefully to neutral.
- **Notifications**: Telegram + Discord work out of the box via env vars; the email
  hook is in `src/engine/notify/index.ts` (wire nodemailer to your SMTP).
