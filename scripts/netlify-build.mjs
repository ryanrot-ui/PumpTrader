#!/usr/bin/env node
/**
 * Netlify build entry (see netlify.toml). Makes a fresh GitHub → Netlify
 * deploy fully automatic:
 *
 *   1. Validates required environment variables with actionable messages —
 *      a misconfigured deploy fails HERE, at build time, with instructions,
 *      never at runtime with a generic error.
 *   2. Derives DIRECT_URL from a pooled Neon DATABASE_URL (host without
 *      "-pooler") — `prisma db push` needs a direct connection because
 *      PgBouncer cannot run the DDL it requires.
 *   3. Applies the database schema (`prisma db push`, idempotent and
 *      non-destructive, with retries for Neon cold starts). No shell access
 *      or manual database commands are ever needed.
 *   4. Generates the Prisma client and builds the Next.js app.
 */
import { execSync } from "node:child_process";

const errors = [];
const warnings = [];

const db = process.env.DATABASE_URL;
if (!db) {
  errors.push(
    "DATABASE_URL is not set. Create a free PostgreSQL database at https://neon.tech, copy its connection string (the default pooled one is fine), and add it in Netlify → Site configuration → Environment variables."
  );
} else if (!/^postgres(ql)?:\/\//.test(db)) {
  errors.push("DATABASE_URL must be a postgresql:// connection string.");
}

const nas = process.env.NEXTAUTH_SECRET;
if (!nas) {
  errors.push("NEXTAUTH_SECRET is not set — logins cannot work without it. Generate one with: openssl rand -base64 32");
} else if (nas.length < 16) {
  errors.push("NEXTAUTH_SECRET is too short — use a strong random value: openssl rand -base64 32");
}

const wek = process.env.WALLET_ENCRYPTION_KEY;
if (!wek) {
  errors.push(
    "WALLET_ENCRYPTION_KEY is not set — it encrypts wallet keys and 2FA secrets at rest. Generate one with: openssl rand -hex 32"
  );
} else if (!/^[0-9a-fA-F]{64}$/.test(wek)) {
  errors.push("WALLET_ENCRYPTION_KEY must be exactly 64 hex characters: openssl rand -hex 32");
}

if (!process.env.SOLANA_RPC_URL) {
  warnings.push(
    "SOLANA_RPC_URL is not set — falling back to the public mainnet RPC, which rate-limits the scanner within seconds. Use a dedicated RPC (Helius/Triton/QuickNode) for real use."
  );
}

for (const w of warnings) console.warn(`\n⚠ ${w}`);
if (errors.length > 0) {
  console.error("\n✖ Deployment configuration is incomplete:\n");
  for (const e of errors) console.error(`  • ${e}\n`);
  console.error("Fix the variables above in Netlify → Site configuration → Environment variables, then retry the deploy.\n");
  process.exit(1);
}

// Schema application needs a DIRECT connection; Neon's pooled endpoint
// (PgBouncer) cannot run it. Derive the direct endpoint automatically.
if (!process.env.DIRECT_URL) {
  if (db.includes("-pooler.")) {
    process.env.DIRECT_URL = db.replace("-pooler.", ".");
    console.log("[build] DATABASE_URL is a pooled Neon endpoint — derived DIRECT_URL (host without -pooler) for the schema push.");
  } else {
    process.env.DIRECT_URL = db;
  }
}

const run = (cmd) => execSync(cmd, { stdio: "inherit", env: process.env });

run("npx prisma generate");

console.log("[build] applying database schema (idempotent, non-destructive)…");
const MAX = 5;
for (let attempt = 1; ; attempt++) {
  try {
    run("npx prisma db push --skip-generate");
    console.log("[build] schema in sync");
    break;
  } catch {
    if (attempt >= MAX) {
      console.error(
        "\n✖ Could not apply the database schema after " + MAX + " attempts.\n" +
          "  Check that DATABASE_URL is correct and the database is reachable from Netlify.\n" +
          "  On Neon, make sure the project is active (free-tier databases suspend when idle — the retries above normally cover the cold start).\n"
      );
      process.exit(1);
    }
    const wait = attempt * 5;
    console.warn(`[build] schema push failed (attempt ${attempt}/${MAX}) — retrying in ${wait}s (Neon cold start)…`);
    execSync(`sleep ${wait}`);
  }
}

run("npx next build");
