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
  /** A fixed annual amount by band of the basis, `[upTo, amount]` (last `upTo` null): replaces the brackets (Spain's RETA fee by band of net income). */
  steps?: [number | null, number][];
  /** Share of the basis that picks the band, in bps (Spain: 9300, net income minus the 7% general deduction). */
  stepBasisBps?: number;
}

/** The amount of the band `x` falls in. */
function stepAmount(x: number, steps: [number | null, number][]): number {
  for (const [upTo, amount] of steps) if (upTo === null || x <= upTo) return amount;
  return steps[steps.length - 1][1];
}

export interface Estimate {
  /** Tax year the figures are for. */
  year: number;
  /** Presumptive regimes: taxable profit = this share of revenue, whatever the expenses. */
  taxableShareBps?: number;
  /** Social contributions are deducted from the taxable profit before income tax. */
  socialDeductible?: boolean;
  /** Only this share of social contributions is deductible, in bps (US: half of self-employment tax). */
  socialDeductibleBps?: number;
  /** A flat deduction from taxable profit, as a share of it (Spain: 5% hard-to-justify expenses in simplified direct estimation). */
  profitReliefBps?: number;
  /** Cap on that deduction, in the pack's currency (Spain: EUR 2,000). */
  profitReliefMax?: number;
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
  /** Last year's income tax (and contributions, if the reserve covers them), from the user's return. */
  lastYearTax?: number;
  /** Last year's income, to pick the prepayment share where it depends on it. */
  lastYearIncome?: number;
  /** Region of the pack (a US state, ...) whose income tax is added. */
  region?: string;
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

export type ReserveStatus = 'short' | 'tight' | 'ok' | 'generous' | 'unknown';

/** How hard a country comes down on late or short payment of income tax. */
export interface Enforcement {
  level: 'strict' | 'standard' | 'lenient';
  /** What a late or short payment costs, in plain words. */
  facts?: string[];
  source?: { title: string; url: string; official?: boolean; checked?: string };
}

/**
 * Safety margin over the estimated need, in points of the base (bps), by how
 * exact the check is and how strict the country is. An exact figure needs no
 * margin; a progressive estimate in a strict country needs the most.
 */
export const SAFETY_MARGIN_BPS: Record<Precision, Record<Enforcement['level'], number>> = {
  exact: { strict: 0, standard: 0, lenient: 0 },
  presumptive: { strict: 150, standard: 100, lenient: 50 },
  'exact-on-profit': { strict: 200, standard: 150, lenient: 100 },
  estimate: { strict: 400, standard: 300, lenient: 200 },
  none: { strict: 0, standard: 0, lenient: 0 },
};

/**
 * How a country sets income-tax prepayments, when the law fixes them objectively:
 * - `prior-year`: a share of last year's tax (US safe harbour, UK payments on account,
 *   the German and Australian notices, Irish preliminary tax, Italian acconti...);
 * - `share-of-profit`: a share of each period's profit (Spanish modelo 130).
 * Meeting it means no late-payment penalty, whatever this year's final bill turns out to be.
 */
export interface Prepayment {
  method: 'prior-year' | 'share-of-profit';
  /** Share of last year's tax, or of the period's profit, in bps. */
  bps: number;
  /** A higher share above an income level (US: 110% above USD 150,000 of AGI). */
  above?: { income: number; bps: number };
  note: string;
}

/** A part of a country with its own income tax (a US state), added to the national estimate. */
export interface Region {
  id: string;
  name: string;
  items: EstimateItem[];
  /** Names of the national estimate's items this region's items replace (a default regional scale, or a whole foral system). */
  replaces?: string[];
  note?: string;
}

/**
 * How far the reserve check can be trusted for a preset:
 * - `exact`: the tax follows from revenue alone (a flat share of turnover, a flat rate on a presumed profit, or no tax to reserve);
 * - `presumptive`: progressive rates on a profit the law presumes from revenue: exact for that activity, only personal allowances and other income change it;
 * - `exact-on-profit`: one flat rate on profit (above a threshold), exact once expenses are known;
 * - `estimate`: progressive tax or contributions that depend on deductions and personal situation;
 * - `none`: the pack has no estimate (the tax depends on factors it cannot know).
 */
export type Precision = 'exact' | 'presumptive' | 'exact-on-profit' | 'estimate' | 'none';

export interface ReserveCheck extends Partial<EstimateResult> {
  status: ReserveStatus;
  /** How far this check can be trusted for the preset. */
  precision: Precision;
  covers: Coverage[];
  /** Reserve the user chose, bps of the base. */
  reserveBps: number;
  /** Estimated reserve needed for what `covers` lists, bps of the base. */
  requiredBps?: number;
  /** Safety margin added for this precision and country, bps. */
  marginBps?: number;
  /** requiredBps + marginBps: the reserve the app recommends. */
  recommendedBps?: number;
  /** The country's enforcement level used for the margin. */
  enforcement?: Enforcement['level'];
  /** Amount the chosen reserve would set aside in a year. */
  reserved: number;
  /** Estimated amount owed for what `covers` lists. */
  owed?: number;
  /**
   * The prepayment the law asks for, from objective figures (last year's tax, or a
   * share of profit), when the pack knows the rule: meeting it avoids penalties.
   */
  prepayment?: { amount: number; requiredBps: number; covered: boolean; note: string };
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
  const gross = est.taxableShareBps !== undefined ? (revenue * est.taxableShareBps) / 10_000 : Math.max(0, revenue - expenses);
  const relief = est.profitReliefBps ? Math.min((gross * est.profitReliefBps) / 10_000, est.profitReliefMax ?? Infinity) : 0;
  const taxable = Math.max(0, gross - relief);
  const lines: EstimateResult['lines'] = [];
  const amountOf = (it: EstimateItem, taxableBasis: number): number => {
    const basis = (it.basis === 'revenue' ? revenue : taxableBasis) * (1 - (it.reliefBps ?? 0) / 10_000);
    let amount = it.zeroUpTo !== undefined && basis <= it.zeroUpTo ? 0 : it.steps ? stepAmount((basis * (it.stepBasisBps ?? 10_000)) / 10_000, it.steps) : applyBrackets(basis, it.brackets, it.mode ?? 'marginal');
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
  const deductibleShare = est.socialDeductibleBps !== undefined ? est.socialDeductibleBps / 10_000 : est.socialDeductible ? 1 : 0;
  // Fixed contributions the user entered (e.g. Argentina's autónomos) are deductible like the pack's own.
  const incomeBasis = Math.max(0, taxable - (socialTotal + (input.fixedSocial ?? 0)) * deductibleShare);
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
/** The estimate a check uses: the preset's (or the pack's), plus the region's income tax. */
export function estimateFor(pack: RulePack, presetId: string, region?: string): Estimate | undefined {
  const p = pack.presets.find((x) => x.id === presetId);
  if (!p) throw new Error(`no preset ${presetId} in ${pack.id}`);
  const base = p.estimate ?? pack.estimate;
  if (!base || !region) return base;
  const r = (pack.regions ?? []).find((x) => x.id === region);
  if (!r) throw new Error(`no region ${region} in ${pack.id}`);
  const kept = base.items.filter((it) => !(r.replaces ?? []).includes(it.name));
  return { ...base, items: [...kept, ...r.items], notes: [...(base.notes ?? []), ...(r.note ? [r.note] : [])] };
}

/** How far the reserve check can be trusted for this preset (see `Precision`). */
export function precisionOf(pack: RulePack, presetId: string): Precision {
  const p = pack.presets.find((x) => x.id === presetId);
  if (!p) throw new Error(`no preset ${presetId} in ${pack.id}`);
  if (p.precision) return p.precision;
  // Only VAT is reserved: the rate is the law's, nothing to estimate.
  if (!p.buckets.length || (p.covers && !p.covers.length)) return 'exact';
  const est = p.estimate ?? pack.estimate;
  if (!est) return 'none';
  const covered = est.items.filter((it) => (p.covers ?? ['incomeTax']).includes(it.kind));
  if (!covered.length) return 'exact';
  // One rate (above an optional zero band): flat.
  const flat = (it: EstimateItem) => it.mode === 'flat' || it.brackets.filter(([, bps]) => bps > 0).length <= 1;
  const fromRevenue = (it: EstimateItem) => it.basis === 'revenue' || est.taxableShareBps !== undefined;
  if (covered.every((it) => fromRevenue(it) && (flat(it) || it.basis === 'revenue'))) return 'exact';
  if (covered.every(fromRevenue)) return 'presumptive';
  if (covered.every(flat) && !(pack.regions ?? []).length) return 'exact-on-profit';
  return 'estimate';
}

export function checkReserve(pack: RulePack, presetId: string, input: ReserveInput): ReserveCheck {
  const p = pack.presets.find((x) => x.id === presetId);
  if (!p) throw new Error(`no preset ${presetId} in ${pack.id}`);
  const reserveBps = input.reserveBps ?? p.buckets.reduce((a, b) => a + b.bps, 0);
  const covers = input.covers ?? p.covers ?? ['incomeTax'];
  const est = estimateFor(pack, presetId, input.region);
  const reserved = (Math.max(0, input.revenue) * reserveBps) / 10_000;
  const notes = [...(est?.notes ?? [])];
  if (!est) {
    notes.push(`No estimate for ${pack.name}; compare the reserve with your adviser's figure.`);
    return { status: 'unknown', precision: 'none', covers, reserveBps, reserved, notes };
  }
  const r = estimateTaxes(est, input);
  let prepayment: ReserveCheck['prepayment'];
  const rule = pack.prepayment;
  if (rule && input.revenue > 0) {
    let amount: number | undefined;
    if (rule.method === 'prior-year' && input.lastYearTax !== undefined) {
      const bps = rule.above && (input.lastYearIncome ?? 0) > rule.above.income ? rule.above.bps : rule.bps;
      amount = (input.lastYearTax * bps) / 10_000;
    } else if (rule.method === 'share-of-profit') {
      amount = (r.taxable * rule.bps) / 10_000;
    }
    if (amount !== undefined) {
      const requiredBps = Math.max(0, Math.ceil((amount / input.revenue) * 10_000 - 1e-6));
      prepayment = { amount, requiredBps, covered: reserveBps >= requiredBps, note: rule.note };
    }
  }
  const owed = (covers.includes('incomeTax') ? r.incomeTax : 0) + (covers.includes('social') ? r.social : 0);
  // The small epsilon keeps exact rates (6% of revenue) from rounding up to 601 bps.
  const requiredBps = r.revenue > 0 ? Math.max(0, Math.ceil((owed / r.revenue) * 10_000 - 1e-6)) : 0;
  const precision = precisionOf(pack, presetId);
  const level = pack.enforcement?.level ?? 'standard';
  const marginBps = SAFETY_MARGIN_BPS[precision][level];
  const recommendedBps = requiredBps + marginBps;
  const status: ReserveStatus =
    reserveBps < requiredBps ? 'short' : reserveBps < recommendedBps ? 'tight' : reserveBps > recommendedBps + GENEROUS_MARGIN_BPS ? 'generous' : 'ok';
  return {
    ...r,
    status,
    precision,
    marginBps,
    recommendedBps,
    enforcement: level,
    covers,
    reserveBps,
    requiredBps,
    reserved,
    owed,
    prepayment,
    shortfall: Math.max(0, owed - reserved),
    surplus: Math.max(0, reserved - owed),
    notes,
  };
}
