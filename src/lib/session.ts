import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "./auth";
import { prisma } from "./prisma";

export interface SessionUser {
  id: string;
  email: string | null;
  name: string | null;
}

/**
 * Resolve the authenticated user for an API route, or null.
 *
 * JWT-only — no database round-trip. The session token is signed and already
 * carries id/email/name, so hitting the User table here would add one query
 * to EVERY API request (needless load on Neon Free) and make every dashboard
 * poll fail while the database is briefly unreachable, even for endpoints
 * that could still answer. Routes that need fresh DB fields (e.g. 2FA
 * secrets) use requireDbUser() below.
 */
export async function requireUser(): Promise<SessionUser | null> {
  const session = await getServerSession(authOptions);
  const u = session?.user as { id?: string; email?: string | null; name?: string | null } | undefined;
  if (!u?.id) return null;
  return { id: u.id, email: u.email ?? null, name: u.name ?? null };
}

/** Like requireUser, but returns the full database row — for routes that
 *  need columns beyond the JWT claims (TOTP secrets, password hash). */
export async function requireDbUser() {
  const user = await requireUser();
  if (!user) return null;
  return prisma.user.findUnique({ where: { id: user.id } });
}

export function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}
