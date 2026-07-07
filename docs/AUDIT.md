# Production Audit Report — PumpTrader

> **Addendum — second hardening round (2026-07).** Changes since the original
> audit below:
>
> - **Redis is now optional.** The database became the single source of truth
>   for engine coordination via a new `EngineState` row (status, heartbeat,
>   health telemetry, read-only flag, control queue). Settings hot-reload,
>   emergency stop, health strip and the live feed all work Redis-free on
>   short DB polling; `REDIS_URL` re-enables the instant pub/sub fast path.
>   Rate limiting and login lockout fall back to in-memory counters. Redis
>   outages log exactly one line per connection (and one on recovery) — no
>   spam. The loss-cooldown anchor and the rug-detection liquidity baseline
>   moved from Redis keys to the database (`Position.entryLiquidityUsd`), so
>   they survive restarts.
> - **Paper ↔ Live switching is server-enforced.** A dedicated
>   `set_mode` API action requires `confirmLive: true` (set only by the
>   dashboard's confirmation dialog) *and* an imported bot wallet before live
>   mode engages; the settings form can no longer flip the mode (schema omits
>   it). The mode persists per user and hot-reloads into the engine.
> - **Per-position excursion analytics.** `maxUnrealizedPnlPct` and
>   `maxDrawdownPct` are tracked on every monitor tick (unit-tested pure
>   function) and shown in the position detail view. `/api/stats` gained a
>   paper/live/all mode filter, monthly/weekly/daily profit windows, win/loss
>   counts, success rate, average ROI and an equity curve derived from closed
>   positions.
> - **Deployment cleaned up.** Railway configs and a manually-added
>   `prisma db push --accept-data-loss` debug hack were removed; the
>   entrypoints run a plain, non-destructive `db push` (idempotent, automatic
>   schema init). Added `render.yaml` (web + worker) with Neon PostgreSQL,
>   an unauthenticated `/api/healthz` probe for platform health checks, and
>   automatic `NEXTAUTH_URL` derivation from `RENDER_EXTERNAL_URL`.
> - **Fixes:** unauthenticated visitors are now redirected to `/login`
>   (middleware previously sent them to NextAuth's unstyled default page);
>   web3.js websocket reconnect noise is throttled to one line/minute; dead
>   config (`TRADING_MODE`, `engine:paper`) and a stray 5 MB upload artifact
>   were removed.

**Scope:** full engineering + security audit of the Pump.fun migration trading
platform prior to live deployment. Covers trading correctness, security,
reliability, performance, and observability. This report lists what was
changed, what risk remains, and what must be verified by hand before real
funds are used.

**This application is NOT claimed to be perfectly secure.** It handles hot
wallet keys and trades an adversarial market. Read "Remaining risks" and
"Manual verification required" before funding it.

---

## 1. Improvements made

### Trading correctness

| Issue found | Fix |
|---|---|
| **Race condition: concurrent token evaluations could over-commit.** Risk check and position creation were not atomic — 8 tokens evaluated in parallel could each pass `maxOpenPositions`/`maxExposureSol` and all buy. | Buy path is now a serialized critical section (`AsyncLock`): risk check → position *reservation* happen under a FIFO mutex; the swap executes outside the lock; a failed swap rolls the reservation back. |
| **Duplicate buys possible across restarts** (in-memory guard only). | DB-level guard: `Position.openKey` (unique, = mint while OPEN, cleared on close). A second open position on the same mint is impossible even with multiple engine processes or crash-restart races. |
| **Ambiguous swap outcomes could double-execute.** A confirmation timeout used to surface as a generic error; a retry could buy/sell twice. | Executor now distinguishes `SwapDroppedError` (provably not on-chain → retryable) from `SwapUncertainError` (unknown → **never retried**, flagged for manual check with the signature). Retry wrapper (`withRetries`) refuses to retry uncertain outcomes. |
| **No blockhash-expiry handling.** | Swaps confirm against their own `lastValidBlockHeight`; on timeout the signature status is checked (`searchTransactionHistory`) to classify landed / dropped / unknown. |
| **No wallet desync recovery.** DB said tokens existed; wallet might not hold them (manual sale, partial fill). | Live sells verify the on-chain balance first: zero balance → position reconciled closed (no doomed swap); lower balance → sells the real balance. |
| **No pre-buy balance check.** | Live buys verify the bot wallet holds `size + 0.01 SOL` for fees before reserving. |
| **`closePosition` could violate the Trade→Token FK** (`tokenId: ""`). | `Trade.tokenId` is nullable with `onDelete: SetNull`; trades now also carry their own `mint`/`symbol`, so financial history never depends on scanner rows. |
| Trailing stop could fire while underwater. | Trailing stop only arms once the position is in profit (stop loss owns the downside). Covered by unit test. |
| Transaction simulation | Preflight simulation is enabled on every live send (`skipPreflight: false`), so doomed swaps fail before spending fees. |

### Security

| Area | What was done |
|---|---|
| Single administrator | Registration works exactly once (first-run bootstrap); permanently returns 403 afterwards. Google OAuth signs in only the existing admin email — it never creates accounts. |
| Password hashing | argon2id (19 MiB, t=2 — OWASP params). Legacy bcrypt hashes still verify and are transparently re-hashed to argon2 on next login (verified live). |
| Brute force | 5 failed attempts per email+IP per 15 min → lockout (verified live). Every attempt (success/fail/lockout) is audit-logged without the password. |
| 2FA | Optional TOTP (RFC 6238, dependency-free implementation, ±1 step drift). Secret AES-256-GCM encrypted at rest, returned exactly once at setup. Full enable/confirm/disable cycle + login enforcement verified live. |
| Sessions | JWT, 8h absolute expiry, HTTP-only cookies, `Secure` + `__Secure-` prefix on HTTPS deployments, SameSite=lax. 30-minute inactivity auto-logout in the UI. CSRF protection via NextAuth double-submit token (all state-changing routes are cookie-authenticated POST/PUT/DELETE). |
| Headers | Content-Security-Policy (same-origin everything; no external scripts/styles/connects), HSTS, X-Frame-Options DENY, nosniff, referrer policy, permissions policy. |
| API | Every endpoint authenticates via `requireUser()`; zod validation on all inputs; rate limiting on register/wallet/2FA/bot-control/manual-trade; stack traces never returned (logged server-side, generic message to client). |
| Secrets | Bot wallet keys and TOTP secrets AES-256-GCM encrypted (key only in `WALLET_ENCRYPTION_KEY` env). Keys decrypted only at signing time, never cached, never logged, never sent to any client. No `NEXT_PUBLIC_` secrets. Env validated at boot (`validateEnv`) — malformed encryption keys are rejected at startup. Grep-audit: no hardcoded secrets in the repo; `.env` is gitignored. |
| Phantom | Official `@solana/wallet-adapter` (connect / disconnect / auto-reconnect / account-change detection). Watch-only server-side. Manual trades: server builds an unsigned Jupiter swap → Phantom prompts and signs in-extension → server submits signed bytes. Seed phrases/keys are never requested; UI explicitly warns against pasting seed phrases. |
| Dependency vulnerabilities | `npm audit --omit=dev`: **0 vulnerabilities** (Next.js upgraded to 15.5.16+, uuid/postcss pinned via overrides). |

### Reliability

- **RPC failover:** `SOLANA_RPC_URLS` accepts comma-separated fallback endpoints; a 10s health probe rotates connections after 3 consecutive failures and resubscribes the scanner.
- **Scanner watchdog:** if the WebSocket is silent 10 min, the subscription is rebuilt (dead-socket detection); 30s signature polling continues as the safety net; duplicate signature/mint sets are memory-bounded.
- **Crash recovery:** watchlist + open positions rebuilt from Postgres on boot; `restart: always` in compose; `uncaughtException` → log with stack → exit for supervisor restart; `unhandledRejection` logged.
- **No silent failures:** `logger.exception` records stack traces; the latest error is published to Redis and displayed on the dashboard health strip.
- **Data hygiene:** 6-hourly archival deletes snapshots/score records older than `ARCHIVE_AFTER_DAYS` (default 14), rejected/ignored tokens with no trades, and logs older than 30 days. Trades and positions are never deleted.

### Configurability (no restart needed — Redis pub/sub hot reload)

New live-editable settings: `maxLiquiditySol`, `minBuyPressure`, `maxWhalePct`,
`maxDevPct`, `priorityFeeLamports` (null = auto), `retryCount`,
`scannerIntervalSec`, and `scoringWeights` (JSON override of all 13 metric
weights). Every buy-rule threshold is now a setting; scoring weights are data,
not code.

### Observability

- `/api/health`: engine heartbeat, RPC latency + endpoint, scans/min, watchlist size, last scan, last trade, memory, last error — rendered as a dashboard health strip.
- Trade telemetry: every trade stores latency (ms), RPC used, priority fee, retry count, slippage setting, error message, signature, mint, symbol.
- Position detail view: entry/exit price+time, PnL, ROI, hold time, scanner score, full score explanation, buy/sell reasons, per-trade signatures with Solscan links, DexScreener + explorer links.
- New stats: weekly PnL, average hold, average PnL/trade, largest winner/loser, rejected-today.
- Audit log events: logins (success/fail/lockout), 2FA changes, wallet connect/import, settings changes (changed keys), bot control actions incl. emergency stop, manual trades.

### Emergency features

- **Emergency stop** (confirmation dialog): halts buying and market-exits every position.
- **Read-only mode**: engine scans/scores but suppresses all buys **and** sells (logged as "would have…").
- Trading status indicator: AUTO·paper / AUTO·LIVE / MANUAL·Phantom / READ-ONLY / EMERGENCY, on desktop sidebar + mobile header.

### Tests

51 unit tests (was 37): scoring, buy rules (incl. new thresholds), risk
manager, exit rules, AES-GCM crypto, TOTP (cross-checked against a reference
implementation), AsyncLock serialization, retry semantics (incl.
never-retry-uncertain). Typecheck (strict) and production build clean.

---

## 2. Remaining risks (accepted / known)

1. **Hot wallet risk is irreducible.** Auto mode requires a key the server can
   use. If the host is compromised, the bot wallet can be drained.
   `WALLET_ENCRYPTION_KEY` and the DB on the same host means encryption
   protects against DB exfiltration, not full host compromise. Keep the bot
   wallet small; sweep profits out regularly.
2. **Third-party data dependencies.** DexScreener/Jupiter/Helius outages
   degrade scoring to neutral (never bullish) and block execution — but a
   *wrong* price from a source is a wrong input. The stale-sell guard only
   refuses to act on missing prices.
3. **Heuristic metrics can be gamed.** Sniper/bundle/fresh-wallet/wash-trading
   detection raises the bar; a motivated adversary can still manufacture a
   healthy-looking launch. The score ranks profile-fit — it does not predict
   profit.
4. **CSP allows `unsafe-inline`/`unsafe-eval` for scripts** (Next.js hydration
   + wallet-adapter). Nonce-based CSP is the next hardening step.
5. **Single-operator design.** One Settings row drives the engine; there is no
   role separation or approval workflow.
6. **`getTokenLargestAccounts` heuristic** (largest account = pool vault) can
   mis-attribute top-holder % in edge cases (multiple pools, locked vaults).
7. **Emergency exit sells into whatever liquidity remains** — in a real rug the
   exit may fill at a huge loss or fail entirely. It is a damage limiter, not
   protection.
8. **Redis outage:** rate limits fail open (availability over lockout-DoS);
   read-only flag reads fail closed to "not read-only". Engine control
   channel unavailable → use `stop` via settings (DB) or kill the process.

## 3. Potential failure scenarios

- RPC returns success but the swap lands after the blockhash window →
  classified uncertain → position kept, flagged, reconciled by the balance
  check on the next monitor tick.
- Engine crash mid-buy (after reservation, before trade row) → reservation has
  `tokenQty 0`; live-mode reconciliation closes it if no tokens are held.
  Paper-mode leftovers must be closed manually (visible as 0-qty positions).
- Postgres down: engine loops fail loudly and retry next tick; nothing trades
  blind because every decision reads fresh DB state.
- Both RPC endpoints down: heartbeat stays alive, scans stop, health strip
  shows failures; no trades occur (fail-safe direction).
- Clock skew >60s on the host breaks TOTP login (drift window ±30s) — keep NTP
  enabled.

## 4. Performance notes & bottlenecks

- Evaluation is batched (8 concurrent) per `scannerIntervalSec`; ~hundreds of
  watched tokens are fine, but DexScreener rate limits (~300 req/min) are the
  practical ceiling — raise `scannerIntervalSec` if you see 429s in logs.
- Position monitor polls prices every 5s per open position (2 HTTP calls each).
  With `maxOpenPositions ≤ 10` this is negligible.
- Hot tables are indexed (`status`, `openedAt`, `mint`, `positionId`,
  `at`/`level`/`source`); archival keeps them small.
- The web app is stateless; Redis pub/sub fans out live events without DB
  polling (SSE bridge).

## 5. Configuration recommendations

- Use a **paid dedicated RPC** (Helius/Triton/QuickNode) + a second provider in
  `SOLANA_RPC_URLS`. Public mainnet RPC will rate-limit the scanner within
  seconds (observed).
- Set `HELIUS_API_KEY` — without it holder metrics are null and `minHolders`
  will reject everything (fail-safe, but the bot won't trade).
- Start with: paper trading ON ≥ 1 week; then live with `buyAmountSol 0.05`,
  `maxOpenPositions 2`, `maxDailyLossSol` you truly accept, 2FA enabled,
  Telegram notifications on.
- Deploy behind a TLS reverse proxy (Caddy/nginx); set `NEXTAUTH_URL` to the
  HTTPS origin (this switches on Secure cookies). Do not expose Postgres/Redis
  publicly. Keep the nightly backup volume off-host if possible.

## 6. Suggested monitoring metrics

Engine heartbeat age (>20s = page), RPC latency & failure count, scans/min,
watchlist size, open positions vs cap, daily realized PnL vs loss limit,
swap retry rate, `SwapUncertainError` count (should be ~0 — page immediately),
reconciled-position count, memory RSS trend, log error rate, time since last
migration detected (market liveness).

## 7. Manual verification required before significant funds

1. **Fund the bot wallet with a trivial amount (~0.1 SOL) and watch one full
   live cycle** — buy, monitor, take-profit/stop-loss — on your own RPC.
   Confirm signatures on Solscan match the dashboard.
2. Verify the **emergency stop** live with an open position.
3. Verify **RPC failover** by putting a dead URL first in `SOLANA_RPC_URLS`.
4. Confirm backups restore: `psql < backups/pumptrader-<date>.sql` on a clean DB.
5. Review `MIN_AGE_BEFORE_BUY_S` (90s) and the watch window (45 min) against
   your strategy — these are engine constants, deliberately not UI-editable.
6. Test your Telegram/Discord notification path end-to-end.
7. Rotate `WALLET_ENCRYPTION_KEY` handling: store it in a secret manager, not
   a plaintext `.env`, on any shared host.
8. Run the paper simulator through at least one weekend (weekend liquidity is
   thinner; loss limits get tested).

---

*Generated as part of the pre-launch audit. The paper-trading pipeline is the
integration test bed — identical code path to live, simulated fills only.*
