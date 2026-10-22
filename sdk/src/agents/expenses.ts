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
import { checkReserve } from '../estimate.js';
import type { RulePack } from '../rulepacks.js';
import type { Rule } from '../split.js';
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
  input: { revenue: number; expenses: Expense[]; activity?: string; incomeYtd?: number; withheldYtd?: number; paidYtd?: number },
): ExpenseImpact {
  const deductible = input.expenses.filter((e) => e.deductible);
  const expenses = deductible.reduce((a, e) => a + e.base, 0);
  const inputVat = deductible.reduce((a, e) => a + e.inputVat, 0);
  const currentBps = rule.buckets.reduce((a, b) => a + b.bps, 0);
  const before = checkReserve(pack, presetId, { revenue: input.revenue, activity: input.activity, reserveBps: currentBps });
  // The estimate's own expense ratio stands for "no expenses recorded": count the larger of the two.
  const after = checkReserve(pack, presetId, { revenue: input.revenue, activity: input.activity, expenses: Math.max(expenses, before.expenses ?? 0), reserveBps: currentBps });
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
