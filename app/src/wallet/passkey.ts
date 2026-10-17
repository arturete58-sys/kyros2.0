/**
 * "Entrar con Face ID": a smart wallet secured by the user's passkey, built
 * with the Stellar Development Foundation's passkey-kit. The wallet is a
 * contract only the user's passkey (on their device) can authorize; Kyros
 * holds no key and no funds. The fee payer only sources and pays the
 * transactions; the wallet signs its own authorizations.
 */
import { Address, BASE_FEE, Operation, rpc, Transaction, TransactionBuilder, xdr } from '@stellar/stellar-sdk';
import { t } from '../i18n';
import { MercuryIndexer, PasskeyKit, SignerKey } from 'passkey-kit';
import { IndexedDBStorage } from 'passkey-kit/storage';
import type { Chain } from '../chain';
import type { Wallet } from './types';

function kitFor(chain: Chain): PasskeyKit {
  return new PasskeyKit({
    rpcUrl: chain.cfg.rpcUrl,
    networkPassphrase: chain.cfg.networkPassphrase,
    walletWasmHash: chain.cfg.passkeyWalletWasmHash,
    storage: new IndexedDBStorage(),
  });
}

/** Wraps `func` + `auth` in a transaction sourced and paid by the fee payer, simulated and signed. */
async function feePaid(chain: Chain, func: xdr.HostFunction, auth: xdr.SorobanAuthorizationEntry[]): Promise<string> {
  const fp = chain.feePayer;
  await chain.ensureAccount(fp.publicKey());
  const account = await chain.server.getAccount(fp.publicKey());
  let tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: chain.cfg.networkPassphrase })
    .addOperation(Operation.invokeHostFunction({ func, auth }))
    .setTimeout(60)
    .build();
  tx = await chain.server.prepareTransaction(tx);
  tx.sign(fp);
  return chain.submit(tx);
}

function makeWallet(chain: Chain, kit: PasskeyKit, contractId: string): Wallet {
  return {
    kind: 'passkey',
    address: contractId,
    label: 'Face ID',
    async signAndSend(op: xdr.Operation): Promise<string> {
      const fp = chain.feePayer;
      await chain.ensureAccount(fp.publicKey());
      const account = await chain.server.getAccount(fp.publicKey());
      const draft = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: chain.cfg.networkPassphrase }).addOperation(op).setTimeout(60).build();
      const sim = await chain.server.simulateTransaction(draft);
      if (rpc.Api.isSimulationError(sim)) throw new Error(friendly(sim.error));
      const func = op.body().invokeHostFunctionOp().hostFunction();
      const auth: xdr.SorobanAuthorizationEntry[] = [];
      for (const entry of sim.result?.auth ?? []) {
        const c = entry.credentials();
        const mine = c.switch().name === 'sorobanCredentialsAddress' && Address.fromScAddress(c.address().address()).toString() === contractId;
        // The passkey prompt appears here: the user approves with Face ID / fingerprint.
        auth.push(mine ? await kit.signAuthEntry(entry) : entry);
      }
      return feePaid(chain, func, auth);
    },
    async disconnect() {
      kit.disconnect();
    },
  };
}

/** Creates a new smart wallet with a new passkey. */
export async function createPasskeyWallet(chain: Chain, userName: string): Promise<Wallet> {
  const kit = kitFor(chain);
  const created = await kit.createWallet('Kyros', userName);
  const carrier = TransactionBuilder.fromXDR(created.signedTx, chain.cfg.networkPassphrase) as Transaction;
  const op = carrier.operations[0] as Operation.InvokeHostFunction;
  const hash = await feePaid(chain, op.func, op.auth ?? []);
  await kit.confirmWalletCreation(created, hash);
  const { contractId } = await kit.connectWallet({ keyId: created.keyIdBase64 });
  return makeWallet(chain, kit, contractId);
}

/** Connects a smart wallet whose passkey already exists for this site (this device, or synced). */
export async function connectPasskeyWallet(chain: Chain): Promise<Wallet> {
  const kit = kitFor(chain);
  const indexer = MercuryIndexer.forNetwork({ rpc: kit.rpc }, chain.cfg.networkPassphrase);
  const { contractId } = await kit.connectWallet(
    indexer ? { getWalletCandidates: (keyId: string) => indexer.findWallets(SignerKey.Secp256r1(keyId)) } : undefined,
  );
  return makeWallet(chain, kit, contractId);
}

/** Turns a host error into something a person can read. */
export function friendly(e: string): string {
  const m = /Error\(Contract, #(\d+)\)/.exec(e);
  return m ? t('errContract', { code: m[1] }) : e.slice(0, 200);
}
