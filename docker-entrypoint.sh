#!/bin/sh
# Web container entrypoint.
#
# Applies the Prisma schema, then starts the Next.js standalone server. The
# schema push is best-effort: if DATABASE_URL is unset or the database is not
# reachable yet (e.g. variables not configured on first deploy), we log and
# start the server anyway so the login page still serves and the platform's
# healthcheck passes. Once DATABASE_URL is set, the next boot applies the
# schema. The push is idempotent, so running it every boot is safe.

set -e

if [ -n "$DATABASE_URL" ]; then
  echo "[entrypoint] applying database schema…"
  if ./node_modules/.bin/prisma db push --skip-generate; then
    echo "[entrypoint] schema in sync"
  else
    echo "[entrypoint] WARNING: schema push failed — starting server anyway (check DATABASE_URL / database reachability)"
  fi
else
  echo "[entrypoint] WARNING: DATABASE_URL is not set — the app needs a PostgreSQL database. Starting server so you can reach the site, but API calls will fail until you configure it."
fi

echo "[entrypoint] starting web server on :${PORT:-3000}"
exec node server.js
