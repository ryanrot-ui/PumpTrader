#!/bin/sh
# Engine container entrypoint. The engine cannot function without its database,
# so here the schema push IS required — if it fails we exit non-zero and let the
# supervisor (Railway restart policy / compose restart: always) retry, which
# also covers the case where the database starts a few seconds after the engine.

set -e

if [ -z "$DATABASE_URL" ]; then
  echo "[engine] FATAL: DATABASE_URL is not set. Configure it (and REDIS_URL, WALLET_ENCRYPTION_KEY, SOLANA_RPC_URL) on this service."
  sleep 5
  exit 1
fi

echo "[engine] applying database schema…"
npx prisma db push --skip-generate

echo "[engine] starting trading engine worker"
exec npx tsx src/engine/index.ts
