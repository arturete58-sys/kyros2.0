/**
 * Document agent, invoices: reads an invoice's text (the PDF's text layer,
 * an email) and works out how its payment should split in the vault — the
 * VAT it carries (none when it is reverse-charged, exempt, outside the scope
 * or under a small-business franchise), what the client withholds (Spanish
 * IRPF, Italian ritenuta d'acconto...), and the reserve on top. The result
 * is the `InvoiceTerms` for `expect_invoice`, which the owner checks and
 * signs. It runs where it is called (in the app: the user's browser);
 * nothing is sent anywhere.
 *
 * Tax notices (the payment date the tax office sets) are read by
 * `readNotice` in notice.ts; `readDocument` tells the two apart.
 */
import { readNotice, parseNoticeAmount, type NoticeReading } from '../notice.js';
import type { Bucket, Rule } from '../split.js';
import { invoiceReference } from '../client.js';

export type VatTreatment = 'standard' | 'reverse-charge' | 'exempt' | 'outside-scope' | 'franchise';

export interface InvoiceReading {
  /** The invoice number as printed (its sha256 is the payment's reference). */
  number?: string;
  /** Net amount (taxable base), in the invoice's currency. */
  base?: number;
  vatRateBps?: number;
  vatAmount?: number;
  withholdingRateBps?: number;
  withholdingAmount?: number;
  /** What the client pays: base + VAT - withholding. */
  total?: number;
  currency?: string;
  treatment: VatTreatment;
  /** Why the treatment was chosen (the words found on the invoice). */
  treatmentEvidence?: string;
  /** The figures add up (base + VAT - withholding = total, within a cent). */
  consistent: boolean;
  warnings: string[];
}

export interface InvoicePlan {
  reading: InvoiceReading;
  /** For `expect_invoice`: the owner signs these. */
  terms: { vatBps: number; withholdingBps: number; buckets: Bucket[] };
  reference?: Uint8Array;
}

const VAT_WORDS = '(?:iva|i\\.v\\.a\\.|vat|mwst|ust|umsatzsteuer|mehrwertsteuer|tva|btw|igic|gst|moms|alv|dph|ddv|fpa)';
const WITHHOLDING_WORDS = "(?:retenci[oó]n(?:\\s+(?:a\\s+cuenta|profesional))?(?:\\s+(?:de\\s+)?irpf)?|irpf|ritenuta(?:\\s+d['’]acconto)?|withholding(?:\\s+tax)?|reten[cç][aã]o(?:\\s+na\\s+fonte)?|irs\\s+retido|quellensteuer|retenue(?:\\s+[àa]\\s+la\\s+source)?)";
const BASE_WORDS = '(?:base\\s+imponible|base\\s+tribut[aá]vel|base\\s+imposable|subtotal|sub-total|net\\s+amount|amount\\s+excl(?:uding)?\\.?\\s+vat|total\\s+excl\\.?|nettobetrag|netto(?:betrag)?|summe\\s+netto|imponibile|totale\\s+imponibile|montant\\s+ht|total\\s+ht|valor\\s+l[ií]quido|incidencia|importe\\s+neto|neto)';
const TOTAL_WORDS = '(?:total\\s+a\\s+pagar|total\\s+factura|importe\\s+total|total\\s+due|amount\\s+due|balance\\s+due|total\\s+amount|gesamtbetrag|rechnungsbetrag|zahlbetrag|totale\\s+(?:fattura|documento|da\\s+pagare)|net\\s+[àa]\\s+payer|total\\s+ttc|montant\\s+ttc|total\\s+a\\s+pagar|valor\\s+a\\s+pagar|total)';

