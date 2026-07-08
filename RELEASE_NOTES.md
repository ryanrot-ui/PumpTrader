# Release Notes — PumpTrader 1.0 (Release Candidate)

Automated trading platform for newly migrated Pump.fun tokens on Raydium:
migration scanner → 13-group scoring engine → narrative/social intelligence →
rule-gated buys → risk-managed exits → full analytics, with a paper-trading
mode that is the default and uses the identical code path as live trading.

> **Risk statement.** This is high-risk experimental software for one of the
> most adversarial markets in crypto. It provides configurable filters and
> risk controls; it does not and cannot guarantee profits. Paper trades are
> simulations. Never fund the bot wallet with money you cannot afford to lose.

## Major features

### Trading engine
- **Migration scanner:** Pump.fun → Raydium migrations detected via the
  migration authority (WebSocket `onLogs` on long-running hosts; signature
  polling with a persisted cursor on serverless) — nothing is missed across
  restarts or cycle boundaries.
- **Scoring engine:** 13 weighted metric groups (liquidity, market cap,
  holders, volume, momentum, buy pressure, whale/dev concentration, LP
  status, authorities, wash-trading/sniper/bundle heuristics, …) → 0–100
  score with green/red flags and a persisted factor-by-factor explanation.
  Critical flags (honeypot, active mint/freeze authority, liquidity pull,
  dev dumping) block buying outright. Missing data always scores neutral.
- **Narrative & social intelligence:** every watched token researched across
  DexScreener socials/boosts, Reddit, Telegram public pages (optional: X
  API, Claude meme assessment) → narrative / meme-strength / rug-risk scores
  with explanations, fail-closed buy gates, deterioration monitoring on open
  positions (off / alert / auto-exit), and entry-signal vs. outcome
  analytics on the Intelligence page.
- **Risk management:** per-trade size, max open positions, max exposure,
  daily loss limit, daily profit target, loss cooldown, slippage cap,
  priority fees; take-profit (with partial selling), stop-loss, trailing
  stop (arms only in profit), time-based exit, rug exit on liquidity drops;
  emergency stop that market-exits everything and survives restarts.
- **Execution safety:** buy path serialized under a lock with a DB-unique
  `openKey` (duplicate positions impossible even across concurrent engines
  or crash-restarts); never-retry-uncertain swap semantics with on-chain
  reconciliation; live sells verify the actual wallet balance first; failed
  buys roll back their reservation — no phantom positions or balances.

### Platform
- **Deployment:** GitHub → Netlify, zero manual steps. The build validates
  environment variables with actionable errors, derives the Neon direct
  endpoint, applies the schema automatically, and the engine runs as a
  scheduled function + background function cycles coordinated by an atomic
  database lease. No Docker, no shell access. (A long-running
  `npm run engine` worker remains available for VPS hosts and coexists via
  the same lease.)
- **Dashboard:** live PnL/ROI/win-rate, equity curve, scanner with full
  score breakdowns, positions with per-trade signatures and excursion
  analytics (max gain / max drawdown), trade history, logs, SSE live feed,
  health strip with engine heartbeat, hot-reloading settings.
- **Modes:** PAPER (default) / LIVE with a server-enforced switch — the
  confirmation dialog's explicit acknowledgment AND an imported bot wallet
  are required by the API, not just the UI; paper mode routes every order
  through a simulator that never constructs a transaction.
- **Wallets:** Phantom watch-only connect gated by a signed ownership proof
  (ed25519-verified, account-bound, 10-minute window); manual Phantom trades
  (server builds the Jupiter swap → Phantom signs → server relays only
  transactions it built, exactly once); bot wallet keys AES-256-GCM
  encrypted, decrypted only at signing, never logged or returned.
- **Auth:** single-administrator bootstrap (registration works exactly once),
  argon2id hashing, brute-force lockout, optional TOTP 2FA, JWT sessions
  with Secure/HTTP-only cookies, optional Google sign-in bound to the admin
  email, full audit log.

