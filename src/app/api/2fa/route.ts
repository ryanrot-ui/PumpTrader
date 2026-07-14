import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { encryptSecret, decryptSecret } from "@/lib/crypto";
import { generateTotpSecret, totpUri, verifyTotp } from "@/lib/totp";
// requireDbUser (not requireUser): 2FA needs fresh totpEnabled/totpSecret
// columns, which the JWT deliberately does not carry.
import { requireDbUser, unauthorized } from "@/lib/session";
import { rateLimit } from "@/lib/rateLimit";

export async function GET() {
  const user = await requireDbUser();
  if (!user) return unauthorized();
  return NextResponse.json({ enabled: user.totpEnabled });
}

const bodySchema = z.union([
  z.object({ action: z.literal("setup") }),
  z.object({ action: z.literal("confirm"), code: z.string().min(6).max(8) }),
  z.object({ action: z.literal("disable"), code: z.string().min(6).max(8) }),
]);

/**
 * 2FA lifecycle: setup → returns a fresh secret + otpauth URI (stored
 * encrypted but not yet enforced) → confirm with a valid code to enable →
 * disable requires a valid code. All transitions are audit-logged.
 */
export async function POST(req: Request) {
  const user = await requireDbUser();
  if (!user) return unauthorized();
  if (!(await rateLimit(`2fa:${user.id}`, 10, 900))) {
    return NextResponse.json({ error: "Too many attempts" }, { status: 429 });
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });

  const audit = (message: string) =>
    prisma.logEntry
      .create({ data: { level: "info", source: "api", message } })
      .catch(() => {});

  if (parsed.data.action === "setup") {
    if (user.totpEnabled) {
      return NextResponse.json({ error: "2FA already enabled — disable it first" }, { status: 400 });
    }
    const secret = generateTotpSecret();
    await prisma.user.update({
      where: { id: user.id },
      data: { totpSecret: encryptSecret(secret), totpEnabled: false },
    });
    // The secret is returned exactly once, during setup, over the
    // authenticated HTTPS session — never again afterwards.
    return NextResponse.json({ secret, uri: totpUri(secret, user.email) });
  }

  if (!user.totpSecret) {
    return NextResponse.json({ error: "2FA not set up" }, { status: 400 });
  }
  const secret = decryptSecret(user.totpSecret);
  if (!verifyTotp(secret, parsed.data.code)) {
    return NextResponse.json({ error: "Invalid code" }, { status: 400 });
  }

  if (parsed.data.action === "confirm") {
    await prisma.user.update({ where: { id: user.id }, data: { totpEnabled: true } });
    await audit(`2FA enabled for ${user.email}`);
    return NextResponse.json({ ok: true, enabled: true });
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { totpEnabled: false, totpSecret: null },
  });
  await audit(`2FA disabled for ${user.email}`);
  return NextResponse.json({ ok: true, enabled: false });
}
