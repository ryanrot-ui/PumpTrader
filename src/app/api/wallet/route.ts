import { NextResponse } from "next/server";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { encryptSecret } from "@/lib/crypto";
import { verifyWalletProof } from "@/lib/walletVerify";
import { importWalletSchema } from "@/lib/validation";
import { requireUser, unauthorized } from "@/lib/session";
import { rateLimit } from "@/lib/rateLimit";

const conn = new Connection(
  process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com",
  "confirmed"
);

/** List wallets with live balances. Private keys are NEVER returned. */
export async function GET() {
  const user = await requireUser();
  if (!user) return unauthorized();

  const wallets = await prisma.wallet.findMany({
    where: { userId: user.id },
    select: { id: true, publicKey: true, label: true, isWatchOnly: true, createdAt: true },
  });

  const withBalances = await Promise.all(
    wallets.map(async (w) => {
      let solBalance: number | null = null;
      let tokens: Array<{ mint: string; amount: number }> = [];
      let recentTransactions: Array<{ signature: string; at: number | null; err: boolean }> = [];
      try {
        const pk = new PublicKey(w.publicKey);
        solBalance = (await conn.getBalance(pk)) / LAMPORTS_PER_SOL;
        const accounts = await conn.getParsedTokenAccountsByOwner(pk, {
          programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
        });
        tokens = accounts.value
          .map((a) => ({
            mint: a.account.data.parsed.info.mint as string,
            amount: a.account.data.parsed.info.tokenAmount.uiAmount as number,
          }))
          .filter((t) => t.amount > 0)
          .slice(0, 50);
        recentTransactions = (
          await conn.getSignaturesForAddress(pk, { limit: 10 }, "confirmed")
        ).map((s) => ({
          signature: s.signature,
          at: s.blockTime ? s.blockTime * 1000 : null,
          err: s.err !== null,
        }));
      } catch {
        /* RPC hiccup — return nulls, UI shows "unavailable" */
      }
      return { ...w, solBalance, tokens, recentTransactions };
    })
  );

  return NextResponse.json(withBalances);
}

const bodySchema = z.union([
  z.object({ kind: z.literal("import"), payload: importWalletSchema }),
  z.object({
    kind: z.literal("watch"),
    payload: z.object({
      publicKey: z.string().min(32).max(44),
      label: z.string().max(50).optional(),
      // Ownership proof: the wallet signs the message from
      // /api/wallet/verify-message; verified server-side (ed25519).
      message: z.string().min(1).max(500),
      signature: z.string().min(1).max(120),
    }),
  }),
]);

/**
 * kind: "watch"  — link a connected Phantom address (view balances only).
 *                  Requires a signed ownership proof so arbitrary addresses
 *                  can never be attached to the account.
 * kind: "import" — import a dedicated bot wallet secret key. The key is
 *                  encrypted with AES-256-GCM before it touches the database
 *                  and is only decrypted in the engine at signing time.
 */
export async function POST(req: Request) {
  const user = await requireUser();
  if (!user) return unauthorized();
  if (!(await rateLimit(`wallet:${user.id}`, 10, 3600))) {
    return NextResponse.json({ error: "Too many attempts" }, { status: 429 });
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });

  if (parsed.data.kind === "watch") {
    const { publicKey, label, message, signature } = parsed.data.payload;
    try {
      new PublicKey(publicKey); // validate
    } catch {
      return NextResponse.json({ error: "Invalid public key" }, { status: 400 });
    }
    const proof = verifyWalletProof({ publicKey, message, signature }, user.id);
    if (!proof.ok) {
      return NextResponse.json(
        { error: `Wallet verification failed: ${proof.reason}` },
        { status: 400 }
      );
    }
    const wallet = await prisma.wallet.upsert({
      where: { publicKey },
      update: { label: label ?? "Phantom (watch-only)" },
      create: {
        userId: user.id,
        publicKey,
        label: label ?? "Phantom (watch-only)",
        isWatchOnly: true,
      },
    });
    await prisma.logEntry
      .create({
        data: {
          level: "info",
          source: "api",
          message: `wallet connected (watch-only): ${publicKey} by ${user.email}`,
        },
      })
      .catch(() => {});
    return NextResponse.json({ ok: true, publicKey: wallet.publicKey });
  }

  // import bot wallet
  const { secretKey, label } = parsed.data.payload;
  let keypair: Keypair;
  try {
    keypair = Keypair.fromSecretKey(bs58.decode(secretKey.trim()));
  } catch {
    return NextResponse.json(
      { error: "Invalid secret key — expected base58 (Phantom export format)" },
      { status: 400 }
    );
  }

  const wallet = await prisma.wallet.upsert({
    where: { publicKey: keypair.publicKey.toBase58() },
    update: { encryptedKey: encryptSecret(secretKey.trim()), isWatchOnly: false },
    create: {
      userId: user.id,
      publicKey: keypair.publicKey.toBase58(),
      label: label ?? "Bot wallet",
      encryptedKey: encryptSecret(secretKey.trim()),
      isWatchOnly: false,
    },
  });
  // Audit the import — public key only, never any key material.
  await prisma.logEntry
    .create({
      data: {
        level: "info",
        source: "api",
        message: `bot wallet imported (encrypted): ${wallet.publicKey} by ${user.email}`,
      },
    })
    .catch(() => {});
  return NextResponse.json({ ok: true, publicKey: wallet.publicKey });
}

export async function DELETE(req: Request) {
  const user = await requireUser();
  if (!user) return unauthorized();
  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  await prisma.wallet.deleteMany({ where: { id, userId: user.id } });
  return NextResponse.json({ ok: true });
}
