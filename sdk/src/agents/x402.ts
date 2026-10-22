/**
 * x402 billing agent: for developers who sell an API to AI agents with the
 * HTTP 402 protocol (x402) on Stellar. For each request it works out the VAT
 * the sale carries from where the buyer is and whether it is a business,
 * prices the endpoint so the seller's net is the same everywhere, and picks
 * the Kyros payment address (an inbox) whose terms split that VAT. The
 * buyer's payment (a token transfer to `payTo`) lands in the inbox and the
 * vault splits it: the seller's margin, the VAT, the income-tax reserve.
 *
 * How the VAT is chosen (an EU seller of electronically supplied services):
 *   - a business buyer in another EU state that gives its VAT number:
 *     reverse charge, no VAT (the buyer accounts for it);
 *   - a consumer in another EU state: the buyer country's rate once the
 *     seller's cross-border B2C sales pass EUR 10,000 a year (or it opted in),
 *     the seller's own rate below that (Directive 2006/112/EC, art. 58 and 59c;
 *     declared through the One-Stop Shop);
 *   - a buyer in the seller's country: the seller's rate;
 *   - a buyer outside the EU: no EU VAT (some countries, such as the UK,
 *     Switzerland or Norway, require foreign sellers of digital services to
 *     register there; this agent does not charge their tax).
 * Sellers outside the EU get their own country's rate at home and no VAT
 * abroad. The seller keeps the evidence of where the buyer is (two
 * non-contradictory pieces for consumers); the agent records what it used.
 */
import type { RulePack } from '../rulepacks.js';
import { vatRatesOn } from '../rulepacks.js';
import type { Rule } from '../split.js';
import type { KyrosClient } from '../client.js';
import type { xdr } from '@stellar/stellar-sdk';

/** Standard VAT rates of the EU member states (bps), checked every week against the Commission's TEDB by the law watch. */
export const EU_STANDARD_VAT: Record<string, number> = {
  AT: 2000, BE: 2100, BG: 2000, HR: 2500, CY: 1900, CZ: 2100, DK: 2500, EE: 2400, FI: 2550, FR: 2000, DE: 1900, GR: 2400, HU: 2700, IE: 2300,
  IT: 2200, LV: 2100, LT: 2100, LU: 1700, MT: 1800, NL: 2100, PL: 2300, PT: 2300, RO: 2100, SK: 2300, SI: 2200, ES: 2100, SE: 2500,
};
/** When the table was last confirmed against TEDB (by the law watch). */
export const EU_STANDARD_VAT_CHECKED = '2026-10-22';

/** Cross-border B2C sales in the EU above which the buyer's country's VAT applies (art. 59c). */
export const OSS_THRESHOLD_EUR = 10_000;

export interface X402Buyer {
  /** ISO country of the buyer, from the seller's evidence (billing address, IP country, the buyer's declaration). */
  country?: string;
  /** The buyer's VAT number, when it buys as a business. */
  vatId?: string;
}

export type X402VatTreatment = 'domestic' | 'reverse-charge' | 'oss-buyer-country' | 'seller-country-under-threshold' | 'outside-eu' | 'export' | 'unknown-buyer';

export interface X402Vat {
  vatBps: number;
  treatment: X402VatTreatment;
  /** What decided it, for the seller's records. */
  evidence: string;
}

const EU = new Set(Object.keys(EU_STANDARD_VAT));
const VAT_ID = /^[A-Z]{2}[0-9A-Z+*.]{2,13}$/;

