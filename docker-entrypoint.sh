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
  # Schema application uses a DIRECT connection. Prisma reads directUrl from the
  # schema via DIRECT_URL. When no separate direct endpoint is provided:
  #   - a Neon POOLED url (…-pooler…) cannot run DDL, so derive the direct
  #     endpoint automatically by stripping "-pooler" from the host — a fresh
  #     deploy works with just the single connection string Neon hands out;
  #   - anything else (plain Postgres, already-direct Neon) is used as-is.
  if [ -z "$DIRECT_URL" ]; then
    case "$DATABASE_URL" in
      *-pooler.*)
        DIRECT_URL=$(printf '%s' "$DATABASE_URL" | sed 's/-pooler\./\./')
        echo "[entrypoint] DATABASE_URL is a pooled Neon endpoint — derived DIRECT_URL (host without -pooler) for the schema push. Set DIRECT_URL explicitly to override."
        ;;
      *) DIRECT_URL="$DATABASE_URL" ;;
    esac
  fi
  export DIRECT_URL
  case "$DIRECT_URL" in
    *-pooler.*) echo "[entrypoint] WARNING: DIRECT_URL still points at a POOLED endpoint (…-pooler…). Prisma db push may fail — use the non-pooled Neon host for DIRECT_URL." ;;
  esac

  echo "[entrypoint] applying database schema (idempotent, non-destructive)…"
  attempt=1
  max=6
  until ./node_modules/.bin/prisma db push --skip-generate; do
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
