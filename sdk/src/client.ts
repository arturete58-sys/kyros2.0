/**
 * Talking to the Kyros contracts over Stellar RPC: deploy, pay, sweep, pay
 * tax, release, propose changes, and read state. Every write returns a
 * transaction the right party signs (the payer for `pay`, the owner for money
 * out); `send` signs and submits with a Keypair for scripts and services.
 */
import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  hash,
  Keypair,
  Networks,
  Operation,
  rpc,
  scValToNative,
  Transaction,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk';
import type { Dues, PeriodKind } from './periods.js';
import type { ScheduledItem } from './scval.js';
import {
  addr,
  bytes32,
  conversionFromNative,
  conversionToScVal,
  i128,
  invoiceTermsToScVal,
  payoutsToScVal,
  periodKindFromNative,
  duesFromNative,
  duesToScVal,
  scheduledItemsToScVal,
  periodKindToScVal,
  ruleFromNative,
  ruleToScVal,
  splitFromScVal,
  u32,
  u64,
  type Conversion,
  type Payout,
} from './scval.js';
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
  /** When each tax of a period falls due. */
  dues: Dues;
  tokens: string[];
}

export interface PeriodState {
  /** Reserve still held per bucket, `vat` included. */
  buckets: Record<string, bigint>;
  reserved: bigint;
  paid: bigint;
  released: bigint;
  /** Swapped out of this token into the reserve currency. */
  converted: bigint;
  /** Taxable income booked to the period (the base of every payment). */
  income: bigint;
  /** Income tax the clients withheld and paid themselves. */
  withheld: bigint;
  /** Paid to the tax destination, per bucket. */
  paidBuckets: Record<string, bigint>;
}

/** A payment to the tax destination that anyone can run from `at` on. */
export interface ScheduledPayment {
  id: number;
  at: bigint;
  payments: ScheduledItem[];
  /** The destination strkey (M... when it carries an anchor memo). */
  to: string;
}

/** The shortest notice period the SDK deploys on mainnet: every change and correction waits this long. */
export const MIN_MAINNET_NOTICE_SECS = 86_400n;

/** Tax taken back from a bucket, applied by anyone from `readyAt`. */
export interface Correction {
  id: number;
  period: number;
  token: string;
  bucket: string;
  amount: bigint;
  readyAt: bigint;
}

/** A vault's yield strategy. */
export interface Strategy {
  adapter: string;
  token: string;
  maxBps: number;
}

/** Where the reserve in one token is: `surplus` is the owner's yield (negative after a loss). */
export interface Position {
  held: bigint;
  liquid: bigint;
  invested: bigint;
  surplus: bigint;
}

export interface Sent {
  hash: string;
  returnValue?: xdr.ScVal;
}

export class KyrosError extends Error {}

/** Network failures worth trying again: the RPC was briefly unreachable or overloaded. */
const TRANSIENT = /fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|network|status code (429|502|503|504)|Bad Gateway|Service Unavailable|Gateway Time-?out|TRY_AGAIN_LATER/i;

/**
 * Runs `f`, retrying transient network failures (and, when `alsoIf` says so,
 * other errors such as an account friendbot has just created but the RPC does
 * not show yet). Contract and simulation errors are never retried.
 */
export async function retrying<T>(f: () => Promise<T>, o: { attempts?: number; alsoIf?: (e: Error) => boolean } = {}): Promise<T> {
  const attempts = o.attempts ?? 5;
  for (let i = 1; ; i++) {
    try {
      return await f();
    } catch (e) {
      const err = e as Error;
      const again = !(err instanceof KyrosError) && (TRANSIENT.test(String(err?.message ?? err)) || (o.alsoIf?.(err) ?? false));
      if (!again || i >= attempts) throw e;
      await new Promise((r) => setTimeout(r, Math.min(1000 * 2 ** (i - 1), 8000)));
    }
  }
}

const notFoundYet = (e: Error) => /Account not found/i.test(e.message);

export class KyrosClient {
  readonly server: rpc.Server;
  constructor(readonly o: KyrosClientOptions) {
    this.server = new rpc.Server(o.rpcUrl, { allowHttp: o.rpcUrl.startsWith('http://') });
  }

  // ---- low level ----

