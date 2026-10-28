/**
 * Expense agent: reads the user's supplier invoices and receipts (and lists
 * the payments that left their wallet, for them to tag), keeps the year's
 * deductible expenses and input VAT, and shows what they change:
 *
 *   - income-tax prepayments computed on net profit (Spain's modelo 130:
 *     20% of income minus expenses, year to date, minus what was withheld
 *     and already paid) come out lower, and so does the reserve the user
 *     needs: the agent recomputes the recommended reserve with the expenses
 *     and, when it is lower than the vault's, prepares the rule change the
 *     owner signs (it applies after the vault's notice);
 *   - input VAT reduces the VAT return: what the VAT bucket holds above the
 *     amount due goes back to the owner after the due date.
 *
 * Whether an expense is deductible depends on the activity and the law; the
 * agent proposes, the user decides. Everything stays on the device.
 */
import { checkReserve, estimateFor, estimateTaxes } from '../estimate.js';
import { calendarOf, presetVatBps, type RulePack } from '../rulepacks.js';
import type { Rule } from '../split.js';
import { taxYearStart } from '../installments.js';
import { dayString } from '../workdays.js';
import { readInvoice, type InvoiceReading } from './invoice.js';

export type ExpenseCategory = 'software' | 'equipment' | 'office' | 'travel' | 'professional' | 'telecom' | 'training' | 'marketing' | 'other';

export interface Expense {
  date: string;
  supplier?: string;
  /** Net amount (taxable base), in the pack's currency. */
  base: number;
  /** VAT paid on it (input VAT); 0 when none or not deductible. */
  inputVat: number;
  category: ExpenseCategory;
  /** The user confirmed it is for the activity. */
  deductible: boolean;
  /** Where it came from: an invoice's number, or a transaction hash. */
  ref?: string;
  /** Input VAT already taken back from the vault's VAT reserve (see `inputVatPlan`), in the pack's currency. */
  vatReclaimed?: number;
}

const CATEGORIES: [ExpenseCategory, RegExp][] = [
  ['software', /(software|licen[cs]|subscription|suscripci|saas|hosting|cloud|aws|google workspace|microsoft 365|github|adobe|figma|notion|dominio|domain|servidor|server)/i],
  ['telecom', /(tel[eé]fon|movil|m[óo]vil|fibra|internet|telecom|vodafone|movistar|orange|o2|telekom)/i],
  ['equipment', /(ordenador|port[áa]til|laptop|computer|monitor|pantalla|teclado|keyboard|rat[óo]n|mouse|tablet|impresora|printer|hardware)/i],
  ['travel', /(vuelo|flight|tren|train|renfe|hotel|taxi|uber|cabify|billete|ticket|parking|gasolina|fuel|kilometraje)/i],
  ['professional', /(gestor[íi]a|asesor[íi]a|abogad|lawyer|notar|accountant|contable|consultor|colegio profesional|seguro de responsabilidad|insurance)/i],
  ['office', /(coworking|alquiler de oficina|office rent|material de oficina|stationery|papeler)/i],
  ['training', /(curso|course|formaci[óo]n|training|libro|book|conferencia|conference|congreso)/i],
  ['marketing', /(publicidad|advertising|ads|marketing|linkedin premium|meta ads|google ads)/i],
];

