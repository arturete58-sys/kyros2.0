/**
 * "Conectar mi wallet": any wallet that signs on Stellar, through Stellar
 * Wallets Kit: LOBSTR, xBull, Freighter, Albedo, Hana, Rabet, Klever,
 * Scopuly, multichain wallets (MetaMask, Bitget, OneKey, HOT) and Ledger.
 * The wallet signs in its own app or extension; Kyros never sees its keys.
 */
import { Operation, TransactionBuilder, xdr } from '@stellar/stellar-sdk';
import { StellarWalletsKit } from '@creit.tech/stellar-wallets-kit/sdk';
import { defaultModules } from '@creit.tech/stellar-wallets-kit/modules/utils';
import { HotWalletModule } from '@creit.tech/stellar-wallets-kit/modules/hotwallet';
import { LedgerModule } from '@creit.tech/stellar-wallets-kit/modules/ledger';
import { Networks } from '@creit.tech/stellar-wallets-kit/types';
import type { Chain } from '../chain';
import type { Wallet } from './types';

let started = false;

export async function connectClassicWallet(chain: Chain): Promise<Wallet> {
  if (!started) {
    // The defaults plus HOT (multichain) and Ledger, which need the Buffer polyfill the app already has.
    StellarWalletsKit.init({ modules: [...defaultModules(), new HotWalletModule(), new LedgerModule()], network: Networks.TESTNET });
    started = true;
  }
  const { address } = await StellarWalletsKit.authModal();
  // Testnet: make sure the account exists and can hold the test tokens.
  await chain.ensureAccount(address);
  const wallet: Wallet = {
    kind: 'classic',
    address,
    label: StellarWalletsKit.selectedModule?.productName ?? 'Wallet',
    async signAndSend(op: xdr.Operation): Promise<string> {
      const tx = await chain.client.prepare(address, op);
      const { signedTxXdr } = await StellarWalletsKit.signTransaction(tx.toXDR(), { networkPassphrase: chain.cfg.networkPassphrase, address });
      return chain.submit(TransactionBuilder.fromXDR(signedTxXdr, chain.cfg.networkPassphrase) as never);
    },
    async disconnect() {
      await StellarWalletsKit.disconnect();
    },
  };
  // Payments to a classic account need trustlines for the test tokens.
  const trust = async (which: 'usd' | 'eur' | 'usdc') => {
    const tx = new TransactionBuilder(await chain.server.getAccount(address), { fee: '1000', networkPassphrase: chain.cfg.networkPassphrase })
      .addOperation(Operation.changeTrust({ asset: chain.asset(which) }))
      .setTimeout(120)
      .build();
    const { signedTxXdr } = await StellarWalletsKit.signTransaction(tx.toXDR(), { networkPassphrase: chain.cfg.networkPassphrase, address });
    await chain.submit(TransactionBuilder.fromXDR(signedTxXdr, chain.cfg.networkPassphrase) as never);
  };
  const have = await trusted(chain, address);
  const wanted: ('usd' | 'eur' | 'usdc')[] = chain.cfg.cctp ? ['usd', 'eur', 'usdc'] : ['usd', 'eur'];
  for (const which of wanted) if (!have.has(which)) await trust(which);
  return wallet;
}

/** Which of the app's tokens the account already trusts. */
async function trusted(chain: Chain, address: string): Promise<Set<'usd' | 'eur' | 'usdc'>> {
  const out = new Set<'usd' | 'eur' | 'usdc'>();
  try {
    const r = await fetch(`https://horizon-testnet.stellar.org/accounts/${address}`);
    const a = (await r.json()) as { balances?: { asset_code?: string; asset_issuer?: string }[] };
    const tokens = { usd: chain.cfg.tokens.usd, eur: chain.cfg.tokens.eur, ...(chain.cfg.cctp ? { usdc: chain.cfg.cctp.usdc } : {}) };
    for (const [k, t] of Object.entries(tokens)) if (a.balances?.some((b) => b.asset_code === t.code && b.asset_issuer === t.issuer)) out.add(k as 'usd' | 'eur' | 'usdc');
  } catch {
    /* treat as none: changeTrust on an existing trustline is harmless */
  }
  return out;
}