  /** Builds and simulates (prepares) a transaction with one operation, ready to sign. */
  async prepare(source: string, op: xdr.Operation): Promise<Transaction> {
    const account = await retrying(() => this.server.getAccount(source), { alsoIf: notFoundYet });
    const tx = new TransactionBuilder(account, { fee: this.o.fee ?? BASE_FEE, networkPassphrase: this.o.networkPassphrase })
      .addOperation(op)
      .setTimeout(120)
      .build();
    try {
      return await retrying(() => this.server.prepareTransaction(tx));
    } catch (e) {
      // Simulation failures carry the contract error, e.g. Error(Contract, #4) for NotDue.
      throw new KyrosError(`simulation failed: ${(e as Error).message}`);
    }
  }

  /** Signs with `signer` and submits; throws on failure. */
  async submit(tx: Transaction, signer: Keypair): Promise<Sent> {
    tx.sign(signer);
    // Sending the same signed transaction again is safe: it has one hash and can only apply once.
    const sent = await retrying(async () => {
      const r = await this.server.sendTransaction(tx);
      if (r.status === 'TRY_AGAIN_LATER') throw new Error('TRY_AGAIN_LATER');
      return r;
    });
    if (sent.status === 'ERROR') throw new KyrosError(`rejected: ${sent.errorResult?.toXDR('base64') ?? 'unknown'}`);
    const done = await retrying(() => this.server.pollTransaction(sent.hash, { attempts: 40 }));
    if (done.status !== 'SUCCESS') throw new KyrosError(`transaction ${sent.hash} ${done.status}`);
    return { hash: sent.hash, returnValue: (done as rpc.Api.GetSuccessfulTransactionResponse).returnValue };
  }

  /** prepare + submit, signed by `signer` as the source account. */
  async send(signer: Keypair, op: xdr.Operation): Promise<Sent> {
    return this.submit(await this.prepare(signer.publicKey(), op), signer);
  }

