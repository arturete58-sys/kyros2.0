/**
 * Reserve check: is the reserve a user chose enough for what they will owe?
 *
 * Each rule pack carries a simplified annual estimate (national income tax for a
 * single self-employed person, and the main social contributions). The check
 * compares the estimate with the reserve the user picked and answers: short,
 * fine, or generous (the surplus goes back to the user after the due date).
 * It is an estimate for planning, not a tax calculation.
 */
import type { Coverage, RulePack } from './rulepacks.js';

/** `[upTo, bps]`: the rate applies up to `upTo` (null = no upper limit). */
export type Bracket = [number | null, number];

export interface EstimateItem {
  name: string;
  label?: string;
  kind: Coverage;
  /** What the brackets apply to: the taxable profit (default) or the revenue. */
  basis?: 'taxable' | 'revenue';
  /** `marginal` (default): each slice at its own rate. `flat`: the whole amount at the rate of the band it falls in. */
  mode?: 'marginal' | 'flat';
  brackets: Bracket[];
  /** Tax credit subtracted from the amount. */
  credit?: number;
  /** Surcharge on the amount, in bps (cess, local surtax). */
  surchargeBps?: number;
  /** Minimum amount due (e.g. a fixed minimum contribution). */
  min?: number;
  /** Maximum amount due (contribution ceilings). */
  max?: number;
  /** The item only applies from this revenue. */
  minRevenue?: number;
  /** Nothing is due while the basis is at or below this amount (e.g. a full rebate). */
  zeroUpTo?: number;
  /** Share of the basis that is relieved before the brackets apply, in bps (e.g. a profit exemption). */
  reliefBps?: number;
}

export interface Estimate {
  /** Tax year the figures are for. */
  year: number;
  /** Presumptive regimes: taxable profit = this share of revenue, whatever the expenses. */
  taxableShareBps?: number;
  /** Social contributions are deducted from the taxable profit before income tax. */
  socialDeductible?: boolean;
  items: EstimateItem[];
  notes?: string[];
}

/** Typical running costs as a share of revenue, used when the user does not enter expenses. */
export const ACTIVITY_PROFILES: Record<string, { label: string; expenseBps: number }> = {
  software: { label: 'Software and IT services', expenseBps: 1_000 },
  consulting: { label: 'Consulting and professional services', expenseBps: 1_000 },
  creative: { label: 'Design, content and creators', expenseBps: 2_000 },
  education: { label: 'Training and education', expenseBps: 1_500 },
  ecommerce: { label: 'Online sales of goods', expenseBps: 6_000 },
  hospitality: { label: 'Hospitality and food', expenseBps: 6_500 },
  other: { label: 'Other services', expenseBps: 2_000 },
};

export interface ReserveInput {
  /** Expected annual revenue in the pack's currency, VAT excluded (the vault's taxable base). */
  revenue: number;
  /** Expected annual deductible expenses. Default: from `activity`. */
  expenses?: number;
  /** Key of ACTIVITY_PROFILES. Default: `other`. */
  activity?: string;
  /** Known fixed annual contributions (e.g. a flat monthly social fee), counted as social. */
  fixedSocial?: number;
  /** Extra income tax as a share of taxable profit, in bps (regional, state, cantonal or church tax). */
  extraIncomeTaxBps?: number;
  /** The reserve to check, in bps of the base. Default: the preset's buckets. */
  reserveBps?: number;
  /** What the reserve should cover. Default: the preset's `covers`. */
  covers?: Coverage[];
}

export interface EstimateResult {
  revenue: number;
  expenses: number;
  taxable: number;
  lines: { name: string; label?: string; kind: Coverage; amount: number }[];
  incomeTax: number;
  social: number;
}

export type ReserveStatus = 'short' | 'ok' | 'generous' | 'unknown';

export interface ReserveCheck extends Partial<EstimateResult> {
  status: ReserveStatus;
  covers: Coverage[];
  /** Reserve the user chose, bps of the base. */
  reserveBps: number;
  /** Estimated reserve needed for what `covers` lists, bps of the base. */
  requiredBps?: number;
  /** Amount the chosen reserve would set aside in a year. */
  reserved: number;
  /** Estimated amount owed for what `covers` lists. */
  owed?: number;
  /** owed - reserved when short, else 0. */
  shortfall?: number;
  /** reserved - owed when above, else 0 (returned to the user after the due date). */
  surplus?: number;
  notes: string[];
}

/** A reserve more than this above the estimate is reported as generous. */
export const GENEROUS_MARGIN_BPS = 1_000;

function applyBrackets(x: number, brackets: Bracket[], mode: 'marginal' | 'flat'): number {
  if (x <= 0) return 0;
  if (mode === 'flat') {
    for (const [upTo, bps] of brackets) if (upTo === null || x <= upTo) return (x * bps) / 10_000;
    return (x * brackets[brackets.length - 1][1]) / 10_000;
  }
  let tax = 0;
  let lower = 0;
  for (const [upTo, bps] of brackets) {
    const top = upTo === null ? x : Math.min(x, upTo);
    if (top > lower) tax += ((top - lower) * bps) / 10_000;
    if (upTo === null || x <= upTo) return tax;
    lower = upTo;
  }
  // Above the last bound: keep the last rate.
  return tax + ((x - lower) * brackets[brackets.length - 1][1]) / 10_000;
}

