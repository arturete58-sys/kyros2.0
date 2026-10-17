/** What the app does with the Kyros contracts, on behalf of the connected wallet. */
import { Keypair, scValToNative } from '@stellar/stellar-sdk';
import { fmtNumber, t } from './i18n';
import { allowanceData, balanceOfData, burnCalls, fastFeeBps, fetchAttestation, mintAndPayOp, type EvmChain } from 'kyros-sdk';
import { requestRef, requestTerms, suggestSetup, termsFromPack, vaultEvents, type ActivityId, type ClientKind, type PaymentRequest, type RulePack, type Rule, type Setup, type VaultEventRow } from 'kyros-sdk';
import { Chain, localKey, store } from './chain';
import type { Wallet } from './wallet/types';
import type { EvmWallet } from './wallet/evm';

export interface Answers {
  packId: string;
  region?: string;
  resident: 'yes' | 'no' | 'unsure';
  activity: ActivityId;
  client: ClientKind;
  revenue: number;
}

export interface Plan {
  setup: Setup;
  rule: Rule;
  pack: RulePack;
}

export function makePlan(pack: RulePack, a: Answers): Plan {
  const setup = suggestSetup(pack, { activity: a.activity, client: a.client, revenue: a.revenue, region: a.region });
  return { setup, rule: setup.rule, pack };
}

export interface VaultInfo {
  vault: string;
  inbox: string;
  owner: string;
  answers: Answers;
  rule: Rule;
  createdAt: string;
  deployedAt: string;
}

const key = (owner: string) => `kyros.vault.${owner}`;

export function savedVault(owner: string, deployedAt: string): VaultInfo | null {
  const raw = store.get(key(owner));
  if (!raw) return null;
  const v = JSON.parse(raw) as VaultInfo;
  // A vault from an older testnet deployment (testnet resets) is not shown.
  return v.deployedAt === deployedAt ? v : null;
}

export async function createVault(chain: Chain, wallet: Wallet, plan: Plan, answers: Answers, onStep: (s: string) => void): Promise<VaultInfo> {
  const cfg = chain.cfg;
  const fp = chain.feePayer;
  onStep(t('stepFeePayer'));
  await chain.ensureAccount(fp.publicKey());
  const terms = termsFromPack(plan.pack, plan.setup.presetId);
  onStep(t('stepVault'));
  const vault = await chain.client.deployVault(fp, Buffer.from(cfg.wasm.vault, 'hex'), {
    owner: wallet.address,
    rule: plan.rule,
    taxDestination: cfg.taxAccount,
    noticeSecs: BigInt(cfg.noticeSecs),
    period: terms.period,
    dueOffsetSecs: terms.dueOffsetSecs,
    tokens: [...chain.dollarTokens, cfg.tokens.eur.contract],
  });
  onStep(t('stepInbox'));
  const inbox = await chain.client.deployInbox(fp, Buffer.from(cfg.wasm.inbox, 'hex'), vault.contractId);
  const info: VaultInfo = {
    vault: vault.contractId,
    inbox: inbox.contractId,
    owner: wallet.address,
    answers,
    rule: plan.rule,
    createdAt: new Date().toISOString(),
    deployedAt: cfg.deployedAt,
  };
  store.set(key(wallet.address), JSON.stringify(info));
  return info;
}

const UNIT = 10_000_000n;

/** A client (a test account in this browser, with test money) pays `gross` through the Router. */
export async function simulateClientPayment(chain: Chain, vault: string, gross: bigint, reference?: Uint8Array): Promise<string> {
  const client = localKey('test-client');
  const usd = chain.cfg.tokens.usd.contract;
  await chain.ensureAccount(client.publicKey());
  let balance = 0n;
  try {
    balance = await chain.client.balance(usd, client.publicKey());
  } catch {
    balance = 0n;
  }
  if (balance < gross) await chain.faucet(client, '20000');
  const ref = reference ?? globalThis.crypto.getRandomValues(new Uint8Array(32));
  return chain.sendAs(client, chain.client.payOp(chain.cfg.router, { from: client.publicKey(), vault, token: usd, amount: gross, reference: ref }));
}

/** Registers an expected payment in the vault (owner-signed) and returns its reference. */
export async function expectPayment(chain: Chain, wallet: Wallet, vault: string, req: PaymentRequest, reserveBps: number, bucket: string): Promise<{ hash: string; reference: Uint8Array }> {
  const reserve = Math.max(0, reserveBps - (req.withholding ? Math.round(Number(req.withholding.rate) * 100) : 0));
  const terms = requestTerms(req, reserve > 0 ? [{ name: bucket, bps: reserve }] : []);
  const reference = requestRef(req);
  const hash = await wallet.signAndSend(chain.client.expectInvoiceOp(vault, reference, terms));
  return { hash, reference };
}

