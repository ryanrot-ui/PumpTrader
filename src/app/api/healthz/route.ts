import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

/**
 * Unauthenticated liveness probe for platform health checks (Render, Docker).
 * Returns 200 as long as the web process can serve requests; reports (but
 * does not fail on) database reachability so a DB blip never triggers a
 * restart loop of an otherwise healthy web instance.
 */
export async function GET() {
  let database = false;
  try {
    await prisma.$queryRaw`SELECT 1`;
    database = true;
  } catch {
    /* reported below */
  }
  return NextResponse.json({ ok: true, database });
}
