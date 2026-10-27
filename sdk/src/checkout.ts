/**
 * Checkout for online shops paid in stablecoins on Stellar.
 *
 * The seller gets one Kyros payment address (an inbox) per VAT rate they
 * charge, each registered once in their vault with that rate's terms
 * (`expect_payer`, keyed by the inbox). At checkout the order's lines are
 * grouped by VAT rate and the buyer's wallet pays each group to its inbox
 * with a token `transfer`: the vault then splits it on arrival, the VAT and
 * the income-tax reserve locked, the rest to the seller. The shop's server
 * never holds a key: it only checks on chain that the transfers it expects
 * happened, by their transaction hashes.
 *
 * The VAT of each line comes from the shop's own tax engine (WooCommerce
 * already computes it); `shopVat` is there for shops without one.
 */
import { rpc, type xdr } from '@stellar/stellar-sdk';
import { transfersInto } from './events.js';
import { vatRatesOn, type RulePack } from './rulepacks.js';
import type { Rule } from './split.js';
import type { KyrosClient } from './client.js';
import { x402Vat, x402RatesNeeded, type X402Buyer, type X402Vat } from './agents/x402.js';

/** One line of an order (a product, shipping, a fee), in token units (7 decimals). */
export interface ShopLine {
  /** Price before VAT. */
  net: bigint;
  /** The VAT the shop charged on it. */
  vat: bigint;
  /** The rate, in basis points (2100 = 21%). */
  vatBps: number;
}

/** The seller's payment addresses by VAT rate (bps → inbox contract). */
export type ShopInboxes = Record<number, string>;

export interface CheckoutPayment {
  inbox: string;
  vatBps: number;
  /** What the buyer pays into this inbox: the group's net plus its VAT. */
  amount: bigint;
}

/**
 * The transfers that pay an order: one per VAT rate in it, to the inbox
 * that splits that rate. Lists the rates the seller has no inbox for.
 */
export function checkoutPayments(lines: ShopLine[], inboxes: ShopInboxes): { payments: CheckoutPayment[]; missing: number[]; total: bigint } {
  const groups = new Map<number, bigint>();
  for (const l of lines) {
    if (l.net < 0n || l.vat < 0n) throw new Error('negative line amount');
    if (l.net + l.vat === 0n) continue;
    groups.set(l.vatBps, (groups.get(l.vatBps) ?? 0n) + l.net + l.vat);
  }
  const payments: CheckoutPayment[] = [];
  const missing: number[] = [];
  for (const [vatBps, amount] of [...groups].sort((a, b) => b[0] - a[0])) {
    const inbox = inboxes[vatBps];
    if (inbox) payments.push({ inbox, vatBps, amount });
    else missing.push(vatBps);
  }
  return { payments, missing, total: [...groups.values()].reduce((a, b) => a + b, 0n) };
}

/** "12.10" → 121000000n (token units). Throws on more decimals than the token has. */
export function toUnits(amount: string | number, decimals = 7): bigint {
  const s = typeof amount === 'number' ? amount.toFixed(decimals) : amount.trim();
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) throw new Error(`not an amount: ${amount}`);
  const frac = (m[2] ?? '').replace(/0+$/, '');
  if (frac.length > decimals) throw new Error(`more than ${decimals} decimals: ${amount}`);
  return BigInt(m[1]) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0');
}

/**
 * The VAT of a sale for shops without their own tax engine, from where the
 * buyer is and whether they buy as a business (EU rules for an EU seller):
 * the seller's rate at home; no VAT for an EU business buyer in another state
 * (services: reverse charge; goods: exempt intra-community supply); the
 * buyer's state's standard rate for EU consumers once cross-border B2C sales
 * pass EUR 10,000 a year (One-Stop Shop), the seller's below that; none for
 * buyers outside the EU (exports). Standard rates only: a product with a
 * reduced rate needs the shop's own tax settings.
 */
export function shopVat(seller: RulePack, buyer: X402Buyer, o: { kind?: 'goods' | 'services'; crossBorderB2cEur?: number; ossOptIn?: boolean; date?: Date | string } = {}): X402Vat {
  const v = x402Vat(seller, buyer, o);
  if (o.kind === 'goods' && v.treatment === 'reverse-charge') return { ...v, evidence: `EU business buyer ${buyer.vatId}: exempt intra-community supply` };
  return v;
}

/**
 * The seller's own VAT rates for a preset: the country's rates, or only its
 * regional ones when the preset charges a regional tax (the Canary Islands'
 * IGIC instead of Spain's IVA).
 */