/** The VAT a sale to `buyer` carries for a seller under `seller` (its rule pack). */
export function x402Vat(seller: RulePack, buyer: X402Buyer, o: { crossBorderB2cEur?: number; ossOptIn?: boolean; date?: Date | string } = {}): X402Vat {
  const own = vatRatesOn(seller, o.date ?? new Date()).standard ?? 0;
  const sellerEu = EU.has(seller.country);
  const c = buyer.country?.toUpperCase();
  const business = !!buyer.vatId && VAT_ID.test(buyer.vatId.replace(/\s/g, '').toUpperCase());
  if (!c) return { vatBps: own, treatment: 'unknown-buyer', evidence: 'no buyer country: the seller’s own rate, to be safe' };
  if (c === seller.country) return { vatBps: own, treatment: 'domestic', evidence: `buyer in ${c}` };
  if (!sellerEu) return { vatBps: 0, treatment: 'export', evidence: `buyer in ${c}, seller outside the EU: no VAT of the seller’s country` };
  if (!EU.has(c)) return { vatBps: 0, treatment: 'outside-eu', evidence: `buyer in ${c}, outside the EU` };
  if (business) return { vatBps: 0, treatment: 'reverse-charge', evidence: `EU business buyer ${buyer.vatId}: reverse charge` };
  if (o.ossOptIn || (o.crossBorderB2cEur ?? Infinity) > OSS_THRESHOLD_EUR)
    return { vatBps: EU_STANDARD_VAT[c], treatment: 'oss-buyer-country', evidence: `consumer in ${c}: ${c} VAT through the One-Stop Shop` };
  return { vatBps: own, treatment: 'seller-country-under-threshold', evidence: `consumer in ${c}, cross-border sales under EUR ${OSS_THRESHOLD_EUR}: the seller’s VAT` };
}

/**
 * The gross price for a net price in token units (7 decimals), so the seller
 * nets the same amount whatever VAT the sale carries.
 */
export function x402Gross(net: bigint, vatBps: number): bigint {
  return net + (net * BigInt(vatBps) + 9_999n) / 10_000n;
}

/** "$0.0121" for 121_000 units (x402 prices are dollar strings for USDC). */
export function x402Price(units: bigint): string {
  const s = units.toString().padStart(8, '0');
  const whole = s.slice(0, -7);
  const frac = s.slice(-7).replace(/0+$/, '');
  return `$${whole}${frac ? `.${frac}` : ''}`;
}

/** The seller's Kyros payment addresses, one per VAT rate (an inbox whose payer terms carry that VAT). */
export type X402Inboxes = Record<number, string>;

export interface X402Requirement {
  scheme: 'exact';
  network: 'stellar:testnet' | 'stellar:pubnet';
  /** Dollar string for USDC, as x402's Stellar scheme takes it. */
  price: string;
  /** Token units (7 decimals), the same as `price`. */
  amount: bigint;
  payTo: string;
  vat: X402Vat;
}

/**
 * The x402 requirement for one request: price with the buyer's VAT, and the
 * inbox that splits that VAT. Throws if the seller has no inbox for the rate
 * (create it with `x402InboxTermsOp` first).
 */
export function x402Requirement(
  seller: { pack: RulePack; inboxes: X402Inboxes; network: X402Requirement['network'] },
  netUnits: bigint,
  buyer: X402Buyer,
  o: { crossBorderB2cEur?: number; ossOptIn?: boolean; date?: Date | string } = {},
): X402Requirement {
  const vat = x402Vat(seller.pack, buyer, o);
  const payTo = seller.inboxes[vat.vatBps];
  if (!payTo) throw new Error(`no Kyros inbox for VAT ${vat.vatBps / 100}%: create one with x402InboxTermsOp`);
  const amount = x402Gross(netUnits, vat.vatBps);
  return { scheme: 'exact', network: seller.network, price: x402Price(amount), amount, payTo, vat };
}

/** The VAT rates a seller needs an inbox for: its own, zero, and the EU rates when it sells to EU consumers above the threshold. */
export function x402RatesNeeded(seller: RulePack, o: { oss?: boolean; date?: Date | string } = {}): number[] {
  const own = vatRatesOn(seller, o.date ?? new Date()).standard ?? 0;
  const rates = new Set([own, 0]);
  if (o.oss && EU.has(seller.country)) Object.values(EU_STANDARD_VAT).forEach((r) => rates.add(r));
  return [...rates].sort((a, b) => a - b);
}

/**
 * Owner: payments arriving through `inbox` split with `vatBps` VAT and the
 * vault's income-tax buckets (`expect_payer`, keyed by the inbox address).
 */
export function x402InboxTermsOp(client: KyrosClient, vault: string, inbox: string, vatBps: number, rule: Rule): xdr.Operation {
  return client.expectPayerOp(vault, inbox, { vatBps, withholdingBps: 0, buckets: rule.buckets.map((b) => ({ ...b })) });
}
