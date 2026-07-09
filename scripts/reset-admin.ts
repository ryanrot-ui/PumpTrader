/**
 * Administrator account recovery.
 *
 * This is a single-administrator system: /register works exactly once and is
 * disabled as soon as any account exists. If you are locked out (forgotten
 * password, account created during an earlier deployment attempt, lost 2FA
 * device), run this against the production DATABASE_URL:
 *
 *   npx tsx scripts/reset-admin.ts <email> <new-password> [--disable-2fa]
 *
 * Behaviour:
 *   - no accounts exist          → creates the admin (with default settings)
 *   - account with <email> exists→ resets its password
 *   - a DIFFERENT account exists → prints its email and exits (pass that
 *                                  email to reset it — extra accounts are
 *                                  never created)
 */
import { PrismaClient } from "@prisma/client";
import { hash as argon2Hash } from "@node-rs/argon2";

const ARGON2_OPTS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

async function main(): Promise<void> {
  const [email, password] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const disable2fa = process.argv.includes("--disable-2fa");

  if (!email || !password) {
    console.error("Usage: npx tsx scripts/reset-admin.ts <email> <new-password> [--disable-2fa]");
    process.exit(1);
  }
  if (password.length < 10) {
    console.error("Password must be at least 10 characters.");
    process.exit(1);
  }

  const prisma = new PrismaClient();
  try {
    const normalized = email.toLowerCase().trim();
    const passwordHash = await argon2Hash(password, ARGON2_OPTS);
    const twoFa = disable2fa ? { totpEnabled: false, totpSecret: null } : {};

    const existing = await prisma.user.findUnique({ where: { email: normalized } });
    if (existing) {
      await prisma.user.update({
        where: { id: existing.id },
        data: { passwordHash, ...twoFa },
      });
      console.log(`Password reset for ${normalized}${disable2fa ? " (2FA disabled)" : ""}.`);
    } else {
      const others = await prisma.user.findMany({ select: { email: true } });
      if (others.length > 0) {
        console.error(
          `No account with that email. Existing account(s): ${others.map((u) => u.email).join(", ")}\n` +
            "Re-run with that email to reset its password (this system is single-administrator)."
        );
        process.exit(1);
      }
      await prisma.$transaction(async (tx) => {
        const user = await tx.user.create({ data: { email: normalized, passwordHash } });
        await tx.settings.create({ data: { userId: user.id } });
      });
      console.log(`Administrator account created: ${normalized} (paper trading ON, bot OFF).`);
    }

    await prisma.logEntry
      .create({
        data: { level: "warn", source: "api", message: `admin credentials reset via CLI for ${normalized}` },
      })
      .catch(() => {});
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(`Failed: ${(e as Error).message}`);
  console.error("Check that DATABASE_URL is set and the database is reachable.");
  process.exit(1);
});
