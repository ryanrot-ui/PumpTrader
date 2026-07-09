import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { hashPassword } from "@/lib/auth";
import { registerSchema } from "@/lib/validation";
import { rateLimit, clientIp } from "@/lib/rateLimit";

/**
 * Single-administrator bootstrap. Registration works exactly once — to
 * create the admin account on first run — and is permanently disabled the
 * moment any account exists. There is no public registration.
 * (Locked out? See scripts/reset-admin.ts.)
 */
export async function POST(req: Request) {
  if (!(await rateLimit(`register:${clientIp(req)}`, 5, 3600))) {
    return NextResponse.json({ error: "Too many attempts" }, { status: 429 });
  }

  const body = await req.json().catch(() => null);
  const parsed = registerSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid input" },
      { status: 400 }
    );
  }

  try {
    const existingUsers = await prisma.user.count();
    if (existingUsers > 0) {
      return NextResponse.json(
        { error: "Registration is disabled — administrator account already exists" },
        { status: 403 }
      );
    }

    const email = parsed.data.email.toLowerCase().trim();
    const passwordHash = await hashPassword(parsed.data.password);
    // One transaction: the admin account is never created without its
    // default settings row (paper trading ON, bot OFF).
    await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({ data: { email, passwordHash } });
      await tx.settings.create({ data: { userId: user.id } });
      await tx.logEntry.create({
        data: { level: "info", source: "api", message: `administrator account created: ${email}` },
      });
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    // Surface infrastructure problems honestly instead of a generic failure.
    // P2021 = table does not exist → the schema was never applied (the classic
    // Neon-pooler first-boot failure); anything else → DB unreachable.
    const code = (e as { code?: string }).code;
    console.error("[register] failed:", code ?? "", (e as Error).message);
    const schemaMissing = code === "P2021";
    return NextResponse.json(
      {
        error: schemaMissing
          ? "The database schema is not initialized. The app applies it automatically at boot — check the deploy logs for a schema-push error (on Neon, set DIRECT_URL to the non-pooled endpoint)."
          : "The server cannot reach its database. Check DATABASE_URL and the deployment logs.",
      },
      { status: 503 }
    );
  }
}
