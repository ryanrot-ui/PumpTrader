import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { publish, CHANNELS } from "@/lib/redis";
import { settingsUpdateSchema } from "@/lib/validation";
import { requireUser, unauthorized } from "@/lib/session";
import { dbGuard } from "@/lib/dbGuard";

async function handleGet() {
  const user = await requireUser();
  if (!user) return unauthorized();

  let settings = await prisma.settings.findUnique({ where: { userId: user.id } });
  if (!settings) settings = await prisma.settings.create({ data: { userId: user.id } });
  const { id, userId, updatedAt, ...values } = settings;
  return NextResponse.json(values);
}

async function handlePut(req: Request) {
  const user = await requireUser();
  if (!user) return unauthorized();

  const body = await req.json().catch(() => null);
  const parsed = settingsUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") },
      { status: 400 }
    );
  }

  // Audit which keys changed (configuration changes are always logged)
  const before = await prisma.settings.findUnique({ where: { userId: user.id } });
  const changed = before
    ? Object.entries(parsed.data)
        .filter(([k, v]) => JSON.stringify((before as Record<string, unknown>)[k]) !== JSON.stringify(v))
        .map(([k]) => k)
    : ["(initial)"];

  const data = {
    ...parsed.data,
    // Json columns need the sentinel to store SQL NULL (clears the override)
    scoringWeights: parsed.data.scoringWeights ?? Prisma.DbNull,
    narrativeWeights: parsed.data.narrativeWeights ?? Prisma.DbNull,
  };
  await prisma.settings.upsert({
    where: { userId: user.id },
    update: data,
    create: { userId: user.id, ...data },
  });

  if (changed.length > 0) {
    await prisma.logEntry
      .create({
        data: {
          level: "info",
          source: "api",
          message: `settings changed by ${user.email}: ${changed.join(", ")}`,
        },
      })
      .catch(() => {});
    // Revertible history: every manual change keeps its previous values
    // (safe-learning rule: parameter sets can always be rolled back).
    if (before && changed[0] !== "(initial)") {
      const beforeVals = Object.fromEntries(
        changed.map((k) => [k, (before as Record<string, unknown>)[k] ?? null])
      );
      const afterVals = Object.fromEntries(
        changed.map((k) => [k, (parsed.data as Record<string, unknown>)[k] ?? null])
      );
      await prisma.parameterChange
        .create({
          data: {
            source: "manual",
            changedKeys: changed,
            before: JSON.parse(JSON.stringify(beforeVals)),
            after: JSON.parse(JSON.stringify(afterVals)),
            note: `saved via settings by ${user.email}`,
          },
        })
        .catch(() => {});
    }
  }

  // Tell the engine to hot-reload — no restart needed. (The engine also
  // polls the settings row, so this works without Redis too.)
  publish(CHANNELS.settingsUpdated, "updated");
  return NextResponse.json({ ok: true });
}

export const GET = dbGuard(handleGet);
export const PUT = dbGuard(handlePut);
