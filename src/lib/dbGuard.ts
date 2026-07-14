import { NextResponse } from "next/server";
import { isTransientDbError, dbErrorSummary } from "./dbErrors";

/**
 * Wrap an API route handler so a transient database outage (Neon compute
 * suspended / connection dropped) answers with a clean 503 JSON instead of
 * an unhandled 500 + stack trace. The dashboard polls several endpoints
 * every few seconds — without this, one Neon blip prints a stack trace per
 * poll per endpoint. Non-transient errors still propagate (real bugs must
 * stay loud).
 */
export function dbGuard<Args extends unknown[]>(
  handler: (...args: Args) => Promise<Response>
): (...args: Args) => Promise<Response> {
  return async (...args: Args) => {
    try {
      return await handler(...args);
    } catch (e) {
      if (isTransientDbError(e)) {
        // The Prisma client already logs the outage (one throttled line).
        return NextResponse.json(
          { error: "database temporarily unavailable", detail: dbErrorSummary(e) },
          { status: 503, headers: { "Retry-After": "15" } }
        );
      }
      throw e;
    }
  };
}
