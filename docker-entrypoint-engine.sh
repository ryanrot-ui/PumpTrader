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

# Same DIRECT_URL derivation as the web entrypoint: a pooled Neon url cannot
# run the DDL push, so strip "-pooler" from the host when DIRECT_URL is unset.
if [ -z "$DIRECT_URL" ]; then
  case "$DATABASE_URL" in
    *-pooler.*)
      DIRECT_URL=$(printf '%s' "$DATABASE_URL" | sed 's/-pooler\./\./')
      echo "[engine] DATABASE_URL is a pooled Neon endpoint — derived DIRECT_URL (host without -pooler) for the schema push. Set DIRECT_URL explicitly to override."
      ;;
    *) DIRECT_URL="$DATABASE_URL" ;;
  esac
fi
export DIRECT_URL

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
