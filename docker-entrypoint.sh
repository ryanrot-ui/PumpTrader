#!/bin/sh
# Web container entrypoint.
#
# Schema management: `prisma db push` is this project's deliberate mechanism —
# it is idempotent, brings a brand-new database (e.g. a fresh Neon instance)
# to the full schema with zero manual steps, and REFUSES destructive changes
# instead of applying them. Running it on every boot is safe.
#
# The push is best-effort for the web container: if the database is not
# reachable yet (first deploy, env not configured), we still start the server
# so the platform health check passes and the operator can see the site; the
# next boot (or the engine container) applies the schema once the DB exists.

set -e

# Render exposes the service's public URL as RENDER_EXTERNAL_URL. NextAuth
# needs it as NEXTAUTH_URL; an explicitly configured NEXTAUTH_URL always wins.
if [ -z "$NEXTAUTH_URL" ] && [ -n "$RENDER_EXTERNAL_URL" ]; then
  export NEXTAUTH_URL="$RENDER_EXTERNAL_URL"
  echo "[entrypoint] NEXTAUTH_URL defaulted to $NEXTAUTH_URL (from RENDER_EXTERNAL_URL)"
fi

if [ -z "$NEXTAUTH_SECRET" ]; then
  echo "[entrypoint] WARNING: NEXTAUTH_SECRET is not set — logins will fail. Generate one with: openssl rand -base64 32"
fi

if [ -n "$DATABASE_URL" ]; then
  echo "[entrypoint] syncing database schema…"
  if ./node_modules/.bin/prisma db push --skip-generate; then
    echo "[entrypoint] schema in sync"
  else
    echo "[entrypoint] WARNING: schema sync failed — starting server anyway (check DATABASE_URL / database reachability)"
  fi
else
  echo "[entrypoint] WARNING: DATABASE_URL is not set — the app needs a PostgreSQL database. Starting server so you can reach the site, but API calls will fail until you configure it."
fi

echo "[entrypoint] starting web server on :${PORT:-3000}"
exec node server.js