export interface Snapshot {
  spendable: { usd: bigint; eur: bigint };
  reserved: { usd: bigint; eur: bigint };
  buckets: Record<string, { usd: bigint; eur: bigint }>;
  period: number;
  dueDate: bigint;
  conversion: Awaited<ReturnType<Chain['client']['conversion']>>;
  pendingConversionAt: bigint | null;
  feed: Awaited<ReturnType<Chain['client']['feed']>>;
  events: VaultEventRow[];
}

export async function snapshot(chain: Chain, v: VaultInfo): Promise<Snapshot> {
  const c = chain.client;
  const { eur } = chain.cfg.tokens;
  const safe = async <T,>(f: () => Promise<T>, d: T): Promise<T> => {
    try {
      return await f();
    } catch {
      return d;
    }
  };
  // Dollars can be the test KUSD or Circle's USDC from another chain; the app shows them together.
  const dollars = chain.dollarTokens;
  const none = { held: 0n, liquid: 0n, invested: 0n, surplus: 0n };
  const sum = (xs: bigint[]) => xs.reduce((a, b) => a + b, 0n);
  const [sUsds, sEur, pUsds, pEur, period] = await Promise.all([
    Promise.all(dollars.map((d) => safe(() => c.balance(d, v.owner), 0n))),
    safe(() => c.balance(eur.contract, v.owner), 0n),
    Promise.all(dollars.map((d) => safe(() => c.position(v.vault, d), none))),
    safe(() => c.position(v.vault, eur.contract), none),
    safe(() => c.currentPeriod(v.vault), 0),
  ]);
  const sUsd = sum(sUsds);
  const pUsd = { held: sum(pUsds.map((p) => p.held)) };
  const [dueDate, perUsds, perEur, conversion, pending, feed] = await Promise.all([
    safe(() => c.dueDate(v.vault, period), 0n),
    Promise.all(dollars.map((d) => safe(() => c.period(v.vault, period, d), null))),
    safe(() => c.period(v.vault, period, eur.contract), null),
    safe(() => c.conversion(v.vault), null),
    safe(async () => {
      const n = scValToNative(await c.read(v.vault, 'pending_conversion')) as { ready_at: bigint } | null | undefined;
      return n ? BigInt(n.ready_at) : null;
    }, null),
    safe(() => c.feed(v.vault), null),
  ]);
  const buckets: Snapshot['buckets'] = {};
  for (const perUsd of perUsds) for (const [name, amt] of Object.entries(perUsd?.buckets ?? {})) (buckets[name] ??= { usd: 0n, eur: 0n }).usd += amt;
  for (const [name, amt] of Object.entries(perEur?.buckets ?? {})) (buckets[name] ??= { usd: 0n, eur: 0n }).eur = amt;
  const latest = await safe(() => chain.server.getLatestLedger(), { sequence: 0 } as { sequence: number });
  const events = await safe(() => vaultEvents(chain.server, v.vault, Math.max(latest.sequence - 17_000, 1)), []);
  return {
    spendable: { usd: sUsd, eur: sEur },
    reserved: { usd: pUsd.held, eur: pEur.held },
    buckets,
    period,
    dueDate,
    conversion,
    pendingConversionAt: pending,
    feed,
    events: events.reverse(),
  };
}

/** Pays every bucket of the current period that holds something, in each token. Owner-signed, one call per bucket. */
export async function payTaxes(chain: Chain, wallet: Wallet, v: VaultInfo, period: number, onStep: (s: string) => void): Promise<string[]> {
  const hashes: string[] = [];
  const tokens: [string, string][] = [...chain.dollarTokens.map((d, i): [string, string] => [i === 0 ? 'USD' : 'USDC', d]), ['EUR', chain.cfg.tokens.eur.contract]];
  for (const [which, token] of tokens) {
    const p = await chain.client.period(v.vault, period, token);
    for (const [bucket, amount] of Object.entries(p.buckets)) {
      if (amount <= 0n) continue;
      onStep(t('payingBucket', { what: t(bucket === 'vat' ? 'bucketVat' : 'bucketIncome'), cur: which }));
      hashes.push(await wallet.signAndSend(chain.client.payTaxOp(v.vault, { period, token, bucket, amount })));
    }
  }
  return hashes;
}

