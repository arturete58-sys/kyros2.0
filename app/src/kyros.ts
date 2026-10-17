/** What the app does with the Kyros contracts, on behalf of the connected wallet. */
import { Keypair, scValToNative } from '@stellar/stellar-sdk';
import { fmtNumber, t } from './i18n';
import { requestRef, requestTerms, suggestSetup, termsFromPack, vaultEvents, type ActivityId, type ClientKind, type PaymentRequest, type RulePack, type Rule, type Setup, type VaultEventRow } from 'kyros-sdk';
import { Chain, localKey, store } from './chain';
import type { Wallet } from './wallet/types';

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
    tokens: [cfg.tokens.usd.contract, cfg.tokens.eur.contract],
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
  const { usd, eur } = chain.cfg.tokens;
  const safe = async <T,>(f: () => Promise<T>, d: T): Promise<T> => {
    try {
      return await f();
    } catch {
      return d;
    }
  };
  const [sUsd, sEur, pUsd, pEur, period] = await Promise.all([
    safe(() => c.balance(usd.contract, v.owner), 0n),
    safe(() => c.balance(eur.contract, v.owner), 0n),
    safe(() => c.position(v.vault, usd.contract), { held: 0n, liquid: 0n, invested: 0n, surplus: 0n }),
    safe(() => c.position(v.vault, eur.contract), { held: 0n, liquid: 0n, invested: 0n, surplus: 0n }),
    safe(() => c.currentPeriod(v.vault), 0),
  ]);
  const [dueDate, perUsd, perEur, conversion, pending, feed] = await Promise.all([
    safe(() => c.dueDate(v.vault, period), 0n),
    safe(() => c.period(v.vault, period, usd.contract), null),
    safe(() => c.period(v.vault, period, eur.contract), null),
    safe(() => c.conversion(v.vault), null),
    safe(async () => {
      const n = scValToNative(await c.read(v.vault, 'pending_conversion')) as { ready_at: bigint } | null | undefined;
      return n ? BigInt(n.ready_at) : null;
    }, null),
    safe(() => c.feed(v.vault), null),
  ]);
  const buckets: Snapshot['buckets'] = {};
  for (const [name, amt] of Object.entries(perUsd?.buckets ?? {})) (buckets[name] ??= { usd: 0n, eur: 0n }).usd = amt;
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
  for (const [which, token] of [['USD', chain.cfg.tokens.usd.contract], ['EUR', chain.cfg.tokens.eur.contract]] as const) {
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