/** A supplier invoice or receipt read as an expense (the user confirms it). */
export function expenseFromDocument(text: string, date = new Date().toISOString().slice(0, 10)): { expense: Expense; reading: InvoiceReading } {
  const r = readInvoice(text);
  const category = CATEGORIES.find(([, re]) => re.test(text))?.[0] ?? 'other';
  const supplier = /(?:^|\n)\s*([A-ZÁÉÍÓÚÑ][\w&.,' -]{2,60}?(?:S\.?L\.?U?|S\.?A\.?|GmbH|Ltd|LLC|Inc|SAS|SARL|S\.?r\.?l\.?|Lda))\b/.exec(text)?.[1]?.trim();
  const base = r.base ?? (r.total !== undefined && r.vatRateBps !== undefined ? Math.round((r.total / (1 + r.vatRateBps / 10_000)) * 100) / 100 : (r.total ?? 0));
  const inputVat = r.treatment === 'standard' ? (r.vatAmount ?? (r.vatRateBps !== undefined ? Math.round(base * r.vatRateBps) / 10_000 : 0)) : 0;
  return { expense: { date, supplier, base, inputVat, category, deductible: category !== 'other', ref: r.number }, reading: r };
}

export interface ExpenseImpact {
  /** Deductible expenses and input VAT counted. */
  expenses: number;
  inputVat: number;
  /** Reserve the estimate recommends without and with the expenses, bps of the base. */
  recommendedBefore?: number;
  recommendedAfter?: number;
  /** The vault's reserve now, bps. */
  currentBps: number;
  /** Rule to propose when the recommendation with expenses is lower (it applies after the notice). */
  proposal?: Rule;
  /** Spain: modelo 130 instalment year to date without and with the expenses. */
  es130?: { before: number; after: number };
}

/**
 * What the year's expenses change: the recommended reserve (from the pack's
 * estimate, with the expenses as deductible) and, in Spain, the modelo 130
 * instalment to date: 20% of (income − expenses) − withheld − already paid.
 */
export function expenseImpact(
  pack: RulePack,
  presetId: string,
  rule: Rule,
  input: { revenue: number; expenses: Expense[]; activity?: string; region?: string; incomeYtd?: number; withheldYtd?: number; paidYtd?: number },
): ExpenseImpact {
  const deductible = input.expenses.filter((e) => e.deductible);
  // VAT the user cannot recover (not registered, or a sales tax) is part of what the expense cost.
  const recoverable = vatRecovery(pack, presetId).recoverable;
  const expenses = deductible.reduce((a, e) => a + e.base + (recoverable ? 0 : e.inputVat), 0);
  const inputVat = recoverable ? deductible.reduce((a, e) => a + e.inputVat, 0) : 0;
  const currentBps = rule.buckets.reduce((a, b) => a + b.bps, 0);
  const before = checkReserve(pack, presetId, { revenue: input.revenue, activity: input.activity, region: input.region, reserveBps: currentBps });
  // The estimate's own expense ratio stands for "no expenses recorded": count the larger of the two.
  const after = checkReserve(pack, presetId, { revenue: input.revenue, activity: input.activity, region: input.region, expenses: Math.max(expenses, before.expenses ?? 0), reserveBps: currentBps });
  const out: ExpenseImpact = { expenses, inputVat, currentBps, recommendedBefore: before.recommendedBps, recommendedAfter: after.recommendedBps };
  // Only a cut the expenses themselves justify: lower than without them, and lower than the vault's.
  if (after.recommendedBps !== undefined && before.recommendedBps !== undefined && after.recommendedBps < before.recommendedBps && after.recommendedBps < currentBps && rule.buckets.length) {
    // Lower the first income-tax bucket by the difference, never below zero; the others stay.
    const cut = currentBps - after.recommendedBps;
    const buckets = rule.buckets.map((b, i) => (i === 0 ? { ...b, bps: Math.max(0, b.bps - cut) } : { ...b }));
    out.proposal = { vatBps: rule.vatBps, buckets };
  }
  if (pack.country === 'ES' && input.incomeYtd !== undefined) {
    const inst = (exp: number) => Math.max(0, Math.round((0.2 * (input.incomeYtd! - exp) - (input.withheldYtd ?? 0) - (input.paidYtd ?? 0)) * 100) / 100);
    out.es130 = { before: inst(0), after: inst(expenses) };
  }
  return out;
}

// ---- Deductions, country by country ----

/**
 * How expenses change the income tax in a preset's regime, read from its estimate:
 * - `profit`: tax and contributions on profit (revenue minus expenses): every expense lowers them;
 * - `partial`: part of what is owed is on revenue (a turnover or municipal tax), part on profit;
 * - `presumptive`: the law presumes the profit as a share of revenue: real expenses change nothing;
 * - `justify`: presumed profit, but a share of revenue must be justified with expenses (Portugal);
 * - `turnover`: a tax on revenue only;
 * - `no-income-tax`: nothing on income to lower;
 * - `unknown`: the pack has no estimate.
 */
export type IncomeDeduction = 'profit' | 'partial' | 'presumptive' | 'justify' | 'turnover' | 'no-income-tax' | 'unknown';

/**
 * What expenses do to the prepayments along the year:
 * - `es130`: computed on profit to date (Spain's modelo 130): expenses lower the next one;
 * - `fixed`: set from last year's tax or the tax office's notice: this year's expenses lower the final payment
 *   (in some countries the user can ask to lower them, `reduction`);
 * - `follows-reserve`: computed from what the vault reserves: a lower reserve lowers them;
 * - `none`: no prepayments, the tax is paid with the annual return.
 */
export type PrepaymentEffect = 'es130' | 'fixed' | 'follows-reserve' | 'none';

/** Where a lower prepayment can be asked for when this year's profit is lower (the procedure's own name). */
export const PREPAYMENT_REDUCTION: Record<string, string> = {
  DE: 'Antrag auf Herabsetzung der Vorauszahlungen (§ 37 Abs. 3 EStG)',
  GB: 'SA303 (reduce payments on account)',
  IE: 'preliminary tax: 90% of this year’s tax',
  CA: 'current-year option (instalments)',
  AU: 'PAYG instalment variation',
  IT: 'metodo previsionale (acconti)',
  JP: '予定納税額の減額申請',
  KR: '중간예납 추계액 신고 (first half below 30% of last year)',
};

/** Consumption taxes with no general credit for what the seller pays on its purchases. */
const SALES_TAX = new Set(['US', 'PR']);
/** Export presets whose input tax is not refunded as a rule (Pakistan's provincial sales tax on services). */
const EXPORT_NO_REFUND = new Set(['PK']);

export interface VatRecovery {
  recoverable: boolean;
  /** `registered`: charges VAT and deducts input VAT; `zero-rated`: exports, input VAT refunded; `not-registered`: VAT on purchases is a cost; `sales-tax`: no input credit; `no-vat`: the country has no consumption tax. */
  reason: 'registered' | 'zero-rated' | 'not-registered' | 'sales-tax' | 'no-vat';
}

/** Whether the VAT on the user's purchases comes back (deducted in the VAT return) in this preset. */
export function vatRecovery(pack: RulePack, presetId: string, date: Date | string = new Date()): VatRecovery {
  if (SALES_TAX.has(pack.country)) return { recoverable: false, reason: 'sales-tax' };
  if (!pack.calendar.vat && !(pack.vatRates ?? []).length && pack.presets.every((p) => p.vatBps === 0)) return { recoverable: false, reason: 'no-vat' };
  let vat = 0;
  try {
    vat = presetVatBps(pack, presetId, date);
  } catch {
    vat = pack.presets.find((p) => p.id === presetId)?.vatBps ?? 0;
  }
  if (vat > 0) return { recoverable: true, reason: 'registered' };
  if (/export/i.test(presetId) && !EXPORT_NO_REFUND.has(pack.country)) return { recoverable: true, reason: 'zero-rated' };
  return { recoverable: false, reason: 'not-registered' };
}

/** How expenses work for income tax in the preset (see `IncomeDeduction`). */
export function incomeDeduction(pack: RulePack, presetId: string, region?: string): IncomeDeduction {
  const p = pack.presets.find((x) => x.id === presetId);
  let est;
  try {
    est = estimateFor(pack, presetId, region);
  } catch {
    est = p?.estimate ?? pack.estimate;
  }
  if (!est) return p && p.buckets.length === 0 ? 'no-income-tax' : 'unknown';
  // Contributions are counted in the saving; the treatment is the income tax's.
  const tax = est.items.filter((i) => i.kind === 'incomeTax');
  // A single fee in place of income tax (Argentina's monotributo), set by revenue band.
  if (!tax.length) return (p?.covers ?? []).includes('incomeTax') && est.items.some((i) => i.basis === 'revenue') ? 'turnover' : 'no-income-tax';
  if (est.taxableShareBps !== undefined) return est.justifiedExpenses ? 'justify' : 'presumptive';
  const onRevenue = tax.filter((i) => i.basis === 'revenue').length;
  if (onRevenue === tax.length) return 'turnover';
  return onRevenue > 0 ? 'partial' : 'profit';
}

/** What the prepayments of the preset's calendar do with expenses (see `PrepaymentEffect`). */
export function prepaymentEffect(pack: RulePack, presetId: string): PrepaymentEffect {
  let dates;
  try {
    dates = calendarOf(pack, presetId).prepayments ?? [];
  } catch {
    dates = pack.calendar.prepayments ?? [];
  }
  if (!dates.length) return 'none';
  const kinds = dates.map((d) => d.amount?.kind ?? 'reservedSoFar');
  if (kinds.includes('es130')) return 'es130';
  if (kinds.some((k) => k === 'annualized' || k === 'reservedSoFar')) return 'follows-reserve';
  return 'fixed';
}

/** The expenses dated in the tax year that contains `at` (the pack's fiscal year). */
export function expensesInTaxYear(pack: RulePack, list: Expense[], at: Date = new Date()): { from: string; to: string; expenses: Expense[] } {
  const now = BigInt(Math.floor(at.getTime() / 1000));
  const start = taxYearStart(pack.calendar.fiscalYearStart, now);
  const end = taxYearStart(pack.calendar.fiscalYearStart, start + 86_400n, 1);
  const from = dayString(start + 86_400n);
  const to = dayString(end);
  return { from, to, expenses: list.filter((e) => e.date >= from && e.date <= to) };
}

export interface DeductionSummary {
  currency: string;
  /** Deductible expenses counted (what they cost for income tax: the base, plus VAT that does not come back). */
  expenses: number;
  count: number;
  byCategory: Partial<Record<ExpenseCategory, number>>;
  income: {
    treatment: IncomeDeduction;
    /** Estimated tax and contributions for the year without and with these expenses. */
    incomeTax?: { without: number; with: number };
    social?: { without: number; with: number };
    /** What the expenses save in the year (income tax plus contributions), by the pack's estimate. */
    saving?: number;
    /** Presumptive regimes: the share of revenue taxed whatever the expenses. */
    taxableShareBps?: number;
    /** Portugal: what the law asks to justify, what counts with no receipts, and what is still missing. */
    justify?: { required: number; automatic: number; missing: number };
  };
  vat: VatRecovery & { amount: number };
  prepayment: { effect: PrepaymentEffect; es130?: { before: number; after: number }; reduction?: string };
  /** The reserve the vault should keep with these expenses, and the rule to propose when it can be lower. */
  reserve: Pick<ExpenseImpact, 'recommendedBefore' | 'recommendedAfter' | 'currentBps' | 'proposal'>;
}

/**
 * The deductions of the user's expenses under their country's rules: what
 * they save in income tax and contributions (by the pack's estimate), the
 * input VAT that comes back (or why it does not), what they do to the
 * prepayments, and the reserve the vault should keep.
 */
export function deductionSummary(
  pack: RulePack,
  presetId: string,
  rule: Rule,
  input: { revenue: number; expenses: Expense[]; activity?: string; region?: string; incomeYtd?: number; withheldYtd?: number; paidYtd?: number; date?: Date },
): DeductionSummary {
  const vat = vatRecovery(pack, presetId, input.date);
  const deductible = input.expenses.filter((e) => e.deductible);
  const cost = (e: Expense) => e.base + (vat.recoverable ? 0 : e.inputVat);
  const expenses = deductible.reduce((a, e) => a + cost(e), 0);
  const byCategory: DeductionSummary['byCategory'] = {};
  for (const e of deductible) byCategory[e.category] = (byCategory[e.category] ?? 0) + cost(e);
  const treatment = incomeDeduction(pack, presetId, input.region);
  const income: DeductionSummary['income'] = { treatment };
  let est;
  try {
    est = estimateFor(pack, presetId, input.region);
  } catch {
    est = undefined;
  }
  const round = (x: number) => Math.round(x * 100) / 100;
  if (est && est.items.length && input.revenue > 0) {
    const r0 = estimateTaxes(est, { revenue: input.revenue, expenses: 0, activity: input.activity });
    const r1 = estimateTaxes(est, { revenue: input.revenue, expenses, activity: input.activity });
    income.incomeTax = { without: round(r0.incomeTax), with: round(r1.incomeTax) };
    if (r0.social > 0) income.social = { without: round(r0.social), with: round(r1.social) };
    income.saving = round(r0.incomeTax + r0.social - r1.incomeTax - r1.social);
    if (est.taxableShareBps !== undefined) income.taxableShareBps = est.taxableShareBps;
    const j = est.justifiedExpenses;
    if (j) {
      const required = (input.revenue * j.bps) / 10_000;
      const automatic = Math.max(j.automatic ?? 0, j.socialCounts ? r1.social : 0);
      income.justify = { required: round(required), automatic: round(automatic), missing: round(Math.max(0, required - automatic - expenses)) };
    }
  }
  const effect = prepaymentEffect(pack, presetId);
  const impact = expenseImpact(pack, presetId, rule, { revenue: input.revenue, expenses: input.expenses, activity: input.activity, region: input.region, incomeYtd: input.incomeYtd, withheldYtd: input.withheldYtd, paidYtd: input.paidYtd });
  return {
    currency: pack.currency,
    expenses: round(expenses),
    count: deductible.length,
    byCategory,
    income,
    vat: { ...vat, amount: vat.recoverable ? round(deductible.reduce((a, e) => a + e.inputVat, 0)) : 0 },
    prepayment: {
      effect,
      ...(effect === 'es130' && impact.es130 ? { es130: impact.es130 } : {}),
      ...(effect === 'fixed' && PREPAYMENT_REDUCTION[pack.country] ? { reduction: PREPAYMENT_REDUCTION[pack.country] } : {}),
    },
    reserve: { recommendedBefore: impact.recommendedBefore, recommendedAfter: impact.recommendedAfter, currentBps: impact.currentBps, proposal: rule.buckets.length ? impact.proposal : undefined },
  };
}

// ---- Input VAT against the VAT reserve ----

/** VAT a vault holds for one period in one token, and what is already being taken back. */
export interface VatHeld {
  period: number;
  token: string;
  /** What the period's `vat` bucket holds, minus open corrections of it (token units). */
  available: bigint;
  /** Token units per unit of the pack's currency (1 when the token is in that currency). */
  perUnit: number;
  /** The token is in the pack's currency: used first. */
  preferred: boolean;
}

export interface InputVatPlan {
  /** Corrections to propose: VAT taken back from a period's bucket, in token units. */
  claims: { period: number; token: string; amount: bigint }[];
  /** Input VAT each expense gets back by this plan, in the pack's currency (index into the list given). */
  byExpense: { index: number; vat: number }[];
  /** Input VAT taken back by the plan, and what is left because the vault holds too little VAT. */
  total: number;
  unclaimed: number;
}

const UNIT_7 = 10_000_000;

/**
 * Input VAT netted against the VAT reserve. A registered business deducts the
 * VAT on its supplier invoices from the VAT it collected in its VAT return, so
 * the vault holds more VAT than the return will ask for. This plans the
 * corrections that take that difference back: each deductible expense's input
 * VAT not yet taken back, from the VAT held for its own period first, then
 * later ones (the deduction goes in the return of the period of the invoice,
 * or a later one), in the pack's currency first. Never more than a bucket
 * holds; what does not fit stays `unclaimed`.
 */
export function inputVatPlan(expenses: Expense[], held: VatHeld[], periodOfDate: (date: string) => number): InputVatPlan {
  const left = held.map((h) => ({ ...h, left: h.available }));
  const claims = new Map<string, { period: number; token: string; amount: bigint }>();
  const byExpense: InputVatPlan['byExpense'] = [];
  let total = 0;
  let unclaimed = 0;
  const order = expenses.map((e, index) => ({ e, index })).sort((a, b) => (a.e.date < b.e.date ? -1 : a.e.date > b.e.date ? 1 : 0));
  for (const { e, index } of order) {
    if (!e.deductible) continue;
    let need = Math.round((e.inputVat - (e.vatReclaimed ?? 0)) * 100) / 100;
    if (need <= 0) continue;
    const from = periodOfDate(e.date);
    const pool = left.filter((h) => h.period >= from && h.left > 0n).sort((a, b) => a.period - b.period || Number(b.preferred) - Number(a.preferred));
    let got = 0;
    for (const h of pool) {
      if (need <= 0) break;
      // Whole cents of the pack's currency, converted to token units, never more than the bucket has left.
      let units = BigInt(Math.round(need * h.perUnit * 100)) * BigInt(UNIT_7 / 100);
      const capped = units > h.left;
      if (capped) units = h.left;
      if (units <= 0n) continue;
      // All of it fits: the whole amount; capped: what the units left are worth, rounded down to the cent.
      const cur = capped ? Math.floor((Number(units) / UNIT_7 / h.perUnit) * 100 + 1e-6) / 100 : need;
      h.left -= units;
      need = Math.round((need - cur) * 100) / 100;
      got = Math.round((got + cur) * 100) / 100;
      const k = `${h.period}|${h.token}`;
      const c = claims.get(k) ?? { period: h.period, token: h.token, amount: 0n };
      c.amount += units;
      claims.set(k, c);
    }
    if (got > 0) byExpense.push({ index, vat: got });
    total = Math.round((total + got) * 100) / 100;
    unclaimed = Math.round((unclaimed + Math.max(0, need)) * 100) / 100;
  }
  return { claims: [...claims.values()].sort((a, b) => a.period - b.period), byExpense, total, unclaimed };
}
