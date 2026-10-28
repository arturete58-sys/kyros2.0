/**
 * One payment address per client.
 *
 * An inbox splits its whole balance when it is swept, with no reference: it
 * cannot know who paid. So one address shared by a client at home (VAT
 * charged) and an EU business (reverse charge, no VAT) reserves the same VAT
 * for both. The fix is to make the address say who pays: each client gets
 * their own inbox, registered in the vault with that client's terms
 * (`expect_payer`, keyed by the inbox). Whatever arrives there splits by those
 * terms, however many payments are swept together.
 */
import type { xdr } from '@stellar/stellar-sdk';
import type { KyrosClient } from './client.js';
import type { RulePack } from './rulepacks.js';
import { split, type Rule } from './split.js';
import { x402Vat, type X402VatTreatment } from './agents/x402.js';

export interface ClientProfile {
  /** ISO country of the client. */
  country: string;
  /** The client buys as a business (and, in the EU, gives a VAT number). */
  business: boolean;
  /** The client's VAT number (EU businesses: reverse charge). */
  vatId?: string;
  /** Income tax the client withholds from each payment and pays to the tax office for you (Spain's IRPF retention), bps. */
  withholdingBps?: number;
}

export interface ClientTerms {
  vatBps: number;
  withholdingBps: number;
  buckets: Rule['buckets'];
  treatment: X402VatTreatment;
  /** What decided the VAT, in plain words (for the seller's records). */
  evidence: string;
}

/**
 * The terms a client's payments split with: the VAT from where the client is
 * and whether it is a business (your rate at home; reverse charge for an EU
 * business with a VAT number; none outside the EU; for an EU consumer, the
 * client's country's rate once your cross-border sales to consumers pass EUR
 * 10,000, yours below), and the vault's income-tax reserve, less what the
 * client withholds for you.
 */
export function clientTerms(seller: RulePack, rule: Rule, c: ClientProfile, o: { crossBorderB2cEur?: number; ossOptIn?: boolean } = {}): ClientTerms {
  const country = c.country.toUpperCase();
  const vat = x402Vat(seller, { country, vatId: c.business ? c.vatId : undefined }, o);
  // At home the vault's own rate applies (the user may charge a reduced one).
  const vatBps = vat.treatment === 'domestic' || vat.treatment === 'seller-country-under-threshold' ? rule.vatBps : vat.vatBps;
  // A business abroad with no VAT number is treated as a consumer by x402Vat: say why.
  const evidence = c.business && !c.vatId && country !== seller.country && vat.treatment !== 'outside-eu' && vat.treatment !== 'export' ? `${vat.evidence} (no VAT number given: treated as a consumer)` : vat.evidence;
  let withholding = Math.max(0, Math.min(10_000, Math.round(c.withholdingBps ?? 0)));
  // The withholding is income tax paid for you: the vault keeps less of its own.
  let left = withholding;
  const buckets = rule.buckets.map((b) => {
    const cut = Math.min(b.bps, left);
    left -= cut;
    return { name: b.name, bps: b.bps - cut };
  });
  if (withholding + buckets.reduce((a, b) => a + b.bps, 0) > 10_000) withholding = 10_000 - buckets.reduce((a, b) => a + b.bps, 0);
  return { vatBps, withholdingBps: withholding, buckets, treatment: vat.treatment, evidence };
}

/** Owner: payments arriving at the client's address split with the client's terms. */
export function clientTermsOp(client: KyrosClient, vault: string, inbox: string, t: ClientTerms): xdr.Operation {
  return client.expectPayerOp(vault, inbox, { vatBps: t.vatBps, withholdingBps: t.withholdingBps, buckets: t.buckets });
}

// ---- One wallet, addresses with and without VAT ----

/** A payment into one of the user's payment addresses, with the VAT that address splits with. */
export interface AddressPayment {
  id: string;
  from: string;
  /** The payment address (an inbox). */
  to: string;
  token: string;
  amount: bigint;
  at: string;
  /** The VAT the address splits with, bps (0: an address without VAT). */
  vatBps: number;
}

export interface MixedPayer {
  from: string;
  /** Its payments to addresses that reserve VAT, and to addresses that do not. */
  withVat: AddressPayment[];
  withoutVat: AddressPayment[];
  /**
   * If its payments without VAT did owe VAT at `homeVatBps` (a client at home
   * paying the address for clients abroad), the VAT missing from the reserve.
   */
  missingVat: bigint;
  /** If its payments with VAT did not owe it, the VAT reserved for them. */
  extraVat: bigint;
}

/**
 * Wallets that paid both an address with VAT and one without. The address
 * decides the VAT, so one of the two is wrong for that client: either a
 * client at home paid the address without VAT (the reserve is short of VAT,
 * the dangerous case) or a client abroad paid one with VAT (too much set
 * aside). Payments in `settled` (already answered) are left out.
 */
export function mixedPayers(payments: AddressPayment[], homeVatBps: number, settled: Iterable<string> = []): MixedPayer[] {
  const done = new Set(settled);
  const by = new Map<string, MixedPayer>();
  for (const p of payments) {
    if (done.has(p.id)) continue;
    const m = by.get(p.from) ?? { from: p.from, withVat: [], withoutVat: [], missingVat: 0n, extraVat: 0n };
    if (p.vatBps > 0) {
      m.withVat.push(p);
      m.extraVat += split({ vatBps: p.vatBps, buckets: [] }, p.amount).vat;
    } else {
      m.withoutVat.push(p);
      m.missingVat += split({ vatBps: homeVatBps, buckets: [] }, p.amount).vat;
    }
    by.set(p.from, m);
  }
  return [...by.values()].filter((m) => m.withVat.length && m.withoutVat.length);
}
