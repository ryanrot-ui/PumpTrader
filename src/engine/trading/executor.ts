import {
  Connection,
  Keypair,
  VersionedTransaction,
} from "@solana/web3.js";

/**
 * Swap execution.
 *
 * Live mode routes through the Jupiter aggregator API, which includes every
 * Raydium pool (newly migrated Pump.fun pools are indexed within seconds).
 * Jupiter handles route construction, slippage protection, and returns a
 * ready-to-sign versioned transaction — the private key never leaves this
 * process and is only held in memory while signing.
 *
 * Paper mode fills at the current observed price with a simulated slippage
 * haircut so paper results stay conservative.
 */

const JUPITER = "https://quote-api.jup.ag/v6";
const WSOL = "So11111111111111111111111111111111111111112";
const LAMPORTS = 1_000_000_000;

export interface SwapResult {
  signature: string | null; // null for paper fills
  inAmount: number; // lamports or token base units spent
  outAmount: number; // received, base units
  priceImpactPct: number | null;
  paper: boolean;
}

export interface Executor {
  buy(mint: string, amountSol: number, maxSlippageBps: number): Promise<SwapResult>;
  sell(mint: string, tokenBaseUnits: number, maxSlippageBps: number): Promise<SwapResult>;
}

// ── Live executor (Jupiter) ─────────────────────────────────────────────────

interface JupiterQuote {
  inAmount: string;
  outAmount: string;
  priceImpactPct: string;
  [k: string]: unknown;
}

export class LiveExecutor implements Executor {
  constructor(
    private conn: Connection,
    private getSigner: () => Keypair // resolved lazily; key stays encrypted at rest
  ) {}

  async buy(mint: string, amountSol: number, maxSlippageBps: number): Promise<SwapResult> {
    return this.swap(WSOL, mint, Math.round(amountSol * LAMPORTS), maxSlippageBps);
  }

  async sell(mint: string, tokenBaseUnits: number, maxSlippageBps: number): Promise<SwapResult> {
    return this.swap(mint, WSOL, Math.round(tokenBaseUnits), maxSlippageBps);
  }

  private async swap(
    inputMint: string,
    outputMint: string,
    amount: number,
    slippageBps: number
  ): Promise<SwapResult> {
    const quoteRes = await fetch(
      `${JUPITER}/quote?inputMint=${inputMint}&outputMint=${outputMint}` +
        `&amount=${amount}&slippageBps=${slippageBps}&onlyDirectRoutes=false`,
      { signal: AbortSignal.timeout(8000) }
    );
    if (!quoteRes.ok) throw new Error(`jupiter quote HTTP ${quoteRes.status}`);
    const quote = (await quoteRes.json()) as JupiterQuote;

    const signer = this.getSigner();
    const swapRes = await fetch(`${JUPITER}/swap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(8000),
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: signer.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: "auto",
      }),
    });
    if (!swapRes.ok) throw new Error(`jupiter swap HTTP ${swapRes.status}`);
    const { swapTransaction } = (await swapRes.json()) as { swapTransaction: string };

    const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, "base64"));
    tx.sign([signer]);

    const signature = await this.conn.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
    });
    const conf = await this.conn.confirmTransaction(signature, "confirmed");
    if (conf.value.err) throw new Error(`swap failed on-chain: ${JSON.stringify(conf.value.err)}`);

    return {
      signature,
      inAmount: Number(quote.inAmount),
      outAmount: Number(quote.outAmount),
      priceImpactPct: parseFloat(quote.priceImpactPct) || null,
      paper: false,
    };
  }
}

// ── Paper executor ──────────────────────────────────────────────────────────

export class PaperExecutor implements Executor {
  constructor(
    private getPriceUsd: (mint: string) => Promise<number | null>,
    private getSolPriceUsd: () => Promise<number>,
    /** simulated slippage haircut applied to every paper fill */
    private simulatedSlippagePct = 1.5
  ) {}

  async buy(mint: string, amountSol: number, _maxSlippageBps: number): Promise<SwapResult> {
    const price = await this.getPriceUsd(mint);
    const sol = await this.getSolPriceUsd();
    if (!price || price <= 0) throw new Error("paper buy: no price available");
    const usd = amountSol * sol;
    const tokens = (usd / price) * (1 - this.simulatedSlippagePct / 100);
    return {
      signature: null,
      inAmount: Math.round(amountSol * LAMPORTS),
      outAmount: tokens,
      priceImpactPct: this.simulatedSlippagePct,
      paper: true,
    };
  }

  async sell(mint: string, tokenQty: number, _maxSlippageBps: number): Promise<SwapResult> {
    const price = await this.getPriceUsd(mint);
    const sol = await this.getSolPriceUsd();
    if (!price || price <= 0) throw new Error("paper sell: no price available");
    const usd = tokenQty * price * (1 - this.simulatedSlippagePct / 100);
    return {
      signature: null,
      inAmount: tokenQty,
      outAmount: Math.round((usd / sol) * LAMPORTS),
      priceImpactPct: this.simulatedSlippagePct,
      paper: true,
    };
  }
}
