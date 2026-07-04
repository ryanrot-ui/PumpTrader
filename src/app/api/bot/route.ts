import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { redis, KEYS } from "@/lib/redis";
import { requireUser, unauthorized } from "@/lib/session";

export async function GET() {
  const user = await requireUser();
  if (!user) return unauthorized();

  const [status, heartbeat] = await Promise.all([
    redis.get(KEYS.botStatus).catch(() => null),
    redis.get(KEYS.botHeartbeat).catch(() => null),
  ]);
  const beatAge = heartbeat ? Date.now() - parseInt(heartbeat, 10) : null;
  return NextResponse.json({
    status: status ?? "stopped",
    engineAlive: beatAge !== null && beatAge < 20_000,
    lastHeartbeatMsAgo: beatAge,
  });
}

const actionSchema = z.object({
  action: z.enum(["start", "stop", "emergency_stop", "resume"]),
});

export async function POST(req: Request) {
  const user = await requireUser();
  if (!user) return unauthorized();

  const parsed = actionSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  const { action } = parsed.data;

  if (action === "start" || action === "stop") {
    await prisma.settings.upsert({
      where: { userId: user.id },
      update: { botEnabled: action === "start" },
      create: { userId: user.id, botEnabled: action === "start" },
    });
    await redis.publish(KEYS.settingsChannel, "updated").catch(() => {});
  } else {
    // emergency_stop / resume go straight to the engine control channel
    await redis.publish(KEYS.controlChannel, action).catch(() => {});
  }
  return NextResponse.json({ ok: true });
}
