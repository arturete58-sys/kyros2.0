/**
 * Treasury agent: for a reserve held in dollars against a tax owed in euros,
 * is now a good moment to convert it (`convert`), and what would lending it
 * until the due date earn (a yield strategy such as Blend)?
 *
 * The vault already protects every conversion: it refuses a swap that pays
 * less than its oracle floor (the owner's `max_slippage_bps`). This agent
 * looks ahead of that floor: it compares the swap the vault would make now
 * (a simulation of `convert`, nothing is sent) with the oracle's fair price
 * and the time left to the due date, and says convert now, wait, or set up
 * the conversion first. It reads; it never signs. `convert` can be run by
 * anyone, so acting on the advice needs no key.
 */
import { scValToNative } from '@stellar/stellar-sdk';
import type { KyrosClient, Position, Strategy } from '../client.js';
import { oracleAssetToScVal, u32, type Conversion } from '../scval.js';
import { lendingAdvice, readBlendRates, type BlendRates, type LendingAdvice } from './blend.js';

export type TreasuryDecision = 'convert-now' | 'wait' | 'set-up-conversion' | 'nothing-to-convert' | 'cannot-quote';

export interface TreasuryInput {
  /** Reserve of the period held in the from-token (7 decimals). */
  held: bigint;
  /** When the tax is due (UNIX seconds, the day to pay by). */
  dueAt: bigint;
  now: bigint;
  /** The conversion in force, or null when none is set up. */
  conversion: Pick<Conversion, 'maxSlippageBps'> | null;
  /** The vault's notice, in seconds: a new conversion applies only after it. */
  noticeSecs: bigint;
  /** What the oracle says `held` is worth in the to-token (7 decimals), if read. */
  fairOut?: bigint;
  /** What `convert` would pay now (a simulation), if it can run. */
  quotedOut?: bigint;
  /** Why the simulation failed (slippage over the floor, stale oracle...). */
  quoteError?: string;
}

export interface TreasuryAdvice {
  decision: TreasuryDecision;
  /** Days left to the due date (can be negative). */
  days: number;
  /** How much worse than the oracle the swap is now, in basis points (negative = better). */
  spreadBps?: number;
  fairOut?: bigint;
  quotedOut?: bigint;
  /** Machine-readable reasons, for the app to put in words. */
  reasons: string[];
}

const DAY = 86_400n;

/** Days to convert ahead of the due date: after this the agent stops waiting for a better price. */
export const CONVERT_BY_DAYS = 7;