  /** Simulates a read-only call and returns its value. */
  async read(contractId: string, method: string, ...args: xdr.ScVal[]): Promise<xdr.ScVal> {
    const source = this.o.readAs ? await retrying(() => this.server.getAccount(this.o.readAs!), { alsoIf: notFoundYet }) : new Account(Keypair.random().publicKey(), '0');
    const tx = new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: this.o.networkPassphrase })
      .addOperation(new Contract(contractId).call(method, ...args))
      .setTimeout(60)
      .build();
    const sim = await retrying(() => this.server.simulateTransaction(tx));
    if (rpc.Api.isSimulationError(sim)) throw new KyrosError(`${method} failed: ${sim.error}`);
    return (sim as rpc.Api.SimulateTransactionSuccessResponse).result!.retval;
  }

  // ---- deployment ----

  /** Uploads a contract wasm; returns its hash. */
  async upload(deployer: Keypair, wasm: Buffer): Promise<Buffer> {
    await this.send(deployer, Operation.uploadContractWasm({ wasm }));
    return hash(wasm);
  }

  private async create(deployer: Keypair, wasmHash: Buffer, args: xdr.ScVal[]): Promise<{ contractId: string; hash: string }> {
    const op = Operation.createCustomContract({ address: new Address(deployer.publicKey()), wasmHash, salt: Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(32))), constructorArgs: args });
    const done = await this.send(deployer, op);
    return { contractId: scValToNative(done.returnValue!) as string, hash: done.hash };
  }

  deployRouter(deployer: Keypair, wasmHash: Buffer) {
    return this.create(deployer, wasmHash, []);
  }

  deployVault(
    deployer: Keypair,
    wasmHash: Buffer,
    v: { owner: string; rule: Rule; taxDestination: string; noticeSecs: bigint; period: PeriodKind; dues: Dues; tokens: string[] },
  ) {
    // The notice is what protects the reserve if the owner's key is stolen: on mainnet it is at least a day.
    if (this.o.networkPassphrase === Networks.PUBLIC && v.noticeSecs < MIN_MAINNET_NOTICE_SECS)
      throw new KyrosError(`A mainnet vault needs a notice period of at least ${MIN_MAINNET_NOTICE_SECS} seconds (one day).`);
    return this.create(deployer, wasmHash, [
      addr(v.owner),
      ruleToScVal(v.rule),
      addr(v.taxDestination),
      u64(v.noticeSecs),
      periodKindToScVal(v.period),
      duesToScVal(v.dues),
      xdr.ScVal.scvVec(v.tokens.map(addr)),
    ]);
  }

  deployInbox(deployer: Keypair, wasmHash: Buffer, vault: string) {
    return this.create(deployer, wasmHash, [addr(vault)]);
  }

  /** A swapper over the Soroswap router (holds nothing, no admin). */
  deploySwapper(deployer: Keypair, wasmHash: Buffer, router: string) {
    return this.create(deployer, wasmHash, [addr(router)]);
  }

  /** A Blend yield strategy for one vault: only `vault` can move what it lends. */
  deployBlendYield(deployer: Keypair, wasmHash: Buffer, s: { vault: string; pool: string; asset: string }) {
    return this.create(deployer, wasmHash, [addr(s.vault), addr(s.pool), addr(s.asset)]);
  }

  /** The CCTP receiver: Circle's MessageTransmitter and TokenMessengerMinter on this network. */
  deployCctpPay(deployer: Keypair, wasmHash: Buffer, s: { transmitter: string; minter: string }) {
    return this.create(deployer, wasmHash, [addr(s.transmitter), addr(s.minter)]);
  }

  /** A Rate Registry; `minNoticeSecs` is fixed for its lifetime. */
  deployRegistry(deployer: Keypair, wasmHash: Buffer, admin: string, minNoticeSecs: bigint) {
    return this.create(deployer, wasmHash, [addr(admin), u64(minNoticeSecs)]);
  }

  // ---- operations (unsigned) ----

  /** The Router payment the payer signs: split inside the payer's own transaction. */
  payOp(router: string, p: { from: string; vault: string; token: string; amount: bigint; reference: Uint8Array }): xdr.Operation {
    return new Contract(router).call('pay', addr(p.from), addr(p.vault), addr(p.token), i128(p.amount), bytes32(p.reference));
  }

  /**
   * A platform's payout run (payroll, bounties, grants): one signature pays
   * every vault, each split by its own rule. All or nothing. Keep a run to
   * a few dozen payments so it fits one transaction's resource limits.
   */
  payManyOp(router: string, p: { from: string; token: string; payouts: Payout[] }): xdr.Operation {
    return new Contract(router).call('pay_many', addr(p.from), addr(p.token), payoutsToScVal(p.payouts));
  }

  sweepOp(inbox: string, token: string): xdr.Operation {
    return new Contract(inbox).call('sweep', addr(token));
  }

  payTaxOp(vault: string, p: { period: number; token: string; bucket: string; amount: bigint }): xdr.Operation {
    return new Contract(vault).call('pay_tax', u32(p.period), addr(p.token), xdr.ScVal.scvSymbol(p.bucket), i128(p.amount));
  }

  /**
   * Pays tax to the destination with an anchor's memo: `to` is the
   * destination account with the memo as muxed id (an M... address, see
   * `anchor.ts`). The vault refuses any other account.
   */
  payTaxToOp(vault: string, p: { period: number; token: string; bucket: string; amount: bigint; to: string }): xdr.Operation {
    return new Contract(vault).call('pay_tax_to', u32(p.period), addr(p.token), xdr.ScVal.scvSymbol(p.bucket), i128(p.amount), addr(p.to));
  }

  /**
   * Sets a bucket's due date for a range of periods to `day` (days since
   * 1970-01-01), e.g. from the tax office's notice. Later applies at once;
   * earlier must still be the vault's notice away.
   */
  setDueOp(vault: string, p: { bucket: string; fromPeriod: number; toPeriod: number; day: number }): xdr.Operation {
    return new Contract(vault).call('set_due', xdr.ScVal.scvSymbol(p.bucket), u32(p.fromPeriod), u32(p.toPeriod), u32(p.day));
  }

  /** Schedules a payment to the destination `to` (or its muxed M... form) that anyone can run from `at`. */
  scheduleOp(vault: string, p: { at: bigint; payments: ScheduledItem[]; to: string }): xdr.Operation {
    return new Contract(vault).call('schedule', u64(p.at), scheduledItemsToScVal(p.payments), addr(p.to));
  }

  runScheduledOp(vault: string, id: number): xdr.Operation {
    return new Contract(vault).call('run_scheduled', u32(id));
  }

  cancelScheduledOp(vault: string, id: number): xdr.Operation {
    return new Contract(vault).call('cancel_scheduled', u32(id));
  }

  /** Publishes a country's holidays for a year to a Rate Registry (its admin signs). */
  setHolidaysOp(registry: string, country: string, year: number, days: number[]): xdr.Operation {
    return new Contract(registry).call('set_holidays', xdr.ScVal.scvSymbol(country), u32(year), xdr.ScVal.scvVec(days.map((d) => u32(d))));
  }

  async holidays(registry: string, country: string, year: number): Promise<number[]> {
    return (scValToNative(await this.read(registry, 'holidays', xdr.ScVal.scvSymbol(country), u32(year))) as number[]).map(Number);
  }

  releaseOp(vault: string, period: number, token: string): xdr.Operation {
    return new Contract(vault).call('release', u32(period), addr(token));
  }

  proposeRuleOp(vault: string, rule: Rule): xdr.Operation {
    return new Contract(vault).call('propose_rule', ruleToScVal(rule));
  }

  /** A rule that takes effect at `effectiveAt` (UNIX seconds), or after the notice if later; see `vatUpdatePlan`. */
  proposeRuleAtOp(vault: string, rule: Rule, effectiveAt: bigint): xdr.Operation {
    return new Contract(vault).call('propose_rule_at', ruleToScVal(rule), u64(effectiveAt));
  }

  proposeDestinationOp(vault: string, destination: string): xdr.Operation {
    return new Contract(vault).call('propose_destination', addr(destination));
  }

  applyPendingOp(vault: string): xdr.Operation {
    return new Contract(vault).call('apply_pending');
  }

  // VAT that follows the law: a vault reads its VAT from a Rate Registry.

  /** Owner: follow `country`/`rate` in `registry`; refused unless today's rate equals the vault's VAT. */
  followOp(vault: string, f: { registry: string; country: string; rate: string; maxBps: number }): xdr.Operation {
    return new Contract(vault).call('follow', addr(f.registry), xdr.ScVal.scvSymbol(f.country), xdr.ScVal.scvSymbol(f.rate), u32(f.maxBps));
  }

  /** Owner: stop following, at once; the vault keeps the VAT in force as its own. */
  unfollowOp(vault: string): xdr.Operation {
    return new Contract(vault).call('unfollow');
  }

  /** Publisher: the rate in force today for a rate the registry does not list yet. */
  seedRateOp(registry: string, country: string, rate: string, bps: number): xdr.Operation {
    return new Contract(registry).call('seed', xdr.ScVal.scvSymbol(country), xdr.ScVal.scvSymbol(rate), u32(bps));
  }

  /** Publisher: a rate applying from `from` (UNIX seconds), at least the registry's notice ahead. */
  publishRateOp(registry: string, country: string, rate: string, from: bigint, bps: number): xdr.Operation {
    return new Contract(registry).call('publish', xdr.ScVal.scvSymbol(country), xdr.ScVal.scvSymbol(rate), u64(from), u32(bps));
  }

  /** Publisher: withdraw a future entry (e.g. a reform voted down). */
  withdrawRateOp(registry: string, country: string, rate: string, from: bigint): xdr.Operation {
    return new Contract(registry).call('withdraw', xdr.ScVal.scvSymbol(country), xdr.ScVal.scvSymbol(rate), u64(from));
  }

  // Invoices: payments carrying an invoice's reference split by its own terms.

  /**
   * Owner: register how an invoice's payments split (its VAT, what the
   * client withholds, the reserve buckets). `reference` is `invoiceReference(number)`.
   */
  expectInvoiceOp(vault: string, reference: Uint8Array, t: { vatBps: number; withholdingBps: number; buckets: Rule['buckets'] }): xdr.Operation {
    return new Contract(vault).call('expect_invoice', bytes32(reference), invoiceTermsToScVal(t));
  }

  forgetInvoiceOp(vault: string, reference: Uint8Array): xdr.Operation {
    return new Contract(vault).call('forget_invoice', bytes32(reference));
  }

  // Clients with their own terms: payments from a payer address (a client's
  // wallet, or a second inbox for clients abroad) split by its terms.

  /** Owner: payments from `payer` without invoice terms split by `t` (e.g. a client abroad: VAT 0). */
  expectPayerOp(vault: string, payer: string, t: { vatBps: number; withholdingBps: number; buckets: Rule['buckets'] }): xdr.Operation {
    return new Contract(vault).call('expect_payer', addr(payer), invoiceTermsToScVal(t));
  }

  forgetPayerOp(vault: string, payer: string): xdr.Operation {
    return new Contract(vault).call('forget_payer', addr(payer));
  }

  async payerTerms(vault: string, payer: string): Promise<{ vatBps: number; withholdingBps: number; buckets: Rule['buckets'] } | null> {
    const n = scValToNative(await this.read(vault, 'payer', addr(payer))) as { vat_bps: number; withholding_bps: number; buckets: { name: string; bps: number }[] } | null | undefined;
    return n ? { vatBps: Number(n.vat_bps), withholdingBps: Number(n.withholding_bps), buckets: n.buckets.map((b) => ({ name: String(b.name), bps: Number(b.bps) })) } : null;
  }

  // Corrections: tax a payment did not owe goes back to the owner after the notice.

  /** Owner: take `amount` of a period's bucket back; anyone applies it after the vault's notice. */
  proposeCorrectionOp(vault: string, c: { period: number; token: string; bucket: string; amount: bigint }): xdr.Operation {
    return new Contract(vault).call('propose_correction', u32(c.period), addr(c.token), xdr.ScVal.scvSymbol(c.bucket), i128(c.amount));
  }

  /** Anyone, once the correction's notice has passed: pays it to the owner. */
  applyCorrectionOp(vault: string, id: number): xdr.Operation {
    return new Contract(vault).call('apply_correction', u32(id));
  }

  cancelCorrectionOp(vault: string, id: number): xdr.Operation {
    return new Contract(vault).call('cancel_correction', u32(id));
  }

  // Reserve in the tax's currency: swap reserve received in USDC into EURC.

  /** Owner: how to convert (swapper, oracle, tolerance); applies after the notice. */
  proposeConversionOp(vault: string, c: Conversion): xdr.Operation {
    return new Contract(vault).call('propose_conversion', conversionToScVal(c));
  }

  /** Owner: stop converting, at once. */
  stopConversionOp(vault: string): xdr.Operation {
    return new Contract(vault).call('stop_conversion');
  }

  /** Anyone (the keeper): swap what `period` holds in the from-token. */
  convertOp(vault: string, period: number): xdr.Operation {
    return new Contract(vault).call('convert', u32(period));
  }

  // Yield: lend part of the reserve through a strategy the owner chose.

  /** Owner: a strategy that may hold up to `maxBps` of the reserve; applies after the notice. */
  proposeStrategyOp(vault: string, adapter: string, maxBps: number): xdr.Operation {
    return new Contract(vault).call('propose_strategy', addr(adapter), u32(maxBps));
  }

  /** Owner: stop at once and bring everything back. */
  stopStrategyOp(vault: string): xdr.Operation {
    return new Contract(vault).call('stop_strategy');
  }

  /** Anyone (the keeper): move liquid reserve into the strategy up to its share. */
  investOp(vault: string): xdr.Operation {
    return new Contract(vault).call('invest');
  }

  /** Owner: take what the reserve has earned. */
  harvestOp(vault: string, token: string): xdr.Operation {
    return new Contract(vault).call('harvest', addr(token));
  }

  // Moving country: the inbox (the user's payment address) moves to a new vault after the notice.

  /** Owner: move the inbox to `newVault` (same owner) after the current vault's notice. */
  proposeVaultOp(inbox: string, newVault: string): xdr.Operation {
    return new Contract(inbox).call('propose_vault', addr(newVault));
  }

  cancelMoveOp(inbox: string): xdr.Operation {
    return new Contract(inbox).call('cancel_move');
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
      dues: duesFromNative(n.dues),
      tokens: (n.tokens as string[]).map(String),
    };
  }

  async currentPeriod(vault: string): Promise<number> {
    return Number(scValToNative(await this.read(vault, 'current_period')));
  }

  /** When all of a period's reserve can be released (the latest bucket due date). */
  async dueDate(vault: string, period: number): Promise<bigint> {
    return BigInt(scValToNative(await this.read(vault, 'due_date', u32(period))) as bigint);
  }

  /** When one bucket of a period falls due (`vat`, `irpf`...). */
  async bucketDueDate(vault: string, period: number, bucket: string): Promise<bigint> {
    return BigInt(scValToNative(await this.read(vault, 'bucket_due_date', u32(period), xdr.ScVal.scvSymbol(bucket))) as bigint);
  }

  async period(vault: string, period: number, token: string): Promise<PeriodState> {
    const n = scValToNative(await this.read(vault, 'period', u32(period), addr(token))) as Record<string, unknown>;
    const map = (x: unknown) => {
      const out: Record<string, bigint> = {};
      for (const [k, v] of Object.entries((x ?? {}) as Record<string, bigint>)) out[k] = BigInt(v);
      return out;
    };
    return {
      buckets: map(n.buckets),
      reserved: BigInt(n.reserved as bigint),
      paid: BigInt(n.paid as bigint),
      released: BigInt(n.released as bigint),
      converted: BigInt((n.converted as bigint | undefined) ?? 0n),
      income: BigInt((n.income as bigint | undefined) ?? 0n),
      withheld: BigInt((n.withheld as bigint | undefined) ?? 0n),
      paidBuckets: map(n.paid_buckets),
    };
  }

  /** Open scheduled payments of a vault. */
  async scheduledPayments(vault: string): Promise<ScheduledPayment[]> {
    const ids = (scValToNative(await this.read(vault, 'scheduled_ids')) as number[]).map(Number);
    const out: ScheduledPayment[] = [];
    for (const id of ids) {
      const s = scValToNative(await this.read(vault, 'scheduled', u32(id))) as { at: bigint; payments: { period: number; token: string; bucket: string; amount: bigint }[]; to: string } | null;
      if (s) out.push({ id, at: BigInt(s.at), to: String(s.to), payments: s.payments.map((p) => ({ period: Number(p.period), token: String(p.token), bucket: String(p.bucket), amount: BigInt(p.amount) })) });
    }
    return out;
  }

  /** Open corrections of a vault. */
  async corrections(vault: string): Promise<Correction[]> {
    const ids = (scValToNative(await this.read(vault, 'correction_ids')) as number[]).map(Number);
    const out: Correction[] = [];
    for (const id of ids) {
      const c = scValToNative(await this.read(vault, 'correction', u32(id))) as { period: number; token: string; bucket: string; amount: bigint; ready_at: bigint } | null;
      if (c) out.push({ id, period: Number(c.period), token: String(c.token), bucket: String(c.bucket), amount: BigInt(c.amount), readyAt: BigInt(c.ready_at) });
    }
    return out;
  }

  /** The conversion in force, or null. */
  async conversion(vault: string): Promise<Conversion | null> {
    const n = scValToNative(await this.read(vault, 'conversion')) as Record<string, unknown> | null | undefined;
    return n ? conversionFromNative(n) : null;
  }

  /** The yield strategy in force, or null. */
  async strategy(vault: string): Promise<Strategy | null> {
    const n = scValToNative(await this.read(vault, 'strategy')) as Record<string, unknown> | null | undefined;
    return n ? { adapter: String(n.adapter), token: String(n.token), maxBps: Number(n.max_bps) } : null;
  }

  /** Where the reserve in `token` is and what it has earned. */
  async position(vault: string, token: string): Promise<Position> {
    const n = scValToNative(await this.read(vault, 'position', addr(token))) as Record<string, bigint>;
    return { held: BigInt(n.held), liquid: BigInt(n.liquid), invested: BigInt(n.invested), surplus: BigInt(n.surplus) };
  }

  /** The registry a vault follows for its VAT, or null. */
  async feed(vault: string): Promise<{ registry: string; country: string; rate: string; maxBps: number } | null> {
    const n = scValToNative(await this.read(vault, 'feed')) as Record<string, unknown> | null | undefined;
    if (!n) return null;
    return { registry: String(n.registry), country: String(n.country), rate: String(n.rate), maxBps: Number(n.max_bps) };
  }

  /** A registry's dated entries for one rate, oldest first. */
  async rateSchedule(registry: string, country: string, rate: string): Promise<{ from: bigint; bps: number }[]> {
    const n = scValToNative(await this.read(registry, 'schedule', xdr.ScVal.scvSymbol(country), xdr.ScVal.scvSymbol(rate))) as { from: bigint; bps: number }[];
    return (n ?? []).map((x) => ({ from: BigInt(x.from), bps: Number(x.bps) }));
  }

  async registryMinNotice(registry: string): Promise<bigint> {
    return BigInt(scValToNative(await this.read(registry, 'min_notice')) as bigint);
  }

  /** The vault an inbox pays into now. */
  async inboxVault(inbox: string): Promise<string> {
    return String(scValToNative(await this.read(inbox, 'vault')));
  }

  async balance(token: string, holder: string): Promise<bigint> {
    return BigInt(scValToNative(await this.read(token, 'balance', addr(holder))) as bigint);
  }
}

/** A 32-byte invoice reference: sha256 of the invoice number (only the hash goes onchain). */
export function invoiceReference(invoiceNumber: string): Uint8Array {
  return new Uint8Array(hash(Buffer.from(invoiceNumber, 'utf8')));
}
