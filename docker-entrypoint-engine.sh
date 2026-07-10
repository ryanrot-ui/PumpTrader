#!/bin/sh
# Engine container entrypoint. The engine cannot function without its database,
# so the schema sync is required here too. Uses a DIRECT connection for push
# (Neon's pooled endpoint cannot run the DDL); retries for cold-start; exits
# non-zero on persistent failure so the platform restarts it.

set -e

# Mirror of the web entrypoint's guard: this is the ENGINE image — it serves
# no HTTP port, so a Render *web service* pointed at it would run a headless
# engine and fail every health check. Fail loudly with the fix instead.
if [ "$RENDER_SERVICE_TYPE" = "web" ]; then
  echo "[engine] FATAL: this container is the ENGINE image but it is running as a web service."
  echo "[engine]   The dashboard has its own image. On this Render service, set"
  echo "[engine]   Settings → Build & Deploy → Dockerfile Path = ./Dockerfile"
  echo "[engine]   (the background worker keeps ./Dockerfile.engine). Exiting."
  exit 1
fi

if [ -z "$DATABASE_URL" ]; then
  echo "[engine] FATAL: DATABASE_URL is not set. Configure it (plus WALLET_ENCRYPTION_KEY and SOLANA_RPC_URL) on this service."
  sleep 5
  exit 1
fi

# Schema application needs a DIRECT connection. If DIRECT_URL is not set, derive
# it from DATABASE_URL: Neon's pooled endpoint (host contains "-pooler") cannot
# run the DDL `prisma db push` needs, so strip "-pooler" to reach the direct
# endpoint. Plain/already-direct Postgres URLs are used as-is. This matches the
# web entrypoint so the engine deploys with ONLY DATABASE_URL configured.
if [ -z "$DIRECT_URL" ]; then
  case "$DATABASE_URL" in
    *-pooler.*)
      DIRECT_URL=$(printf '%s' "$DATABASE_URL" | sed 's/-pooler\./\./')
      echo "[engine] derived DIRECT_URL from DATABASE_URL (removed -pooler) for schema application"
      ;;
    *)
      DIRECT_URL="$DATABASE_URL"
      ;;
  esac
  export DIRECT_URL
fi

echo "[engine] applying database schema…"
attempt=1
max=6
# Invoke Prisma via its real module path (see web entrypoint) so the schema
# engine's wasm resolves correctly regardless of how .bin/prisma was packaged.
until node node_modules/prisma/build/index.js db push --skip-generate; do
  if [ "$attempt" -ge "$max" ]; then
    echo "[engine] FATAL: could not apply the database schema after $max attempts — exiting for supervisor restart."
    exit 1
  fi
  wait=$((attempt * 5))
  echo "[engine] schema push failed (attempt $attempt/$max) — retrying in ${wait}s…"
  sleep "$wait"
  attempt=$((attempt + 1))
done

echo "[engine] starting trading engine worker"
# Run node as PID 1 (via `exec`) with tsx as a loader — NOT `npx tsx`, which
# spawns node as a grandchild and does not forward SIGTERM. Direct node ensures
# Render's SIGTERM reaches the engine's shutdown handler for a graceful stop
# (finish in-flight work, close DB) before the platform's SIGKILL grace window.
exec node --import tsx src/engine/index.ts
