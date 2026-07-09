import { NextResponse } from "next/server";
import { Connection, VersionedTransaction } from "@solana/web3.js";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireUser, unauthorized } from "@/lib/session";
import { rateLimit } from "@/lib/rateLimit";
import { consumeBuiltTx, txMessageHash } from "@/lib/manualTradePending";

/**
 * Manual Mode, step 2: submit the Phantom-signed transaction. The server
 * only relays already-signed bytes — it cannot alter or re-sign them — and
 * ONLY transactions it built itself in step 1 (message-hash binding, each
 * consumable exactly once, so a double-click can never double-submit and
 * the endpoint cannot relay arbitrary transactions). It then confirms and
 * records the trade with the metadata registered at build time.
 */

const conn = new Connection(
  process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com",
  "confirmed"
);

const submitSchema = z.object({
  signedTransaction: z.string().min(100).max(20_000), // base64
  mint: z.string().min(32).max(44),
  side: z.enum(["buy", "sell"]),
  amountSol: z.number().min(0),
});

export async function POST(req: Request) {
  const user = await requireUser();
  if (!user) return unauthorized();
  if (!(await rateLimit(`manual-submit:${user.id}`, 20, 60))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const parsed = submitSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });

  let tx: VersionedTransaction;
  try {
    tx = VersionedTransaction.deserialize(Buffer.from(parsed.data.signedTransaction, "base64"));
  } catch {
    return NextResponse.json({ error: "Malformed transaction" }, { status: 400 });
  }

  // Must be a transaction this server built in step 1, unconsumed, for this
  // user. Signing does not change the message, so the hash matches.
  const built = consumeBuiltTx(txMessageHash(tx.message.serialize()), user.id);
  if (!built) {
    return NextResponse.json(
      { error: "Unknown or already-submitted transaction — rebuild the trade and try again" },
      { status: 409 }
    );
  }

  try {
    const latest = await conn.getLatestBlockhash("confirmed");
    const signature = await conn.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
    });
    const conf = await conn.confirmTransaction(
      { signature, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight },
      "confirmed"
    );
    if (conf.value.err) {
      return NextResponse.json(
        { error: `Transaction failed on-chain: ${JSON.stringify(conf.value.err)}` },
        { status: 400 }
      );
    }

    // Record with the metadata registered at BUILD time (server-verified),
    // not the client-supplied fields — history cannot be poisoned.
    await prisma.trade.create({
      data: {
        side: built.side.toUpperCase(),
        paper: false,
        mint: built.mint,
        amountSol: parsed.data.amountSol,
        tokenQty: 0, // exact fill amount visible on-chain via the signature
        signature,
        reason: `manual trade via Phantom (approved by ${user.email})`,
      },
    });
    await prisma.logEntry
      .create({
        data: {
          level: "info",
          source: "executor",
          message: `manual ${built.side} executed via Phantom: ${built.mint} (${signature})`,
        },
      })
      .catch(() => {});

    return NextResponse.json({ ok: true, signature });
  } catch (e) {
    // Secure error handling: log the full detail server-side, return a
    // clean message with no stack trace.
    await prisma.logEntry
      .create({
        data: {
          level: "error",
          source: "executor",
          message: `manual trade submit failed: ${(e as Error).message}`,
        },
      })
      .catch(() => {});
    return NextResponse.json({ error: "Transaction submission failed" }, { status: 502 });
  }
}
