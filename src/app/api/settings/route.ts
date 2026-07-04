import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { redis, KEYS } from "@/lib/redis";
import { settingsSchema } from "@/lib/validation";
import { requireUser, unauthorized } from "@/lib/session";

export async function GET() {
  const user = await requireUser();
  if (!user) return unauthorized();

  let settings = await prisma.settings.findUnique({ where: { userId: user.id } });
  if (!settings) settings = await prisma.settings.create({ data: { userId: user.id } });
  const { id, userId, updatedAt, ...values } = settings;
  return NextResponse.json(values);
}

export async function PUT(req: Request) {
  const user = await requireUser();
  if (!user) return unauthorized();

  const body = await req.json().catch(() => null);
  const parsed = settingsSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") },
      { status: 400 }
    );
  }

  await prisma.settings.upsert({
    where: { userId: user.id },
    update: parsed.data,
    create: { userId: user.id, ...parsed.data },
  });

  // Tell the engine to hot-reload — no restart needed.
  await redis.publish(KEYS.settingsChannel, "updated").catch(() => {});
  return NextResponse.json({ ok: true });
}