## Deployment requirements

| Requirement | Value |
|---|---|
| Hosting | Netlify (Next.js Runtime; Background Functions recommended for full-fidelity engine cycles) |
| Database | PostgreSQL — Neon works on the free tier |
| `DATABASE_URL` | required (pooled Neon string is fine) |
| `NEXTAUTH_SECRET` | required — `openssl rand -base64 32` |
| `WALLET_ENCRYPTION_KEY` | required — `openssl rand -hex 32` |
| `SOLANA_RPC_URL` | strongly recommended — dedicated RPC (public endpoint rate-limits immediately) |
| Optional | `SOLANA_RPC_URLS` (failover), `HELIUS_API_KEY` (holder metrics), `REDIS_URL` (shared rate limits + instant pub/sub), Google OAuth, Telegram/Discord notifications, `ANTHROPIC_API_KEY`, `TWITTER_BEARER_TOKEN` |

See [`docs/DEPLOY-NETLIFY.md`](docs/DEPLOY-NETLIFY.md) for the step-by-step
guide and troubleshooting, and [`docs/AUDIT.md`](docs/AUDIT.md) for the full
eight-round audit trail.

## Known limitations

- **Serverless engine cadence:** with Background Functions, positions are
  monitored every 5s during ~13-minute cycles with gaps of up to ~1 minute
  between cycles; without them (plan-dependent) the engine degrades to one
  pass per minute. For gap-free 5s monitoring run `npm run engine` on any
  always-on host — it shares the database and the lease arbitrates
  automatically. Check function logs for `runner-launched` vs `inline-tick`.
- **Data dependencies:** DexScreener/Jupiter/Helius outages degrade scoring
  to neutral and block execution (fail-safe), but a wrong upstream price is
  still a wrong input. Without `HELIUS_API_KEY`, holder metrics are null and
  the default `minHolders` rule rejects every token (safe, but no buys).
- **Heuristics can be gamed:** sniper/bundle/wash-trading detection raises
  the bar; a motivated adversary can manufacture a healthy-looking launch.
  Scores rank profile-fit — they do not predict profit.
- **Hot-wallet risk is irreducible** in auto mode: the server can sign with
  the imported bot wallet. Keep it small; sweep profits out regularly.
- **Serverless rate limiting** uses per-instance counters unless `REDIS_URL`
  is configured (Upstash works).
- **Manual Phantom trade confirmation** can exceed the function limit on a
  slow RPC — the transaction still lands and is reconciled, but the UI may
  show a timeout.
- **2FA requires accurate server clocks** (±30s TOTP drift window).
- **Emergency exit sells into whatever liquidity remains** — it is a damage
  limiter, not protection.

## Verification summary (release candidate)

On a fresh, empty PostgreSQL 16 database, this release was verified
end-to-end: build-time env validation failure modes; automatic schema
creation (13 tables); registration → duplicate-registration block → login →
session → protected routes → logout → re-login after restart; every API
route authenticated and anonymous; argon2id at rest; SSE first-byte;
serverless engine lease claim/contention, bounded cycles (`runOnce`/
`runFor`), emergency-stop persistence across cycles, scheduled-tick and
background-runner handlers (including the 403 auth guard); esbuild bundling
of both functions; 93/93 unit tests (scoring, buy rules, risk, exits,
trailing stop, excursions, concurrency/locking, retry semantics, crypto,
TOTP, wallet ownership proofs, manual-trade binding, rate limiting,
narrative/rug-risk); strict typecheck; production build. Paper-trading money
math and the full trade lifecycle (buy → TP/SL/trailing → close → analytics,
fault injection, restart recovery) were verified by the 38-check production
simulation recorded in `docs/AUDIT.md`; zero real transactions occur in
paper mode by construction. Live trading, Phantom-in-browser flows, and the
final Netlify deployment click require operator verification — follow
`docs/AUDIT.md` §7 (fund ~0.1 SOL, watch one full live cycle) before
trading significant funds.
