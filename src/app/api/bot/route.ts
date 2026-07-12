import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { publish, CHANNELS } from "@/lib/redis";
import { engineAlive, getEngineState, requestEngineControl, updateEngineState } from "@/lib/engineState";
import { requireUser, unauthorized } from "@/lib/session";
import { rateLimit } from "@/lib/rateLimit";
import { dbGuard } from "@/lib/dbGuard";

async function handleGet() {
  const user = await requireUser();
  if (!user) return unauthorized();

  const [state, settings] = await Promise.all([
    getEngineState(),
    prisma.settings.findUnique({ where: { userId: user.id } }),
  ]);
  const beatAge = state?.heartbeatAt ? Date.now() - state.heartbeatAt.getTime() : null;
  return NextResponse.json({
    status: state?.status ?? "stopped",
    engineAlive: engineAlive(state?.heartbeatAt),
    lastHeartbeatMsAgo: beatAge,
    readOnly: state?.readOnly ?? false,
    // Trading mode indicator: AUTO = the engine trades with the imported bot
    // wallet; MANUAL = bot disabled, trades only via Phantom approval.
    mode: settings?.botEnabled ? "auto" : "manual",
    paperTrading: settings?.paperTrading ?? true,
  });
}

const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.enum(["start", "stop", "emergency_stop", "resume", "read_only_on", "read_only_off"]) }),
  z.object({
    action: z.literal("set_mode"),
    paperTrading: z.boolean(),
    // Switching to live trading requires an explicit confirmation flag set by
    // the UI's confirmation dialog — a plain toggle click can never go live.
    confirmLive: z.boolean().optional(),
  }),
]);

async function handlePost(req: Request) {
  const user = await requireUser();
  if (!user) return unauthorized();
  if (!(await rateLimit(`bot:${user.id}`, 30, 60))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const parsed = actionSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  const body = parsed.data;
  const { action } = body;

  if (action === "set_mode") {
    if (!body.paperTrading) {
      if (body.confirmLive !== true) {
        return NextResponse.json(
          { error: "Live trading requires explicit confirmation" },
          { status: 400 }
        );
      }
      // Live mode is unusable (and dangerous to half-enable) without a bot
      // wallet the engine can sign with.
      const botWallet = await prisma.wallet.findFirst({
        where: { userId: user.id, isWatchOnly: false, encryptedKey: { not: null } },
      });
      if (!botWallet) {
        return NextResponse.json(
          { error: "Import a dedicated bot wallet (Settings → Wallets) before enabling live trading" },
          { status: 400 }
        );
      }
    }
    await prisma.settings.upsert({
      where: { userId: user.id },
      update: { paperTrading: body.paperTrading },
      create: { userId: user.id, paperTrading: body.paperTrading },
    });
    publish(CHANNELS.settingsUpdated, "updated");
  } else if (action === "start" || action === "stop") {
    await prisma.settings.upsert({
      where: { userId: user.id },
      update: { botEnabled: action === "start" },
      create: { userId: user.id, botEnabled: action === "start" },
    });
    publish(CHANNELS.settingsUpdated, "updated");
  } else if (action === "read_only_on" || action === "read_only_off") {
    // Read-only mode: engine observes and scores but executes nothing.
    await updateEngineState({ readOnly: action === "read_only_on" });
  } else {
    // emergency_stop / resume: DB control queue (engine consumes within ~5s)
    // plus the Redis fast path when configured.
    await requestEngineControl(action);
    publish(CHANNELS.control, action);
  }

  const description =
    action === "set_mode"
      ? `trading mode set to ${body.paperTrading ? "PAPER" : "LIVE (confirmed)"}`
      : `bot control: ${action}`;
  await prisma.logEntry
    .create({
      data: {
        level: action === "emergency_stop" ? "warn" : "info",
        source: "api",
        message: `${description} (by ${user.email})`,
      },
    })
    .catch(() => {});
  return NextResponse.json({ ok: true });
}

export const GET = dbGuard(handleGet);
export const POST = dbGuard(handlePost);
