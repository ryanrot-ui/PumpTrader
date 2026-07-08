import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

/**
 * Unauthenticated liveness/readiness probe for platform health checks.
 * Returns 200 whenever the web process can serve requests, and reports:
 *  - database:    can we reach PostgreSQL at all?
 *  - schemaReady: has the Prisma schema been applied (User table present)?
 * A DB blip never fails the process, but schemaReady:false is the precise
 * signal for the "table does not exist" first-boot condition.
 */
export async function GET() {
  let database = false;
  let schemaReady = false;
  try {
    await prisma.$queryRaw`SELECT 1`;
    database = true;
    // to_regclass returns null when the table does not exist (no error thrown)
    const rows = await prisma.$queryRaw<{ exists: boolean }[]>`
      SELECT to_regclass('public."User"') IS NOT NULL AS exists`;
    schemaReady = rows[0]?.exists === true;
  } catch {
    /* reported via the flags above */
  }
  return NextResponse.json({ ok: true, database, schemaReady });
}
