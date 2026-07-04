import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser, unauthorized } from "@/lib/session";

export async function GET(_req: Request, { params }: { params: { mint: string } }) {
  const user = await requireUser();
  if (!user) return unauthorized();

  const token = await prisma.detectedToken.findUnique({
    where: { mint: params.mint },
    include: {
      scores: { orderBy: { at: "desc" }, take: 20 },
      snapshots: { orderBy: { at: "asc" }, take: 500 },
      trades: { orderBy: { createdAt: "asc" } },
    },
  });
  if (!token) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(token);
}
