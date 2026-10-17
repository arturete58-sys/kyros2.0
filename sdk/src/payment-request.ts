/**
 * Expected payments: a payment the user is waiting for, with its own VAT and
 * withholding, that the vault splits exactly.
 *
 * The user issues the invoice with whatever invoicing tool they already use;
 * Kyros does not issue invoices. It only needs the invoice's number (whose
 * hash the payment carries), its amounts and rates, to tell the vault how to
 * split that payment (`expect_invoice`) and to build the payment request.
 *
 * Totals use exact decimals (cents, bigint) and the usual rounding: each
 * line to the cent, then VAT per rate, then the withholding.
 */
import { createHash } from 'node:crypto';
import { BPS, type Bucket } from './split.js';

export interface PaymentRequest {
  /** The number of the user's invoice, as printed on it. Only its sha256 goes onchain. */
  invoiceNumber: string;
  currency: string;
  lines: {
    description: string;
    /** Decimal string, e.g. "1" or "2.5". */
    quantity: string;
    /** Net unit price, decimal string with up to 6 decimals. */
    unitPrice: string;
    /** VAT rate in percent, e.g. "21"; "0" for exempt, reverse-charged or foreign clients. */
    vatRate: string;
  }[];
  /** Income tax the client withholds, as a percent of the base (Spanish IRPF on professional invoices, e.g. "15"). */
  withholding?: { rate: string };
  /** Where to pay: the user's Kyros inbox or vault, and the token. */
  payTo?: { address: string; asset: string };
}

function dec(s: string, scale: number): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s.trim());
  if (!m) throw new Error(`not a decimal: ${s}`);
  const frac = m[2] ?? '';
  if (frac.length > scale) throw new Error(`more than ${scale} decimals: ${s}`);
  return BigInt(m[1]) * 10n ** BigInt(scale) + BigInt(frac.padEnd(scale, '0') || '0');
}

/** Divides and rounds half up (amounts here are never negative). */
const divRound = (n: bigint, d: bigint) => (n * 2n + d) / (2n * d);

/** Cents to "1234.50". */
export function money(cents: bigint): string {
  const neg = cents < 0n;
  const v = neg ? -cents : cents;
  return `${neg ? '-' : ''}${v / 100n}.${(v % 100n).toString().padStart(2, '0')}`;
}

export interface RequestTotals {
  /** Net amount of each line, in cents. */
  lines: bigint[];
  /** VAT per rate. */
  vat: { rate: string; taxable: bigint; tax: bigint }[];
  net: bigint;
  tax: bigint;
  /** net + tax. */
  gross: bigint;
  withheld: bigint;
  /** gross - withheld: what the client pays. */
  payable: bigint;
}

export function requestTotals(r: PaymentRequest): RequestTotals {
  if (!r.lines.length) throw new Error('a payment request needs at least one line');
  const lines = r.lines.map((l) => divRound(dec(l.quantity, 4) * dec(l.unitPrice, 6), 10n ** 8n));
  const groups = new Map<string, { rate: string; taxable: bigint; tax: bigint }>();
  r.lines.forEach((l, i) => {
    const key = dec(l.vatRate, 2).toString();
    const g = groups.get(key) ?? { rate: l.vatRate, taxable: 0n, tax: 0n };
    g.taxable += lines[i];
    groups.set(key, g);
  });
  const vat = [...groups.values()].map((g) => ({ ...g, tax: divRound(g.taxable * dec(g.rate, 2), 10_000n) }));
  const net = lines.reduce((a, b) => a + b, 0n);
  const tax = vat.reduce((a, g) => a + g.tax, 0n);
  const withheld = r.withholding ? divRound(net * dec(r.withholding.rate, 2), 10_000n) : 0n;
  return { lines, vat, net, tax, gross: net + tax, withheld, payable: net + tax - withheld };
}

/** The 32-byte reference the payment carries: sha256 of the invoice number (same as `invoiceReference`). */
export function requestRef(r: PaymentRequest): Uint8Array {
  return createHash('sha256').update(r.invoiceNumber, 'utf8').digest();
}

/**
 * The terms to register in the vault (`expect_invoice`): the VAT (several
 * rates are blended into one), the client's withholding, and `buckets`, the
 * reserve on top of what the client withholds (e.g. a 20% income-tax
 * reserve becomes 5% when the client already withholds 15%).
 */
export function requestTerms(r: PaymentRequest, buckets: Bucket[]): { vatBps: number; withholdingBps: number; buckets: Bucket[] } {
  const t = requestTotals(r);
  const vatBps = t.net === 0n ? 0 : Number(divRound(t.tax * BPS, t.net));
  const withholdingBps = r.withholding ? Number(dec(r.withholding.rate, 2)) : 0;
  return { vatBps, withholdingBps, buckets };
}

/** The payable amount in a 7-decimal Stellar token paid 1:1 in the request's currency (EUR in EURC). */
export function payableUnits(r: PaymentRequest): bigint {
  return requestTotals(r).payable * 100_000n;
}
