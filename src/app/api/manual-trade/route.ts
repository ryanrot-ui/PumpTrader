import { NextResponse } from "next/server";
import { Connection, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireUser, unauthorized } from "@/lib/session";
import { rateLimit } from "@/lib/rateLimit";
import { registerBuiltTx, txMessageHash } from "@/lib/manualTradePending";

/**
 * Manual Mode, step 1: build an UNSIGNED Jupiter swap transaction for the
 * user's connected Phantom wallet. The server never sees a Phantom key —
 * the transaction is returned to the browser, Phantom shows its approval
 * popup, the user signs, and the signed bytes come back via /submit.
 */

const JUPITER = "https://quote-api.jup.ag/v6";
const WSOL = "So11111111111111111111111111111111111111112";
const conn = new Connection(
  process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com",
  "confirmed"
);

const buildSchema = z.object({
  walletPublicKey: z.string().min(32).max(44),
  mint: z.string().min(32).max(44),
  side: z.enum(["buy", "sell"]),
  // buy: SOL to spend; sell: token base units to sell
  amount: z.number().positive(),
  slippageBps: z.number().int().min(1).max(5000).default(300),
});

export async function POST(req: Request) {
  const user = await requireUser();
  if (!user) return unauthorized();
  if (!(await rateLimit(`manual:${user.id}`, 20, 60))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const parsed = buildSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  const { walletPublicKey, mint, side, amount, slippageBps } = parsed.data;

  try {
    new PublicKey(walletPublicKey);
    new PublicKey(mint);
  } catch {
    return NextResponse.json({ error: "Invalid address" }, { status: 400 });
  }

  // Only trade with wallets the user has explicitly linked to this account
  // (Phantom connect + signed ownership proof, or an imported bot wallet).
  const linked = await prisma.wallet.findFirst({
    where: { userId: user.id, publicKey: walletPublicKey },
  });
  if (!linked) {
    return NextResponse.json(
      { error: "Wallet not linked to this account — connect and verify it first" },
      { status: 403 }
    );
  }

  // Pre-trade safety: wallet must exist and hold enough SOL for the trade + fees
  if (side === "buy") {
    const balance = await conn.getBalance(new PublicKey(walletPublicKey)).catch(() => null);
    if (balance === null) {
      return NextResponse.json({ error: "Could not verify wallet balance" }, { status: 502 });
    }
    if (balance / 1e9 < amount + 0.01) {
      return NextResponse.json(
        { error: `Insufficient balance: ${(balance / 1e9).toFixed(4)} SOL (need ${amount} + fees)` },
        { status: 400 }
      );
    }
  }

  const [inputMint, outputMint, rawAmount] =
    side === "buy" ? [WSOL, mint, Math.round(amount * 1e9)] : [mint, WSOL, Math.round(amount)];

  try {
    const quoteRes = await fetch(
      `${JUPITER}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${rawAmount}&slippageBps=${slippageBps}`,
      { signal: AbortSignal.timeout(8000) }
    );
    if (!quoteRes.ok) {
      // No route usually means: pool gone / token not tradable / no liquidity
      return NextResponse.json(
        { error: "No swap route found — token may not be tradable" },
        { status: 400 }
      );
    }
    const quote = await quoteRes.json();

    const swapRes = await fetch(`${JUPITER}/swap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(8000),
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: walletPublicKey,
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: "auto",
      }),
    });
    if (!swapRes.ok) {
      return NextResponse.json({ error: "Failed to build swap transaction" }, { status: 502 });
    }
    const { swapTransaction } = (await swapRes.json()) as { swapTransaction: string };

    // Register this exact transaction so /submit only relays what we built
    // here (and each build can be submitted at most once).
    const unsigned = VersionedTransaction.deserialize(Buffer.from(swapTransaction, "base64"));
    registerBuiltTx(txMessageHash(unsigned.message.serialize()), {
      userId: user.id,
      mint,
      side,
    });

    return NextResponse.json({
      transaction: swapTransaction,
      expectedOut: quote.outAmount,
      priceImpactPct: quote.priceImpactPct,
    });
  } catch {
    return NextResponse.json({ error: "Swap build failed" }, { status: 502 });
  }
}
