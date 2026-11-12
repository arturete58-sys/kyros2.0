/**
 * Yield on the reserve with Blend and Ondo together.
 *
 * Blend lends the reserve's dollars in a pool: the rate moves with demand and
 * a withdrawal can wait if the pool is fully lent. Ondo's USDY is a token
 * backed by short-term US Treasuries whose price rises with the yield; the
 * vault buys it through a swapper and sells it back, so each round trip pays
 * the market's spread. Blend suits reserve due soon; USDY suits reserve that
 * waits months (the income-tax reserve), and holding both spreads the risk.
 *
 * The USDY strategy (`contracts/yield-ondo`) is built and tested but **not
 * active**: USDY is offered only to eligible non-US persons under Ondo's terms
 * and a vault holding it has to be cleared first. Until `ONDO_USDY.active` is
 * true, plans keep USDY at zero and say why.
 */
import { lendingAdvice, type BlendRates } from './blend.js';

export const ONDO_USDY = {
  active: false,
  name: 'Ondo USDY',
  /** Why it is not on yet, in order. */
  pending: [
    'USDY is offered only to eligible non-US persons under Ondo’s terms; a vault holding it has to be cleared with Ondo first.',
    'The strategy is not deployed: no Kyros vault can choose it until it is.',
    'There is no USDY on testnet: it can only be tried on mainnet.',
  ],
  sources: [
    { title: 'Ondo: USDY is now live on Stellar (September 2025)', url: 'https://ondo.finance/blog/usdy-is-now-live-on-stellar' },
    { title: 'RedStone: USDY price feed on Stellar with SEP-40 (August 2026)', url: 'https://www.redstone.finance/blog/redstone-brings-ondos-usdy-to-stellar-defi-with-sep-40-integration' },
  ],
} as const;

/** Below this many days to the due date, buying and selling USDY does not pay its spread. */
export const MIN_ONDO_DAYS = 30;
/** With both sources available, no more than this share of the reserve goes to either one. */
export const MAX_SOURCE_SHARE_BPS = 5_000;

/** The yearly yield implied by two USDY prices (its price rises with the yield), in bps. */
export function usdyApyBps(a: { price: bigint; at: bigint }, b: { price: bigint; at: bigint }): number | undefined {
  const secs = Number(b.at - a.at);
  if (secs < 86_400 || a.price <= 0n || b.price < a.price) return undefined;
  const growth = Number(b.price - a.price) / Number(a.price);
  return Math.round(growth * (365 * 86_400 / secs) * 10_000);
}

export interface YieldPlan {
  blend: bigint;
  ondo: bigint;
  /** Left in the vault, ready to pay. */
  keep: bigint;
  /** Earned until the due date by the plan, net of USDY's round trip (asset units). */
  untilDue: bigint;
  reasons: string[];
}

/**
 * How to put `amount` of the reserve to work until `dueAt`: Blend if its pool
 * has room and the time is worth it; USDY if it is active, the reserve waits
 * at least `MIN_ONDO_DAYS` and its yield beats the round trip
 * (`roundTripBps`, buying and selling); both, half each, when both qualify.
 */
export function yieldPlan(i: { amount: bigint; dueAt: bigint; now: bigint; blend?: BlendRates; usdyApyBps?: number; ondoActive?: boolean; roundTripBps?: number }): YieldPlan {
  const reasons: string[] = [];
  const days = Number((i.dueAt - i.now) / 86_400n);
  const blendOk = !!i.blend && lendingAdvice({ amount: i.amount, dueAt: i.dueAt, now: i.now, rates: i.blend }).decision === 'lend';
  if (!i.blend) reasons.push('no-blend-pool');
  else if (!blendOk) reasons.push('blend-not-worth-it');
  const active = i.ondoActive ?? ONDO_USDY.active;
  const trip = i.roundTripBps ?? 60;
  // USDY's yield until the due date, less what buying and selling costs.
  const ondoNetBps = i.usdyApyBps !== undefined ? (i.usdyApyBps * days) / 365 - trip : -1;
  let ondoOk = false;
  if (!active) reasons.push('ondo-not-active');
  else if (days < MIN_ONDO_DAYS) reasons.push('too-soon-for-ondo');
  else if (ondoNetBps <= 0) reasons.push('ondo-does-not-beat-its-spread');
  else ondoOk = true;
  const half = (i.amount * BigInt(MAX_SOURCE_SHARE_BPS)) / 10_000n;
  const blend = blendOk ? (ondoOk ? half : i.amount) : 0n;
  const ondo = ondoOk ? (blendOk ? i.amount - half : i.amount) : 0n;
  if (blendOk && ondoOk) reasons.push('split-between-both');
  const fromBlend = blendOk ? (blend * BigInt(i.blend!.supplyAprBps) * BigInt(days)) / (10_000n * 365n) : 0n;
  const fromOndo = ondoOk ? (ondo * BigInt(Math.floor(ondoNetBps))) / 10_000n : 0n;
  return { blend, ondo, keep: i.amount - blend - ondo, untilDue: fromBlend + fromOndo, reasons };
}
