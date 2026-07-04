import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser, unauthorized } from "@/lib/session";

export async function GET(req: Request) {
  const user = await requireUser();
  if (!user) return unauthorized();

  const { searchParams } = new URL(req.url);
  const limit = Math.min(parseInt(searchParams.get("limit") ?? "100", 10) || 100, 500);
  const level = searchParams.get("level");

  const logs = await prisma.logEntry.findMany({
    where: level ? { level } : undefined,
    orderBy: { at: "desc" },
    take: limit,
  });
  return NextResponse.json(logs);
}
