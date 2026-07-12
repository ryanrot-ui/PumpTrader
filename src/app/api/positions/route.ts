import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser, unauthorized } from "@/lib/session";
import { dbGuard } from "@/lib/dbGuard";

async function handleGet(req: Request) {
  const user = await requireUser();
  if (!user) return unauthorized();

  const { searchParams } = new URL(req.url);
  const status = searchParams.get("status"); // OPEN | CLOSED | null (all)

  const positions = await prisma.position.findMany({
    where: status ? { status } : undefined,
    orderBy: { openedAt: "desc" },
    take: 100,
    include: { trades: { orderBy: { createdAt: "asc" } } },
  });
  return NextResponse.json(positions);
}

export const GET = dbGuard(handleGet);
