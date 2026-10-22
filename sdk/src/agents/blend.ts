/**
 * Reading a Blend v2 lending pool for the treasury agent: how full the pool
 * is (utilization), what lenders earn (supply APR), and how much could be
 * withdrawn now (free liquidity). The formulas are Blend v2's own
 * (pool/src/pool/interest.rs and reserve.rs): the borrow rate is a piecewise
 * curve of utilization scaled by the reserve's rate modifier, and lenders
 * get the borrow interest times utilization, less the backstop's take.
 * Values come from the pool's last accrual, so they are a close estimate of
 * the moment, not a promise of future yield.
 */
import { scValToNative } from '@stellar/stellar-sdk';
import type { KyrosClient } from '../client.js';
import { addr } from '../scval.js';

const S7 = 10_000_000n;
const S12 = 1_000_000_000_000n;

export interface BlendReserveConfig {
  util: number;
  max_util: number;
  r_base: number;
  r_one: number;
  r_two: number;
  r_three: number;
}
export interface BlendReserveData {
  b_rate: bigint;
  d_rate: bigint;
  b_supply: bigint;
  d_supply: bigint;
  ir_mod: bigint;
  backstop_credit?: bigint;
}

export interface BlendRates {
  /** Borrowed over supplied, bps. */
  utilizationBps: number;
  /** What borrowers pay a year, bps. */
  borrowAprBps: number;
  /** What lenders earn a year after the backstop's take, bps. */
  supplyAprBps: number;
  /** Supplied minus borrowed, in the asset's units: what lenders could withdraw now. */
  liquidity: bigint;
  supplied: bigint;
}

/** Blend v2's interest model, as the pool computes it (7-decimal rates). */
export function blendRates(config: BlendReserveConfig, data: BlendReserveData, backstopRate: number): BlendRates {
  const supplied = (data.b_supply * data.b_rate) / S12;
  const borrowed = (data.d_supply * data.d_rate) / S12;
  const util = supplied > 0n ? (borrowed * S7) / supplied : 0n;
  const target = BigInt(config.util);
  const [base, one, two, three] = [config.r_base, config.r_one, config.r_two, config.r_three].map(BigInt);
  let ir: bigint;
  if (util <= target) ir = (((target > 0n ? (util * S7) / target : 0n) * one) / S7 + base) * data.ir_mod / S7;
  else if (util <= 9_500_000n) ir = ((((util - target) * S7) / (9_500_000n - target)) * two / S7 + one + base) * data.ir_mod / S7;
  else ir = (((util - 9_500_000n) * S7) / 500_000n) * three / S7 + ((two + one + base) * data.ir_mod) / S7;
  const supply = (((ir * util) / S7) * (S7 - BigInt(backstopRate))) / S7;
  return {
    utilizationBps: Number(util / 1000n),
    borrowAprBps: Number(ir / 1000n),
    supplyAprBps: Number(supply / 1000n),
    liquidity: supplied > borrowed ? supplied - borrowed : 0n,
    supplied,
  };
}

/** Reads a pool's reserve for `asset` and its backstop take rate. */
export async function readBlendRates(client: KyrosClient, pool: string, asset: string): Promise<BlendRates> {
  const r = scValToNative(await client.read(pool, 'get_reserve', addr(asset))) as { config: BlendReserveConfig; data: BlendReserveData };
  const c = scValToNative(await client.read(pool, 'get_config')) as { bstop_rate: number };
  const n = (x: unknown) => BigInt(x as bigint);
  return blendRates(
    { util: Number(r.config.util), max_util: Number(r.config.max_util), r_base: Number(r.config.r_base), r_one: Number(r.config.r_one), r_two: Number(r.config.r_two), r_three: Number(r.config.r_three) },
    { b_rate: n(r.data.b_rate), d_rate: n(r.data.d_rate), b_supply: n(r.data.b_supply), d_supply: n(r.data.d_supply), ir_mod: n(r.data.ir_mod) },
    Number(c.bstop_rate),
  );
}

export type LendingDecision = 'lend' | 'not-worth-it' | 'pool-too-full' | 'withdraw-now' | 'keep';

export interface LendingAdvice {
  decision: LendingDecision;
  /** The amount the advice is about (asset units). */
  amount: bigint;
  /** Earned until the due date at the current supply APR (simple interest), asset units. */
  untilDue: bigint;
  days: number;
  reasons: string[];
}

/** Below this many days to the due date, lending is not worth its risk and fees. */
export const MIN_LEND_DAYS = 14;
/** Above this utilization a withdrawal may have to wait. */
export const MAX_SAFE_UTIL_BPS = 9_000;

/**
 * Whether to lend `amount` of the reserve until `dueAt` (or, when it is
 * already lent, whether to bring it back now): the pool must have room to
 * pay it back, and the time left must be worth it.
 */
export function lendingAdvice(i: { amount: bigint; dueAt: bigint; now: bigint; rates: BlendRates; invested?: bigint; minAprBps?: number }): LendingAdvice {
  const days = Number((i.dueAt - i.now) / 86_400n);
  const untilDue = days > 0 ? (i.amount * BigInt(i.rates.supplyAprBps) * BigInt(days)) / (10_000n * 365n) : 0n;
  const reasons: string[] = [];
  if (i.invested && i.invested > 0n) {
    // Already lent: bring it back before the due date if the pool might not pay it out then.
    if (days <= 7 && (i.rates.utilizationBps >= MAX_SAFE_UTIL_BPS || i.rates.liquidity < i.invested)) {
      reasons.push('due-soon-and-pool-full');
      return { decision: 'withdraw-now', amount: i.amount, untilDue, days, reasons };
    }
    return { decision: 'keep', amount: i.amount, untilDue, days, reasons: ['pool-can-pay-out'] };
  }
  if (days < MIN_LEND_DAYS) return { decision: 'not-worth-it', amount: i.amount, untilDue, days, reasons: ['too-close-to-due-date'] };
  if (i.rates.utilizationBps >= MAX_SAFE_UTIL_BPS || i.rates.liquidity < i.amount) return { decision: 'pool-too-full', amount: i.amount, untilDue, days, reasons: ['withdrawal-could-wait'] };
  if (i.rates.supplyAprBps < (i.minAprBps ?? 100)) return { decision: 'not-worth-it', amount: i.amount, untilDue, days, reasons: ['yield-too-low'] };
  return { decision: 'lend', amount: i.amount, untilDue, days, reasons: ['room-and-time'] };
}