export function shopOwnRates(seller: RulePack, presetId?: string, date: Date | string = new Date()): number[] {
  const regional = !!seller.presets.find((p) => p.id === presetId)?.vatRate?.startsWith('regional');
  return [...new Set(Object.entries(vatRatesOn(seller, date)).filter(([name]) => name.startsWith('regional') === regional).map(([, bps]) => bps))].sort((a, b) => a - b);
}

/**
 * The VAT rates a shop needs a payment address for: its own rates (standard
 * and reduced), zero (exports, EU business buyers), and with `oss` the 27 EU
 * standard rates.
 */
export function shopRatesNeeded(seller: RulePack, o: { oss?: boolean; presetId?: string; date?: Date | string } = {}): number[] {
  const own = shopOwnRates(seller, o.presetId, o.date);
  const regional = !!seller.presets.find((p) => p.id === o.presetId)?.vatRate?.startsWith('regional');
  const base = regional ? [0] : x402RatesNeeded(seller, o).filter((r) => r === 0 || o.oss || own.includes(r));
  return [...new Set([...base, ...own])].sort((a, b) => a - b);
}

/** Owner: payments arriving at `inbox` split with `vatBps` VAT and the vault's income-tax reserve. */
export function shopInboxTermsOp(client: KyrosClient, vault: string, inbox: string, vatBps: number, rule: Rule): xdr.Operation {
  return client.expectPayerOp(vault, inbox, { vatBps, withholdingBps: 0, buckets: rule.buckets.map((b) => ({ name: b.name, bps: b.bps })) });
}

/** The buyer's transfer for one payment (their wallet signs it). */
export function checkoutTransferOp(client: KyrosClient, token: string, buyer: string, p: CheckoutPayment): xdr.Operation {
  return client.transferOp(token, buyer, p.inbox, p.amount);
}

/** What a shop pastes into its plugin: network, token and the payment address for each rate. */
export interface ShopConfig {
  network: 'testnet' | 'pubnet';
  /** The token's classic asset ("USDC:GA5Z...") and its Stellar Asset Contract. */
  asset: { code: string; issuer: string; contract: string };
  /** Bps → inbox. */
  inboxes: ShopInboxes;
  /** The vault the inboxes pay into (for reference). */
  vault: string;
}

export type CheckoutCheck =
  | { ok: true; from: string; ledger: number; closedAt: string }
  | { ok: false; reason: 'not-found' | 'failed' | 'no-transfer' | 'wrong-amount' | 'too-old' };

/**
 * Whether transaction `hash` paid `amount` of `token` into `to`, at or after
 * `notBefore` (ISO date: the order's creation, so an older payment cannot be
 * reused). The shop also remembers the hashes it accepted.
 */
export async function verifyCheckoutPayment(
  server: rpc.Server,
  e: { hash: string; token: string; to: string; amount: bigint; notBefore?: string },
): Promise<CheckoutCheck> {
  let tx: rpc.Api.GetTransactionResponse;
  try {
    tx = await server.getTransaction(e.hash);
  } catch {
    return { ok: false, reason: 'not-found' };
  }
  if (tx.status === rpc.Api.GetTransactionStatus.NOT_FOUND) return { ok: false, reason: 'not-found' };
  if (tx.status !== rpc.Api.GetTransactionStatus.SUCCESS) return { ok: false, reason: 'failed' };
  const rows = (await transfersInto(server, [e.token], e.to, tx.ledger)).filter((r) => r.txHash === e.hash);
  if (!rows.length) return { ok: false, reason: 'no-transfer' };
  const paid = rows.reduce((a, r) => a + r.amount, 0n);
  if (paid !== e.amount) return { ok: false, reason: 'wrong-amount' };
  const closedAt = rows[0].closedAt;
  if (e.notBefore && Date.parse(closedAt) < Date.parse(e.notBefore)) return { ok: false, reason: 'too-old' };
  return { ok: true, from: rows[0].from, ledger: tx.ledger, closedAt };
}

/** `verifyCheckoutPayment` against the Stellar RPC at `rpcUrl` (for servers that do not use the Stellar SDK themselves). */
export function checkoutVerifier(rpcUrl: string): (e: { hash: string; token: string; to: string; amount: bigint; notBefore?: string }) => Promise<CheckoutCheck> {
  const server = new rpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith('http://') });
  return (e) => verifyCheckoutPayment(server, e);
}
