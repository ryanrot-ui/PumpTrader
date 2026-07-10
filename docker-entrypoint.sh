#!/bin/sh
# Web container entrypoint.
#
# Root-cause fix for "table public.User does not exist" on first boot:
#   1. Schema application (`prisma db push`) needs a DIRECT database connection.
#      Neon's DEFAULT connection string is the POOLED endpoint (…-pooler…),
#      and PgBouncer cannot take the advisory lock / run the DDL that push
#      needs — so push failed and the database was left with no tables while
#      the app (which queries fine over the pooler) started and served
#      registration against missing tables. We now run push against DIRECT_URL
#      (the non-pooled endpoint; falls back to DATABASE_URL for plain Postgres).
#   2. The push used to be best-effort/non-fatal, so that failure was swallowed
#      and the app served anyway. Now, when DATABASE_URL is configured, the
#      schema MUST apply (with retries for Neon cold-start) or the container
#      exits non-zero so the platform restarts it — the app never serves with
#      an un-initialized schema.

set -e

# Guard against the classic misdeployment: pointing a Background Worker at
# this image. This is the WEB image — a minimal Next.js standalone build that
# does not contain the engine code — so running it on a worker silently gives
# you a second web server and no trading engine. Fail loudly instead.
if [ "$RENDER_SERVICE_TYPE" = "worker" ] || [ "$SERVICE_TYPE" = "engine" ]; then
  echo "[entrypoint] FATAL: this container is the WEB image but it is running as a background worker."
  echo "[entrypoint]   The trading engine has its own image. On this Render service, set"
  echo "[entrypoint]   Settings → Build & Deploy → Dockerfile Path = ./Dockerfile.engine"
  echo "[entrypoint]   (the web service keeps ./Dockerfile). Exiting."
  exit 1
fi

# Render exposes the public URL as RENDER_EXTERNAL_URL; NextAuth needs it as
# NEXTAUTH_URL. An explicitly configured NEXTAUTH_URL always wins.
if [ -z "$NEXTAUTH_URL" ] && [ -n "$RENDER_EXTERNAL_URL" ]; then
  export NEXTAUTH_URL="$RENDER_EXTERNAL_URL"
  echo "[entrypoint] NEXTAUTH_URL defaulted to $NEXTAUTH_URL (from RENDER_EXTERNAL_URL)"
fi
if [ -z "$NEXTAUTH_URL" ]; then
  echo "[entrypoint] WARNING: NEXTAUTH_URL is not set and RENDER_EXTERNAL_URL is unavailable — set NEXTAUTH_URL to your public https origin or logins will fail."
elif [ "${NEXTAUTH_URL#https://}" = "$NEXTAUTH_URL" ] && [ "${NEXTAUTH_URL#http://localhost}" != "$NEXTAUTH_URL" ]; then
  : # localhost http is fine for local dev
elif [ "${NEXTAUTH_URL#https://}" = "$NEXTAUTH_URL" ]; then
  echo "[entrypoint] WARNING: NEXTAUTH_URL ($NEXTAUTH_URL) is not https — Secure cookies require an https origin in production."
fi

if [ -z "$NEXTAUTH_SECRET" ]; then
  echo "[entrypoint] WARNING: NEXTAUTH_SECRET is not set — logins will fail. Generate one with: openssl rand -base64 32"
fi

if [ -z "$DATABASE_URL" ]; then
  echo "[entrypoint] WARNING: DATABASE_URL is not set — the app needs PostgreSQL. Starting the server so the site loads, but all data operations will fail until you configure it."
else
  # Schema application uses a DIRECT connection. Prisma reads it from the schema
  # via DIRECT_URL. If DIRECT_URL is not set, derive it automatically:
  #   - Neon pooled URL (host contains "-pooler") → strip "-pooler" to get the
  #     direct endpoint, so schema init works with ONLY DATABASE_URL configured.
  #   - otherwise → use DATABASE_URL as-is (plain Postgres / already-direct URL).
  if [ -z "$DIRECT_URL" ]; then
    case "$DATABASE_URL" in
      *-pooler.*)
        DIRECT_URL=$(printf '%s' "$DATABASE_URL" | sed 's/-pooler\./\./')
        echo "[entrypoint] derived DIRECT_URL from DATABASE_URL (removed -pooler) for schema application"
        ;;
      *)
        DIRECT_URL="$DATABASE_URL"
        ;;
    esac
    export DIRECT_URL
  fi

  echo "[entrypoint] applying database schema (idempotent, non-destructive)…"
  attempt=1
  max=6
  # Invoke the Prisma CLI via its real module path, NOT node_modules/.bin/prisma.
  # The .bin entry is a symlink to ../prisma/build/index.js; Docker's COPY
  # dereferences it into a plain file in the standalone image, so the CLI would
  # resolve its assets relative to .bin and fail with
  # "ENOENT … /app/node_modules/.bin/prisma_schema_build_bg.wasm". Calling
  # build/index.js directly keeps __dirname at prisma/build, where the wasm is.
  until node node_modules/prisma/build/index.js db push --skip-generate; do
    if [ "$attempt" -ge "$max" ]; then
      echo "[entrypoint] FATAL: could not apply the database schema after $max attempts."
      echo "[entrypoint]   Check DATABASE_URL/DIRECT_URL and that the database is reachable."
      echo "[entrypoint]   Exiting so the platform restarts this container rather than serving with an un-initialized schema."
      exit 1
    fi
    wait=$((attempt * 5))
    echo "[entrypoint] schema push failed (attempt $attempt/$max) — retrying in ${wait}s (Neon databases can cold-start)…"
    sleep "$wait"
    attempt=$((attempt + 1))
  done
  echo "[entrypoint] schema in sync"
fi

echo "[entrypoint] starting web server on :${PORT:-3000}"
exec node server.js
