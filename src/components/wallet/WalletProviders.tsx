"use client";

import { useCallback, useMemo } from "react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
import type { WalletError } from "@solana/wallet-adapter-base";

/** Custom event fanned out to UI panels when any wallet operation errors. */
export const WALLET_ERROR_EVENT = "pumptrader:wallet-error";

/**
 * Official Solana Wallet Adapter context (Phantom, mainnet).
 *
 * The browser never talks to an RPC endpoint directly — balances and
 * transaction history are fetched by the server — so the endpoint below only
 * satisfies the provider contract and stays within the strict same-origin
 * Content Security Policy. autoConnect restores the session's wallet on
 * reload. Phantom's own security model is never bypassed: the extension
 * prompts for every signature and no key material ever reaches this app.
 *
 * Wallet errors (user rejected the prompt, wallet locked, …) are re-emitted
 * as a DOM event so panels can show a friendly message — the adapter's
 * default behaviour is to silently deselect the wallet and log to console.
 */
export function WalletProviders({ children }: { children: React.ReactNode }) {
  const wallets = useMemo(() => [new PhantomWalletAdapter()], []);
  const endpoint =
    process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
  const onError = useCallback((error: WalletError) => {
    window.dispatchEvent(
      new CustomEvent(WALLET_ERROR_EVENT, {
        detail: { name: error.name, message: error.message },
      })
    );
  }, []);
  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect onError={onError}>
        {children}
      </WalletProvider>
    </ConnectionProvider>
  );
}
