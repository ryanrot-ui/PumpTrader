import { NextResponse } from "next/server";
import { buildVerificationMessage } from "@/lib/walletVerify";
import { requireUser, unauthorized } from "@/lib/session";

/**
 * Issues the message the connected wallet must sign before it is linked to
 * the account (see lib/walletVerify.ts). Stateless: the message embeds the
 * account id and an issue timestamp that the verifier checks.
 */
export async function GET() {
  const user = await requireUser();
  if (!user) return unauthorized();
  return NextResponse.json({ message: buildVerificationMessage(user.id, Date.now()) });
}
