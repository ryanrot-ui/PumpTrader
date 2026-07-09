# ── Web app (Next.js) ────────────────────────────────────────────────────────
# Debian-slim (not alpine): Prisma's officially supported runtime — ships with
# the right OpenSSL and libc so the query engine + CLI load reliably.
FROM node:22-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
COPY prisma ./prisma
RUN npm ci --no-audit --no-fund && npx prisma generate

FROM node:22-slim AS builder
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npx prisma generate && npm run build

FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0
# OpenSSL is required by the Prisma query engine at runtime.
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN groupadd -r app && useradd -r -g app app
COPY --from=builder --chown=app:app /app/.next/standalone ./
COPY --from=builder --chown=app:app /app/.next/static ./.next/static
COPY --from=builder --chown=app:app /app/prisma ./prisma
# Full Prisma runtime so `prisma db push` works on boot: the CLI package
# (prisma/build/index.js + prisma_schema_build_bg.wasm), the engines, and the
# generated client (.prisma). The entrypoint invokes the CLI via its real path
# `node node_modules/prisma/build/index.js` — NOT the .bin symlink, which Docker
# dereferences into a plain file and breaks the CLI's wasm asset resolution.
COPY --from=builder --chown=app:app /app/node_modules/prisma ./node_modules/prisma
COPY --from=builder --chown=app:app /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=builder --chown=app:app /app/node_modules/.prisma ./node_modules/.prisma
COPY --chown=app:app docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh
USER app
EXPOSE 3000
# Entry script applies the schema (idempotent, non-fatal if the DB isn't
# reachable yet) then starts the standalone server.
CMD ["./docker-entrypoint.sh"]
