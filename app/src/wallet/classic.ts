/**
 * "Conectar mi wallet": any Stellar wallet the user already has (Freighter,
 * LOBSTR, xBull, HOT, Albedo…) through Stellar Wallets Kit. The wallet signs
 * in its own app or extension; Kyros never sees its keys.
 */
import { Operation, TransactionBuilder, xdr } from '@stellar/stellar-sdk';
import { StellarWalletsKit } from '@creit.tech/stellar-wallets-kit/sdk';
import { defaultModules } from '@creit.tech/stellar-wallets-kit/modules/utils';
import { Networks } from '@creit.tech/stellar-wallets-kit/types';
import type { Chain } from '../chain';
import type { Wallet } from './types';

let started = false;

export async function connectClassicWallet(chain: Chain): Promise<Wallet> {
  if (!started) {
    StellarWalletsKit.init({ modules: defaultModules(), network: Networks.TESTNET });
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
  const trust = async (which: 'usd' | 'eur') => {
    const tx = new TransactionBuilder(await chain.server.getAccount(address), { fee: '1000', networkPassphrase: chain.cfg.networkPassphrase })
      .addOperation(Operation.changeTrust({ asset: chain.asset(which) }))
      .setTimeout(120)
      .build();
    const { signedTxXdr } = await StellarWalletsKit.signTransaction(tx.toXDR(), { networkPassphrase: chain.cfg.networkPassphrase, address });
    await chain.submit(TransactionBuilder.fromXDR(signedTxXdr, chain.cfg.networkPassphrase) as never);
  };
  if (!(await hasTrust(chain, address))) {
    await trust('usd');
    await trust('eur');
  }
  return wallet;
}

async function hasTrust(chain: Chain, address: string): Promise<boolean> {
  try {
    const r = await fetch(`https://horizon-testnet.stellar.org/accounts/${address}`);
    const a = (await r.json()) as { balances?: { asset_code?: string; asset_issuer?: string }[] };
    const t = chain.cfg.tokens;
    return !!a.balances?.some((b) => b.asset_code === t.usd.code && b.asset_issuer === t.usd.issuer);
  } catch {
    return false;
  }
}
