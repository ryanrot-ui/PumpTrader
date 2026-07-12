import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser, unauthorized } from "@/lib/session";
import { dbGuard } from "@/lib/dbGuard";

async function handleGet(req: Request) {
  const user = await requireUser();
  if (!user) return unauthorized();

  const { searchParams } = new URL(req.url);
  const limit = Math.min(parseInt(searchParams.get("limit") ?? "50", 10) || 50, 200);

  const trades = await prisma.trade.findMany({
    orderBy: { createdAt: "desc" },
    take: limit,
    include: { token: { select: { mint: true, symbol: true } } },
  });
  return NextResponse.json(trades);
}

export const GET = dbGuard(handleGet);
