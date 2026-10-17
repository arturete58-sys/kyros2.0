/**
 * Talking to Stellar testnet from the browser. Fees are paid by a "fee
 * payer": a throwaway testnet account created in this browser and funded by
 * friendbot. It pays network fees and deploys contracts; it never owns the
 * user's money (the vault's owner is the user's wallet).
 */
import { Asset, BASE_FEE, Keypair, Operation, rpc, Transaction, TransactionBuilder, xdr } from '@stellar/stellar-sdk';
import { KyrosClient } from 'kyros-sdk';
import type { AppConfig } from './config';

const store = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* private mode: keys live for this session only */
    }
  },
};
export { store };

const memory = new Map<string, Keypair>();

/** A testnet keypair kept in this browser under `name`. */
export function localKey(name: string): Keypair {
  const k = `kyros.key.${name}`;
  const saved = store.get(k);
  if (saved) return Keypair.fromSecret(saved);
  const kp = memory.get(k) ?? Keypair.random();
  memory.set(k, kp);
  store.set(k, kp.secret());
  return kp;
}

export class Chain {
  readonly server: rpc.Server;
  readonly client: KyrosClient;
  constructor(readonly cfg: AppConfig) {
    this.server = new rpc.Server(cfg.rpcUrl);
    this.client = new KyrosClient({ rpcUrl: cfg.rpcUrl, networkPassphrase: cfg.networkPassphrase });
  }

  get feePayer(): Keypair {
    return localKey('fee-payer');
  }

  /** Funds a testnet account with friendbot if it does not exist yet. */
  async ensureAccount(pub: string): Promise<void> {
    try {
      await this.server.getAccount(pub);
      return;
    } catch {
      /* not created yet */
    }
    for (let i = 0; i < 5; i++) {
      const r = await fetch(`https://friendbot.stellar.org/?addr=${encodeURIComponent(pub)}`).catch(() => null);
      if (r && (r.ok || r.status === 400)) break;
      await new Promise((res) => setTimeout(res, 2500));
    }
    for (let i = 0; i < 10; i++) {
      try {
        await this.server.getAccount(pub);
        return;
      } catch {
        await new Promise((res) => setTimeout(res, 1500));
      }
    }
    throw new Error('No se pudo crear la cuenta de pruebas (friendbot).');
  }

  /** Submits a signed transaction and waits for it. Returns its hash. */
  async submit(tx: Transaction): Promise<string> {
    const sent = await this.server.sendTransaction(tx);
    if (sent.status === 'ERROR') throw new Error(`La red rechazó la transacción: ${sent.errorResult?.result().switch().name ?? 'error'}`);
    const done = await this.server.pollTransaction(sent.hash, { attempts: 40, sleepStrategy: () => 1000 });
    if (done.status !== 'SUCCESS') throw new Error(`La transacción ${sent.hash.slice(0, 8)}… terminó en ${done.status}`);
    return sent.hash;
  }

  /** One operation signed and paid by a local keypair. */
  async sendAs(kp: Keypair, op: xdr.Operation): Promise<string> {
    await this.ensureAccount(kp.publicKey());
    const tx = await this.client.prepare(kp.publicKey(), op);
    tx.sign(kp);
    return this.submit(tx);
  }

  /** Classic operations (trustlines, payments) signed by a local keypair. */
  async classicAs(kp: Keypair, ops: xdr.Operation[]): Promise<string> {
    await this.ensureAccount(kp.publicKey());
    const account = await this.server.getAccount(kp.publicKey());
    const b = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: this.cfg.networkPassphrase });
    ops.forEach((o) => b.addOperation(o));
    const tx = b.setTimeout(60).build();
    tx.sign(kp);
    return this.submit(tx);
  }

  asset(which: 'usd' | 'eur'): Asset {
    const t = this.cfg.tokens[which];
    return new Asset(t.code, t.issuer);
  }

  /** Test money from the faucet (the test tokens' issuer) to a classic account that trusts them. */
  async faucet(to: Keypair, amount: string): Promise<void> {
    await this.classicAs(to, [Operation.changeTrust({ asset: this.asset('usd') })]);
    const issuer = Keypair.fromSecret(this.cfg.faucetSecret);
    await this.classicAs(issuer, [Operation.payment({ destination: to.publicKey(), asset: this.asset('usd'), amount })]);
  }

  explorerTx(hash: string): string {
    return `https://stellar.expert/explorer/testnet/tx/${hash}`;
  }
}
