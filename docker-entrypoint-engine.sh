#!/bin/sh
# Engine container entrypoint. The engine cannot function without its database,
# so the schema sync is required here too. Uses a DIRECT connection for push
# (Neon's pooled endpoint cannot run the DDL); retries for cold-start; exits
# non-zero on persistent failure so the platform restarts it.

set -e

if [ -z "$DATABASE_URL" ]; then
  echo "[engine] FATAL: DATABASE_URL is not set. Configure it (plus WALLET_ENCRYPTION_KEY and SOLANA_RPC_URL) on this service."
  sleep 5
  exit 1
fi

export DIRECT_URL="${DIRECT_URL:-$DATABASE_URL}"

echo "[engine] applying database schema…"
attempt=1
max=6
until npx prisma db push --skip-generate; do
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
exec npx tsx src/engine/index.ts
