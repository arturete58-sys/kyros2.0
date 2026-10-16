/**
 * Talking to the Kyros contracts over Stellar RPC: deploy, pay, sweep, pay
 * tax, release, propose changes, and read state. Every write returns a
 * transaction the right party signs (the payer for `pay`, the owner for money
 * out); `send` signs and submits with a Keypair for scripts and services.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  Operation,
  rpc,
  scValToNative,
  Transaction,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk';
import type { PeriodKind } from './periods.js';
import { addr, bytes32, i128, periodKindFromNative, periodKindToScVal, ruleFromNative, ruleToScVal, splitFromScVal, u32, u64 } from './scval.js';
import type { Rule, Split } from './split.js';

export interface KyrosClientOptions {
  rpcUrl: string;
  networkPassphrase: string;
  /** Any existing account, used as the source for read-only simulations. */
  readAs?: string;
  /** Fee per transaction in stroops before resource fees (default BASE_FEE). */
  fee?: string;
}

export interface VaultConfig {
  owner: string;
  rule: Rule;
  taxDestination: string;
  noticeSecs: bigint;
  period: PeriodKind;
  dueOffsetSecs: bigint;
  tokens: string[];
}

export interface PeriodState {
  /** Reserve still held per bucket, `vat` included. */
  buckets: Record<string, bigint>;
  reserved: bigint;
  paid: bigint;
  released: bigint;
}

export interface Sent {
  hash: string;
  returnValue?: xdr.ScVal;
}

export class KyrosError extends Error {}

export class KyrosClient {
  readonly server: rpc.Server;
  constructor(readonly o: KyrosClientOptions) {
    this.server = new rpc.Server(o.rpcUrl, { allowHttp: o.rpcUrl.startsWith('http://') });
  }

  // ---- low level ----

  /** Builds and simulates (prepares) a transaction with one operation, ready to sign. */
  async prepare(source: string, op: xdr.Operation): Promise<Transaction> {
    const account = await this.server.getAccount(source);
    const tx = new TransactionBuilder(account, { fee: this.o.fee ?? BASE_FEE, networkPassphrase: this.o.networkPassphrase })
      .addOperation(op)
      .setTimeout(120)
      .build();
    try {
      return await this.server.prepareTransaction(tx);
    } catch (e) {
      // Simulation failures carry the contract error, e.g. Error(Contract, #4) for NotDue.
      throw new KyrosError(`simulation failed: ${(e as Error).message}`);
    }
  }

  /** Signs with `signer` and submits; throws on failure. */
  async submit(tx: Transaction, signer: Keypair): Promise<Sent> {
    tx.sign(signer);
    const sent = await this.server.sendTransaction(tx);
    if (sent.status === 'ERROR') throw new KyrosError(`rejected: ${sent.errorResult?.toXDR('base64') ?? 'unknown'}`);
    const done = await this.server.pollTransaction(sent.hash, { attempts: 40 });
    if (done.status !== 'SUCCESS') throw new KyrosError(`transaction ${sent.hash} ${done.status}`);
    return { hash: sent.hash, returnValue: (done as rpc.Api.GetSuccessfulTransactionResponse).returnValue };
  }

  /** prepare + submit, signed by `signer` as the source account. */
  async send(signer: Keypair, op: xdr.Operation): Promise<Sent> {
    return this.submit(await this.prepare(signer.publicKey(), op), signer);
  }