const TREATMENTS: [VatTreatment, RegExp][] = [
  ['reverse-charge', /inversi[oó]n\s+del\s+sujeto\s+pasivo|reverse[\s-]charge|autoliquidaci[oó]n|steuerschuldnerschaft\s+des\s+leistungsempf[aä]ngers|autoliquidation|inversione\s+contabile|autoliquida[cç][aã]o|btw\s+verlegd|art(?:\.|[ií]culo|icle)?\s*196(?:\s+(?:of\s+)?(?:directive|directiva|richtlinie|directive))?|art\.?\s*84\.?\s*uno\.?\s*2/i],
  ['franchise', /franquicia\s+de\s+iva|franchise\s+en\s+base|293\s*b\s+du\s+cgi|kleinunternehmer|§\s*19\s*(?:abs\.?\s*1\s*)?ustg|regime\s+forfettario|forfettari|art\.?\s*53\.?\s*[ºo°]?\s*(?:do\s+)?civa|small\s+business\s+(?:scheme|exemption)/i],
  ['outside-scope', /no\s+sujet[oa]|not\s+subject\s+to\s+(?:vat|tax)|outside\s+the\s+scope|nicht\s+steuerbar|non\s+soumis|hors\s+(?:du\s+)?champ|fuori\s+campo|non\s+imponibile|n[aã]o\s+sujeit|art(?:\.|[ií]culo)?\s*(?:69|70)\s+(?:de\s+la\s+)?(?:ley\s+del\s+iva|liva)/i],
  ['exempt', /exent[oa]\s+(?:de\s+)?iva|iva\s+exent[oa]|operaci[oó]n\s+exenta|exempt\s+(?:from\s+)?vat|vat\s+exempt|steuerfrei|exon[eé]r[ée]?\s+de\s+tva|esente\s+iva|esente\s+art|isent[oa]\s+de\s+iva|art(?:\.|[ií]culo)?\s*20\s+(?:de\s+la\s+)?(?:ley\s+del\s+iva|liva)/i],
];

const money = '(\\d{1,3}(?:[.,\\s  \'’]\\d{3})*(?:[.,]\\d{1,2})?|\\d+(?:[.,]\\d{1,2})?)';
const pctRe = '(\\d{1,2}(?:[.,]\\d{1,2})?)\\s*%';

const bps = (s: string) => Math.round(Number(s.replace(',', '.')) * 100);

/** A rate written next to the words: "IVA 21%", "21 % IVA", "IVA (21%)", "Retención IRPF -15%". */
function rateNear(t: string, words: string): { bps: number; index: number } | undefined {
  const after = new RegExp(`${words}[^\\d%\\n]{0,24}?-?\\s*${pctRe}`, 'i').exec(t);
  const before = new RegExp(`${pctRe}\\s*(?:de\\s+|d['’]\\s*)?${words}`, 'i').exec(t);
  const m = after && before ? (after.index <= before.index ? after : before) : (after ?? before);
  if (!m) return undefined;
  const v = bps(m[1]);
  return v > 0 && v < 10_000 ? { bps: v, index: m.index } : undefined;
}

/** The amount right after the words (the last figure on that stretch, as tables put the rate first). */
function amountAfter(t: string, words: string): number | undefined {
  const re = new RegExp(`${words}\\b[^\\d\\n]{0,40}?(?:\\(?\\s*-?\\s*\\d{1,2}(?:[.,]\\d{1,2})?\\s*%\\s*\\)?[^\\d\\n]{0,12}?)?(?:€|eur|usd|\\$|£|chf)?\\s*-?\\s*${money}`, 'gi');
  let found: number | undefined;
  for (const m of t.matchAll(re)) {
    const v = parseNoticeAmount(m[1]);
    if (v !== undefined && v > 0) {
      found = v;
      break;
    }
  }
  return found;
}