/** Owner: keep the reserve in euros, through the deployment's swapper and Reflector's fiat oracle. */
export async function proposeEuroReserve(chain: Chain, wallet: Wallet, v: VaultInfo): Promise<string> {
  const conv = chain.cfg.conversion;
  if (!conv) throw new Error(t('errNoConversion'));
  return wallet.signAndSend(
    chain.client.proposeConversionOp(v.vault, {
      fromToken: chain.cfg.tokens.usd.contract,
      toToken: chain.cfg.tokens.eur.contract,
      swapper: conv.swapper,
      oracle: conv.oracle,
      fromPrice: { other: 'USD' },
      toPrice: { other: 'EUR' },
      maxSlippageBps: 100,
      // Testnet's oracle updates less often than mainnet's.
      maxAgeSecs: 86_400n,
    }),
  );
}

/** Anyone (here, the fee payer): swap the period's dollar reserve into euros. */
export function convertNow(chain: Chain, v: VaultInfo, period: number): Promise<string> {
  return chain.sendAs(chain.feePayer, chain.client.convertOp(v.vault, period));
}

/** Owner: follow the on-chain registry for the country's standard VAT. */
export function followLaw(chain: Chain, wallet: Wallet, v: VaultInfo, country: string): Promise<string> {
  return wallet.signAndSend(chain.client.followOp(v.vault, { registry: chain.cfg.registry, country, rate: 'standard', maxBps: 3000 }));
}

export function units(x: bigint): number {
  return Number(x) / Number(UNIT);
}

export const money = (x: bigint, cur: '€' | 'USDC' | 'EURC' | '' = '') =>
  `${fmtNumber(units(x), { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${cur ? ` ${cur}` : ''}`;

export { Keypair };

// ---- Paying from another chain (Circle's CCTP) ----

/** A burn sent on another chain whose payment into the vault has not been made yet. */
export interface PendingCrossChain {
  vault: string;
  sourceDomain: number;
  chainName: string;
  burnTx: string;
  explorer: string;
}

const PENDING = 'kyros.cctp.pending';

export function pendingCrossChain(): PendingCrossChain | null {
  const raw = store.get(PENDING);
  try {
    return raw ? (JSON.parse(raw) as PendingCrossChain) : null;
  } catch {
    return null;
  }
}

/**
 * The client pays `amount` (Stellar units) into `vault` from an EVM chain:
 * their wallet approves and burns USDC there; once Circle attests the burn,
 * this browser's fee payer submits the mint-and-pay on Stellar.
 */
export async function payFromOtherChain(
  chain: Chain,
  evm: EvmWallet,
  from: EvmChain,
  p: { vault: string; reference?: Uint8Array; amount: bigint },
  onStep: (s: string) => void,
): Promise<{ burnTx: string; stellarTx: string }> {
  const cctp = chain.cfg.cctp;
  if (!cctp) throw new Error(t('noCrossChain'));
  onStep(t('xcSwitching', { chain: from.name }));
  await evm.useChain(from);
  const feeBps = await fastFeeBps('testnet', from.domain);
  const calls = burnCalls(from, { receiver: cctp.receiver, vault: p.vault, reference: p.reference, amount: p.amount, feeBps, fast: true });
  const balance = await evm.read(from.usdc, balanceOfData(evm.address));
  if (balance < calls.amount) throw new Error(t('xcNoUsdc', { need: formatUnits6(calls.amount), have: formatUnits6(balance), chain: from.name }));
  if ((await evm.read(from.usdc, allowanceData(evm.address, from.tokenMessenger))) < calls.amount) {
    onStep(t('xcApprove'));
    await evm.send(calls.approve.to, calls.approve.data);
  }
  onStep(t('xcBurn'));
  const burnTx = await evm.send(calls.burn.to, calls.burn.data);
  const pending: PendingCrossChain = { vault: p.vault, sourceDomain: from.domain, chainName: from.name, burnTx, explorer: `${from.explorer}/tx/${burnTx}` };
  store.set(PENDING, JSON.stringify(pending));
  const stellarTx = await finishCrossChain(chain, pending, onStep);
  return { burnTx, stellarTx };
}

/** Waits for Circle's attestation of a burn and pays it into the vault. Safe to repeat. */
export async function finishCrossChain(chain: Chain, p: PendingCrossChain, onStep: (s: string) => void): Promise<string> {
  const cctp = chain.cfg.cctp;
  if (!cctp) throw new Error(t('noCrossChain'));
  onStep(t('xcAttest'));
  const a = await fetchAttestation('testnet', p.sourceDomain, p.burnTx, { timeoutMs: 20 * 60_000, onWait: () => onStep(t('xcAttest')) });
  onStep(t('xcMint'));
  await chain.ensureAccount(chain.feePayer.publicKey());
  const hash = await chain.sendAs(chain.feePayer, mintAndPayOp(cctp.receiver, a));
  store.set(PENDING, '');
  return hash;
}

export const formatUnits6 = (x: bigint) => fmtNumber(Number(x) / 1e6, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