  /** Simulates a read-only call and returns its value. */
  async read(contractId: string, method: string, ...args: xdr.ScVal[]): Promise<xdr.ScVal> {
    const source = this.o.readAs ? await this.server.getAccount(this.o.readAs) : new Account(Keypair.random().publicKey(), '0');
    const tx = new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: this.o.networkPassphrase })
      .addOperation(new Contract(contractId).call(method, ...args))
      .setTimeout(60)
      .build();
    const sim = await this.server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) throw new KyrosError(`${method} failed: ${sim.error}`);
    return (sim as rpc.Api.SimulateTransactionSuccessResponse).result!.retval;
  }

  // ---- deployment ----

  /** Uploads a contract wasm; returns its hash. */
  async upload(deployer: Keypair, wasm: Buffer): Promise<Buffer> {
    await this.send(deployer, Operation.uploadContractWasm({ wasm }));
    return createHash('sha256').update(wasm).digest();
  }

  private async create(deployer: Keypair, wasmHash: Buffer, args: xdr.ScVal[]): Promise<{ contractId: string; hash: string }> {
    const op = Operation.createCustomContract({ address: new Address(deployer.publicKey()), wasmHash, salt: randomBytes(32), constructorArgs: args });
    const done = await this.send(deployer, op);
    return { contractId: scValToNative(done.returnValue!) as string, hash: done.hash };
  }

  deployRouter(deployer: Keypair, wasmHash: Buffer) {
    return this.create(deployer, wasmHash, []);
  }

  deployVault(
    deployer: Keypair,
    wasmHash: Buffer,
    v: { owner: string; rule: Rule; taxDestination: string; noticeSecs: bigint; period: PeriodKind; dueOffsetSecs: bigint; tokens: string[] },
  ) {
    return this.create(deployer, wasmHash, [
      addr(v.owner),
      ruleToScVal(v.rule),
      addr(v.taxDestination),
      u64(v.noticeSecs),
      periodKindToScVal(v.period),
      u64(v.dueOffsetSecs),
      xdr.ScVal.scvVec(v.tokens.map(addr)),
    ]);
  }

  deployInbox(deployer: Keypair, wasmHash: Buffer, vault: string) {
    return this.create(deployer, wasmHash, [addr(vault)]);
  }

  // ---- operations (unsigned) ----

  /** The Router payment the payer signs: split inside the payer's own transaction. */
  payOp(router: string, p: { from: string; vault: string; token: string; amount: bigint; reference: Uint8Array }): xdr.Operation {
    return new Contract(router).call('pay', addr(p.from), addr(p.vault), addr(p.token), i128(p.amount), bytes32(p.reference));
  }

  sweepOp(inbox: string, token: string): xdr.Operation {
    return new Contract(inbox).call('sweep', addr(token));
  }

  payTaxOp(vault: string, p: { period: number; token: string; bucket: string; amount: bigint }): xdr.Operation {
    return new Contract(vault).call('pay_tax', u32(p.period), addr(p.token), xdr.ScVal.scvSymbol(p.bucket), i128(p.amount));
  }

  releaseOp(vault: string, period: number, token: string): xdr.Operation {
    return new Contract(vault).call('release', u32(period), addr(token));
  }

  proposeRuleOp(vault: string, rule: Rule): xdr.Operation {
    return new Contract(vault).call('propose_rule', ruleToScVal(rule));
  }

  proposeDestinationOp(vault: string, destination: string): xdr.Operation {
    return new Contract(vault).call('propose_destination', addr(destination));
  }

  applyPendingOp(vault: string): xdr.Operation {
    return new Contract(vault).call('apply_pending');
  }

  /** A plain SEP-41 transfer, e.g. a payment into an inbox. */
  transferOp(token: string, from: string, to: string, amount: bigint): xdr.Operation {
    return new Contract(token).call('transfer', addr(from), addr(to), i128(amount));
  }

  // ---- reads ----

  async quote(vault: string, gross: bigint): Promise<Split> {
    return splitFromScVal(await this.read(vault, 'quote', i128(gross)));
  }

  async config(vault: string): Promise<VaultConfig> {
    const n = scValToNative(await this.read(vault, 'config')) as Record<string, unknown>;
    return {
      owner: String(n.owner),
      rule: ruleFromNative(n.rule as Record<string, unknown>),
      taxDestination: String(n.tax_destination),
      noticeSecs: BigInt(n.notice_secs as bigint),
      period: periodKindFromNative(n.period),
      dueOffsetSecs: BigInt(n.due_offset_secs as bigint),
      tokens: (n.tokens as string[]).map(String),
    };
  }

  async currentPeriod(vault: string): Promise<number> {
    return Number(scValToNative(await this.read(vault, 'current_period')));
  }

  async dueDate(vault: string, period: number): Promise<bigint> {
    return BigInt(scValToNative(await this.read(vault, 'due_date', u32(period))) as bigint);
  }

  async period(vault: string, period: number, token: string): Promise<PeriodState> {
    const n = scValToNative(await this.read(vault, 'period', u32(period), addr(token))) as Record<string, unknown>;
    const buckets: Record<string, bigint> = {};
    for (const [k, v] of Object.entries((n.buckets ?? {}) as Record<string, bigint>)) buckets[k] = BigInt(v);
    return { buckets, reserved: BigInt(n.reserved as bigint), paid: BigInt(n.paid as bigint), released: BigInt(n.released as bigint) };
  }

  async balance(token: string, holder: string): Promise<bigint> {
    return BigInt(scValToNative(await this.read(token, 'balance', addr(holder))) as bigint);
  }
}

/** A 32-byte invoice reference: sha256 of the invoice number (only the hash goes onchain). */
export function invoiceReference(invoiceNumber: string): Uint8Array {
  return createHash('sha256').update(invoiceNumber, 'utf8').digest();
}