function invoiceNumber(t: string): string | undefined {
  const m =
    /(?:factura|invoice|rechnung|facture|fattura|fatura|nota\s+fiscal)\s*(?:n[º°o.]?|no\.?|nr\.?|num(?:ber|ero|éro)?\.?|#)?\s*[:#.]?\s*([A-Z0-9][A-Z0-9\-\/.]{1,30}[A-Z0-9])/i.exec(t) ??
    /(?:n[º°]\s*(?:de\s+)?factura|invoice\s+(?:no|number|#)|rechnungs(?:nummer|-nr\.?)|num[ée]ro\s+de\s+facture|numero\s+fattura)\s*[:#.]?\s*([A-Z0-9][A-Z0-9\-\/.]{1,30}[A-Z0-9])/i.exec(t);
  const v = m?.[1];
  // A date or a plain word is not an invoice number.
  if (!v || !/\d/.test(v) || /^\d{1,2}[./-]\d{1,2}[./-]\d{2,4}$/.test(v)) return undefined;
  return v;
}

function currencyOf(t: string): string | undefined {
  if (/€|\beur\b|\beuros?\b/i.test(t)) return 'EUR';
  if (/\bchf\b/i.test(t)) return 'CHF';
  if (/£|\bgbp\b/i.test(t)) return 'GBP';
  if (/\busdc\b/i.test(t)) return 'USDC';
  if (/\$|\busd\b/i.test(t)) return 'USD';
  return undefined;
}

/** Reads an invoice's figures and VAT treatment from its text. */
export function readInvoice(text: string): InvoiceReading {
  const t = text.replace(/\s+/g, ' ');
  const warnings: string[] = [];
  let treatment: VatTreatment = 'standard';
  let treatmentEvidence: string | undefined;
  for (const [kind, re] of TREATMENTS) {
    const m = re.exec(t);
    if (m) {
      treatment = kind;
      treatmentEvidence = m[0];
      break;
    }
  }
  const vatRate = rateNear(t, VAT_WORDS);
  const wRate = rateNear(t, WITHHOLDING_WORDS);
  const base = amountAfter(t, BASE_WORDS);
  let vatAmount = amountAfter(t, `(?:cuota\\s+(?:de\\s+)?)?${VAT_WORDS}`);
  const withholdingAmount = amountAfter(t, WITHHOLDING_WORDS);
  const total = amountAfter(t, TOTAL_WORDS.replace('|total)', ')')) ?? amountAfter(t, '(?:total)');
  let vatRateBps = vatRate?.bps;
  if (treatment !== 'standard') {
    if (vatRateBps && vatRateBps > 0) warnings.push('vat-rate-with-zero-treatment');
    vatRateBps = 0;
    vatAmount = 0;
  }
  // A rate missing from the words can come from the amounts.
  if (vatRateBps === undefined && base && vatAmount !== undefined && vatAmount < base) vatRateBps = Math.round((vatAmount / base) * 10_000);
  let withholdingRateBps = wRate?.bps;
  if (withholdingRateBps === undefined && base && withholdingAmount) withholdingRateBps = Math.round((withholdingAmount / base) * 10_000);
  // The VAT amount the rate implies, when only one of them is printed.
  if (vatAmount === undefined && base !== undefined && vatRateBps !== undefined) vatAmount = Math.round(base * vatRateBps) / 10_000;
  const w = withholdingAmount ?? (base !== undefined && withholdingRateBps ? Math.round(base * withholdingRateBps) / 10_000 : 0);
  const expected = base !== undefined ? base + (vatAmount ?? 0) - w : undefined;
  const consistent = expected !== undefined && total !== undefined && Math.abs(expected - total) <= 0.011 + total * 0.0001;
  if (base === undefined) warnings.push('no-base');
  if (treatment === 'standard' && vatRateBps === undefined) warnings.push('no-vat-rate');
  if (total !== undefined && expected !== undefined && !consistent) warnings.push('totals-do-not-add-up');
  return {
    number: invoiceNumber(t),
    base,
    vatRateBps,
    vatAmount,
    withholdingRateBps,
    withholdingAmount: withholdingAmount ?? (w || undefined),
    total,
    currency: currencyOf(t),
    treatment,
    treatmentEvidence,
    consistent,
    warnings,
  };
}

/**
 * The vault terms for an invoice: its VAT, the client's withholding, and the
 * reserve on top of what the client already withholds (a 20% income-tax
 * reserve becomes 5% when the client withholds 15%), in the rule's first
 * bucket. A reverse-charged or foreign invoice carries no VAT.
 */
export function invoicePlan(reading: InvoiceReading, rule: Rule): InvoicePlan {
  const vatBps = reading.treatment === 'standard' ? (reading.vatRateBps ?? rule.vatBps) : 0;
  const withholdingBps = Math.min(reading.withholdingRateBps ?? 0, 10_000);
  const reserve = rule.buckets.reduce((a, b) => a + b.bps, 0);
  const left = Math.max(0, reserve - withholdingBps);
  const buckets: Bucket[] = left > 0 && rule.buckets.length ? [{ name: rule.buckets[0].name, bps: left }] : [];
  return { reading, terms: { vatBps, withholdingBps, buckets }, reference: reading.number ? invoiceReference(reading.number) : undefined };
}

export type DocumentKind = 'notice' | 'invoice' | 'payouts-csv' | 'tax-export-csv' | 'unknown';

export interface DocumentReading {
  kind: DocumentKind;
  notice?: NoticeReading;
  invoice?: InvoiceReading;
}

/** What a document is: a tax notice, an invoice, a payout list or a tax-tool export (CSV). */
export function classifyDocument(text: string, fileName = ''): DocumentKind {
  const head = text.slice(0, 2000);
  const firstLine = head.split(/\r?\n/)[0] ?? '';
  if (/\.csv$/i.test(fileName) || (firstLine.split(/[,;\t]/).length >= 3 && /\n/.test(head))) {
    if (/(sent amount|received amount|buy amount|sell amount|asset sent|base currency|txhash|tx-id|timestamp \(utc\))/i.test(firstLine)) return 'tax-export-csv';
    if (/(vault|b[óo]veda|address|direcci[óo]n|wallet|cuenta|account|recipient|destinatario)/i.test(firstLine) && /(amount|importe|cantidad|monto|betrag|montant|importo)/i.test(firstLine)) return 'payouts-csv';
  }
  const t = text.replace(/\s+/g, ' ');
  const invoiceScore =
    (/(factura|invoice|rechnung|facture|fattura|fatura)/i.test(t) ? 2 : 0) + (new RegExp(BASE_WORDS, 'i').test(t) ? 2 : 0) + (new RegExp(WITHHOLDING_WORDS, 'i').test(t) ? 1 : 0) + (/(cliente|client|customer|kunde|bill to|facturar a|destinatario)/i.test(t) ? 1 : 0);
  const noticeScore =
    (/(agencia tributaria|hacienda|aeat|finanzamt|steuerbescheid|vorauszahlung|hmrc|irs|direction g[ée]n[ée]rale des finances|impots\.gouv|agenzia delle entrate|autoridade tribut|belastingdienst|steuerverwaltung|iras|inland revenue|liquidaci[óo]n provisional|providencia de apremio|notice of assessment|avis d['’]imp[ôo]t|cartella|bescheid)/i.test(t) ? 3 : 0) +
    (/(f[äa]llig|a ingresar|plazo de ingreso|uiterlijk|due date|pay by|[ée]ch[ée]ance|scadenza|prazo)/i.test(t) ? 1 : 0);
  if (invoiceScore === 0 && noticeScore === 0) return 'unknown';
  return noticeScore >= invoiceScore ? 'notice' : 'invoice';
}

/** Reads a document of either kind. */
export function readDocument(text: string, fileName = '', today?: string): DocumentReading {
  const kind = classifyDocument(text, fileName);
  if (kind === 'notice') return { kind, notice: readNotice(text, today) };
  if (kind === 'invoice') return { kind, invoice: readInvoice(text) };
  return { kind };
}
