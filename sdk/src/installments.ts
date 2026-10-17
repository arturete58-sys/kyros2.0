/**
 * Prepayments ("pagos a plazos"): how much to pay on each instalment date,
 * worked out from what the vault recorded, so the user does not type it.
 *
 * The rule comes from the pack (`calendar.prepayments[].amount`):
 * - `es130`: Spain's modelo 130 exactly: rate x (income - expenses) of the
 *   year to the end of the quarter, minus what clients withheld, minus the
 *   130 payments already made. Expenses are the user's; without them the
 *   result is an upper bound.
 * - `reservedSoFar`: what the income-tax reserve holds for the tax year so far.
 * - `annualized`: `share` of the year's tax estimated from the reserve so
 *   far (scaled to twelve months), minus what was already paid.
 * - `previousYear`: `share` of last year's income tax, which the user gives
 *   once (or reads from last year's notice).
 * - `notice`: the amount the tax office notified.
 *
 * Amounts are in token units (7 decimals). The result is a suggestion: the
 * user can change it before paying or scheduling it.
 */
import { civilFromDays, daysFromCivil, periodEnd, periodStart, type PeriodKind } from './periods.js';
import type { PrepaymentAmount, RulePack } from './rulepacks.js';
import type { ScheduledItem } from './scval.js';

/** What one period recorded, all tokens of one currency together. */
export interface PeriodFigures {
  id: number;
  income: bigint;
  withheld: bigint;
  /** Income-tax reserve still held (non-VAT buckets). */
  incomeHeld: bigint;
  /** Income-tax reserve already paid to the tax destination. */
  incomePaid: bigint;
}

export interface InstalmentInputs {
  /** Deductible expenses of the tax year so far (for `es130`). */
  expenses?: bigint;
  /** Last year's income tax (for `previousYear`). */
  previousYearTax?: bigint;
  /** The amount on the tax office's notice (for `notice`). */
  notice?: bigint;
}

export interface Suggestion {
  /** What to pay; null when it depends on something the user has not given yet. */
  amount: bigint | null;
  /** What is missing for an exact amount. */
  needs?: 'expenses' | 'previousYear' | 'notice';
  rule: PrepaymentAmount['kind'];
  /** The figures used, for showing the working. */
  income?: bigint;
  withheld?: bigint;
  paid?: bigint;
  estimate?: bigint;
  /** Spain: at least 70% of the income seems to have had withholding, so the 130 may not be required. */
  mayBeExempt?: boolean;
}

const DAY = 86_400n;

/** Start (Unix seconds) of the fiscal year containing `at`, shifted by `offset` years. */
export function taxYearStart(fiscalYearStart: string | undefined, at: bigint, offset = 0): bigint {
  const [fm, fd] = (fiscalYearStart ?? '01-01').split('-').map(Number);
  const [y, m, d] = civilFromDays((at - 1n) / DAY);
  const year = m > fm || (m === fm && d >= fd) ? y : y - 1n;
  return daysFromCivil(year + BigInt(offset), fm, fd) * DAY;
}

const max0 = (x: bigint) => (x > 0n ? x : 0n);
const scale = (x: bigint, share: number) => (x * BigInt(Math.round(share * 1_000_000))) / 1_000_000n;

/**
 * The amount to pay on a prepayment whose legal date ends at `due` (Unix
 * seconds, the end of the day), from the periods of a vault with period `kind`.
 */
export function suggestPrepayment(
  rule: PrepaymentAmount | undefined,
  pack: RulePack,
  kind: PeriodKind,
  due: bigint,
  periods: PeriodFigures[],
  inputs: InstalmentInputs = {},
): Suggestion {
  const r = rule ?? { kind: 'reservedSoFar' as const };
  if (r.kind === 'notice') return inputs.notice !== undefined ? { amount: inputs.notice, rule: r.kind } : { amount: null, needs: 'notice', rule: r.kind };
  if (r.kind === 'previousYear')
    return inputs.previousYearTax !== undefined ? { amount: scale(inputs.previousYearTax, r.share), rule: r.kind } : { amount: null, needs: 'previousYear', rule: r.kind };
  const fy = pack.calendar.fiscalYearStart;
  const start = taxYearStart(fy, due, r.taxYear ?? 0);
  const end = taxYearStart(fy, start + DAY, 1);
  const cut = due < end ? due : end;
  // es130 counts complete periods only (the quarter just ended); the others count what has come in so far.
  const inYear = periods.filter((p) => periodStart(kind, p.id) >= start && (r.kind === 'es130' ? periodEnd(kind, p.id) <= cut : periodStart(kind, p.id) < cut));
  const sum = (f: (p: PeriodFigures) => bigint) => inYear.reduce((a, p) => a + f(p), 0n);
  const income = sum((p) => p.income);
  const withheld = sum((p) => p.withheld);
  const paid = sum((p) => p.incomePaid);
  const reserved = sum((p) => p.incomeHeld + p.incomePaid);
  if (r.kind === 'reservedSoFar') return { amount: sum((p) => p.incomeHeld), rule: r.kind, paid };
  if (r.kind === 'annualized') {
    const months = Number(cut - start) / Number(DAY) / (365.2425 / 12);
    const estimate = months > 0 ? (reserved * BigInt(Math.round(12_000_000 / Math.min(12, months)))) / 1_000_000n : 0n;
    return { amount: max0(scale(estimate, r.share) - paid), rule: r.kind, estimate, paid };
  }
  // es130
  const expenses = inputs.expenses ?? 0n;
  const amount = max0(scale(income - expenses, r.rate) - withheld - paid);
  const withheldIncome = (withheld * 100n) / 15n;
  return {
    amount,
    ...(inputs.expenses === undefined ? { needs: 'expenses' as const } : {}),
    rule: r.kind,
    income,
    withheld,
    paid,
    mayBeExempt: income > 0n && withheldIncome * 10n >= income * 7n,
  };
}

/** Reserve that can pay an amount: income-tax buckets, oldest period first. */
export interface HeldRow {
  period: number;
  token: string;
  bucket: string;
  amount: bigint;
}

/**
 * Which buckets pay `amount`: the given income-tax rows, oldest period
 * first. Returns the items and what the reserve cannot cover.
 */
export function drawFrom(rows: HeldRow[], amount: bigint): { items: ScheduledItem[]; short: bigint } {
  const items: ScheduledItem[] = [];
  let left = amount;
  for (const r of [...rows].sort((a, b) => a.period - b.period)) {
    if (left <= 0n) break;
    const take = r.amount < left ? r.amount : left;
    if (take > 0n) items.push({ period: r.period, token: r.token, bucket: r.bucket, amount: take }), (left -= take);
  }
  return { items, short: left };
}

/** The income-tax buckets of a preset (estimate items of kind incomeTax, or every non-VAT bucket). */
export function incomeTaxBuckets(pack: RulePack, presetId: string): string[] {
  const p = pack.presets.find((x) => x.id === presetId);
  if (!p) return [];
  const items = (p as { estimate?: { items?: { name: string; kind: string }[] } }).estimate?.items ?? [];
  const tax = items.filter((i) => i.kind === 'incomeTax').map((i) => i.name);
  const names = p.buckets.map((b) => b.name);
  return tax.length ? names.filter((n) => tax.includes(n)) : names;
}