/** Applies a pack estimate to annual figures. */
export function estimateTaxes(est: Estimate, input: ReserveInput): EstimateResult {
  const revenue = Math.max(0, input.revenue);
  const profile = ACTIVITY_PROFILES[input.activity ?? 'other'] ?? ACTIVITY_PROFILES.other;
  const expenses = Math.max(0, input.expenses ?? (revenue * profile.expenseBps) / 10_000);
  const taxable = est.taxableShareBps !== undefined ? (revenue * est.taxableShareBps) / 10_000 : Math.max(0, revenue - expenses);
  const lines: EstimateResult['lines'] = [];
  const amountOf = (it: EstimateItem, taxableBasis: number): number => {
    const basis = (it.basis === 'revenue' ? revenue : taxableBasis) * (1 - (it.reliefBps ?? 0) / 10_000);
    let amount = it.zeroUpTo !== undefined && basis <= it.zeroUpTo ? 0 : applyBrackets(basis, it.brackets, it.mode ?? 'marginal');
    if (it.credit) amount = Math.max(0, amount - it.credit);
    if (it.surchargeBps) amount *= 1 + it.surchargeBps / 10_000;
    if (it.max !== undefined) amount = Math.min(amount, it.max);
    if (it.min !== undefined && revenue > 0) amount = Math.max(amount, it.min);
    return amount;
  };
  const applies = (it: EstimateItem) => it.minRevenue === undefined || revenue >= it.minRevenue;
  // Social contributions first: where they are deductible, income tax applies to what is left.
  let socialTotal = 0;
  for (const it of est.items) {
    if (it.kind !== 'social' || !applies(it)) continue;
    const amount = amountOf(it, taxable);
    socialTotal += amount;
    lines.push({ name: it.name, label: it.label, kind: it.kind, amount });
  }
  const incomeBasis = est.socialDeductible ? Math.max(0, taxable - socialTotal) : taxable;
  for (const it of est.items) {
    if (it.kind !== 'incomeTax' || !applies(it)) continue;
    lines.push({ name: it.name, label: it.label, kind: it.kind, amount: amountOf(it, incomeBasis) });
  }
  if (input.extraIncomeTaxBps) lines.push({ name: 'extra_income_tax', label: 'Regional, state or other income tax (entered by the user)', kind: 'incomeTax', amount: (taxable * input.extraIncomeTaxBps) / 10_000 });
  if (input.fixedSocial) lines.push({ name: 'fixed_social', label: 'Fixed contributions (entered by the user)', kind: 'social', amount: input.fixedSocial });
  const sum = (k: Coverage) => lines.filter((l) => l.kind === k).reduce((a, l) => a + l.amount, 0);
  return { revenue, expenses, taxable, lines, incomeTax: sum('incomeTax'), social: sum('social') };
}

/**
 * Checks a reserve against a pack's estimate. With no `reserveBps`, checks the
 * preset's own buckets. Works for a preset the user customised: pass the
 * reserve they chose.
 */
export function checkReserve(pack: RulePack, presetId: string, input: ReserveInput): ReserveCheck {
  const p = pack.presets.find((x) => x.id === presetId);
  if (!p) throw new Error(`no preset ${presetId} in ${pack.id}`);
  const reserveBps = input.reserveBps ?? p.buckets.reduce((a, b) => a + b.bps, 0);
  const covers = input.covers ?? p.covers ?? ['incomeTax'];
  const est = p.estimate ?? pack.estimate;
  const reserved = (Math.max(0, input.revenue) * reserveBps) / 10_000;
  const notes = [...(est?.notes ?? [])];
  if (!est) {
    notes.push(`No estimate for ${pack.name}; compare the reserve with your adviser's figure.`);
    return { status: 'unknown', covers, reserveBps, reserved, notes };
  }
  const r = estimateTaxes(est, input);
  const owed = (covers.includes('incomeTax') ? r.incomeTax : 0) + (covers.includes('social') ? r.social : 0);
  // The small epsilon keeps exact rates (6% of revenue) from rounding up to 601 bps.
  const requiredBps = r.revenue > 0 ? Math.max(0, Math.ceil((owed / r.revenue) * 10_000 - 1e-6)) : 0;
  const status: ReserveStatus = reserveBps < requiredBps ? 'short' : reserveBps > requiredBps + GENEROUS_MARGIN_BPS ? 'generous' : 'ok';
  return {
    ...r,
    status,
    covers,
    reserveBps,
    requiredBps,
    reserved,
    owed,
    shortfall: Math.max(0, owed - reserved),
    surplus: Math.max(0, reserved - owed),
    notes,
  };
}