export function treasuryAdvice(i: TreasuryInput): TreasuryAdvice {
  const days = Number((i.dueAt - i.now) / DAY);
  const reasons: string[] = [];
  if (i.held <= 0n) return { decision: 'nothing-to-convert', days, reasons: ['no-dollar-reserve'] };
  if (!i.conversion) {
    reasons.push('no-conversion');
    // The conversion takes the vault's notice to apply: too late if the due date comes first.
    if (i.dueAt - i.now < i.noticeSecs) reasons.push('notice-longer-than-due');
    return { decision: 'set-up-conversion', days, reasons };
  }
  const fairOut = i.fairOut;
  const quotedOut = i.quotedOut;
  if (quotedOut === undefined) {
    reasons.push(i.quoteError && /below|floor|#2[0-9]|slippage/i.test(i.quoteError) ? 'swap-below-floor' : 'quote-failed');
    if (days <= CONVERT_BY_DAYS) reasons.push('due-soon');
    return { decision: 'cannot-quote', days, fairOut, reasons };
  }
  const spreadBps = fairOut && fairOut > 0n ? Number(((fairOut - quotedOut) * 10_000n) / fairOut) : undefined;
  const max = i.conversion.maxSlippageBps;
  if (days <= CONVERT_BY_DAYS) {
    reasons.push('due-soon');
    return { decision: 'convert-now', days, spreadBps, fairOut, quotedOut, reasons };
  }
  if (spreadBps === undefined) {
    reasons.push('no-oracle-price');
    return { decision: 'wait', days, fairOut, quotedOut, reasons };
  }
  // Half the owner's tolerance or better: a good moment. Worse: wait while there is time.
  if (spreadBps <= Math.floor(max / 2)) {
    reasons.push('good-price');
    return { decision: 'convert-now', days, spreadBps, fairOut, quotedOut, reasons };
  }
  reasons.push('price-could-improve');
  return { decision: 'wait', days, spreadBps, fairOut, quotedOut, reasons };
}

export interface YieldProjection {
  /** Annual yield in basis points: observed from the vault's own position, or the one given. */
  apyBps: number;
  source: 'observed' | 'given' | 'pool';
  /** What `amount` earns from now to the due date at that yield (7 decimals). */
  untilDue: bigint;
  days: number;
}

/**
 * The yield the vault's reserve has actually earned in a strategy: its
 * surplus over what is invested, annualised over the time since it was
 * invested. Undefined until something has been invested for a day.
 */
export function observedApyBps(p: Pick<Position, 'invested' | 'surplus'>, investedSince: bigint, now: bigint): number | undefined {
  const secs = now - investedSince;
  if (p.invested <= 0n || secs < DAY) return undefined;
  return Number((p.surplus * 10_000n * 365n * DAY) / (p.invested * secs));
}

/** What `amount` earns until `dueAt` at `apyBps` (simple interest: the reserve comes back before the due date). */
export function projectYield(amount: bigint, apyBps: number, now: bigint, dueAt: bigint, source: YieldProjection['source']): YieldProjection {
  const secs = dueAt > now ? dueAt - now : 0n;
  const untilDue = (amount * BigInt(Math.max(0, Math.round(apyBps))) * secs) / (10_000n * 365n * DAY);
  return { apyBps, source, untilDue, days: Number(secs / DAY) };
}

// ---- reading the network (simulations only) ----

/** What `convert(period)` would pay now, by simulating it; or why it would fail. */
export async function quoteConversion(client: KyrosClient, vault: string, period: number): Promise<{ out?: bigint; error?: string }> {
  try {
    return { out: BigInt(scValToNative(await client.read(vault, 'convert', u32(period))) as bigint) };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

/** A SEP-40 oracle's last price for an asset, as a fraction (price / 10^decimals). */
export async function oraclePrice(client: KyrosClient, oracle: string, asset: Conversion['fromPrice']): Promise<{ price: bigint; decimals: number; timestamp: bigint } | undefined> {
  try {
    const decimals = Number(scValToNative(await client.read(oracle, 'decimals')));
    const p = scValToNative(await client.read(oracle, 'lastprice', oracleAssetToScVal(asset))) as { price: bigint; timestamp: bigint } | null | undefined;
    return p ? { price: BigInt(p.price), decimals, timestamp: BigInt(p.timestamp) } : undefined;
  } catch {
    return undefined;
  }
}

/** `amount` of the from-token at the oracle's prices, in the to-token (both 7 decimals). */
export function fairValue(amount: bigint, from: { price: bigint; decimals: number }, to: { price: bigint; decimals: number }): bigint {
  if (to.price <= 0n) return 0n;
  // Scale both prices to the same decimals before dividing.
  const scale = (p: { price: bigint; decimals: number }, d: number) => p.price * 10n ** BigInt(d - p.decimals);
  const d = Math.max(from.decimals, to.decimals);
  return (amount * scale(from, d)) / scale(to, d);
}

export interface TreasuryReading {
  advice: TreasuryAdvice;
  yield?: YieldProjection;
  strategy: Strategy | null;
  /** The Blend pool behind the strategy (or the one asked about): its rates and whether to lend or bring the reserve back. */
  lending?: { pool: string; asset: string; rates: BlendRates; advice: LendingAdvice };
}

/**
 * Everything the treasury agent needs for one period, read from the network:
 * the conversion, a simulated swap, the oracle's prices and the yield.
 * `investedSince` is when the strategy first invested (from the vault's
 * `invested` events); `apyBps` a yield to project when no strategy runs yet.
 */
export async function readTreasury(
  client: KyrosClient,
  v: { vault: string; period: number; fromToken: string; held: bigint; dueAt: bigint; noticeSecs: bigint; investedSince?: bigint; apyBps?: number; blendPool?: string; blendAsset?: string; blendAmount?: bigint },
  now = BigInt(Math.floor(Date.now() / 1000)),
): Promise<TreasuryReading> {
  const [conversion, strategy] = await Promise.all([client.conversion(v.vault).catch(() => null), client.strategy(v.vault).catch(() => null)]);
  let fairOut: bigint | undefined;
  let quote: { out?: bigint; error?: string } = {};
  if (conversion && v.held > 0n) {
    const [from, to, q] = await Promise.all([oraclePrice(client, conversion.oracle, conversion.fromPrice), oraclePrice(client, conversion.oracle, conversion.toPrice), quoteConversion(client, v.vault, v.period)]);
    if (from && to) fairOut = fairValue(v.held, from, to);
    quote = q;
  }
  const advice = treasuryAdvice({ held: v.held, dueAt: v.dueAt, now, conversion, noticeSecs: v.noticeSecs, fairOut, quotedOut: quote.out, quoteError: quote.error });
  let y: YieldProjection | undefined;
  if (strategy && v.investedSince !== undefined) {
    const pos = await client.position(v.vault, strategy.token).catch(() => null);
    const apy = pos ? observedApyBps(pos, v.investedSince, now) : undefined;
    if (apy !== undefined && pos) y = projectYield((pos.held * BigInt(strategy.maxBps)) / 10_000n, apy, now, v.dueAt, 'observed');
  }
  if (!y && v.apyBps !== undefined) y = projectYield(v.held, v.apyBps, now, v.dueAt, 'given');
  // The pool's own rates: from the strategy's adapter, or a pool the caller names.
  let lending: TreasuryReading['lending'];
  try {
    const pool = strategy ? String(scValToNative(await client.read(strategy.adapter, 'pool'))) : v.blendPool;
    const asset = strategy?.token ?? v.blendAsset;
    if (pool && asset) {
      const rates = await readBlendRates(client, pool, asset);
      const pos = strategy ? await client.position(v.vault, strategy.token).catch(() => null) : null;
      const amount = pos ? (pos.held * BigInt(strategy!.maxBps)) / 10_000n : (v.blendAmount ?? v.held);
      lending = { pool, asset, rates, advice: lendingAdvice({ amount, dueAt: v.dueAt, now, rates, invested: pos?.invested }) };
      if (!y) y = projectYield(amount, rates.supplyAprBps, now, v.dueAt, 'pool');
    }
  } catch {
    /* no pool reading: the rest of the advice stands */
  }
  return { advice, yield: y, strategy, lending };
}
