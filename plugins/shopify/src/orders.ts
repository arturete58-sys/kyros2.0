/**
 * A Shopify order (the `orders/create` webhook's payload, REST format) as the
 * transfers that pay it: its lines, shipping and their taxes grouped by rate,
 * each group to the seller's Kyros payment address for that rate.
 */
import { checkoutPayments, toUnits, type CheckoutPayment, type ShopInboxes } from 'kyros-sdk';

interface TaxLine {
  price: string;
  /** 0.21 for 21%. */
  rate: number;
}

export interface ShopifyOrder {
  id: number;
  admin_graphql_api_id?: string;
  confirmation_number?: string;
  currency: string;
  total_price: string;
  taxes_included: boolean;
  created_at: string;
  order_status_url?: string;
  payment_gateway_names?: string[];
  financial_status?: string;
  line_items: { price: string; quantity: number; discount_allocations?: { amount: string }[]; tax_lines?: TaxLine[] }[];
  shipping_lines?: { price: string; discounted_price?: string; tax_lines?: TaxLine[] }[];
}

/** Shopify's amounts have two decimals at most; token units have seven. */
const units = (x: string | number) => toUnits(typeof x === 'number' ? x.toFixed(2) : x);

/**
 * The transfers for an order. Shopify's own rounding can leave the lines a
 * cent or so away from the order total: the largest transfer takes the
 * difference, so the buyer pays exactly the total.
 */
export function orderPayments(order: ShopifyOrder, inboxes: ShopInboxes): { payments: CheckoutPayment[]; missing: number[]; total: bigint } {
  const lines: { net: bigint; vat: bigint; vatBps: number }[] = [];
  const add = (base: bigint, taxes: TaxLine[] = []) => {
    const vat = taxes.reduce((a, t) => a + units(t.price), 0n);
    const vatBps = vat > 0n ? Math.round(taxes.reduce((a, t) => a + Number(t.rate), 0) * 10_000) : 0;
    // With prices that include tax, the line's amount already carries it.
    const paid = order.taxes_included ? base : base + vat;
    lines.push({ net: paid - vat, vat, vatBps });
  };
  for (const l of order.line_items) {
    const discount = (l.discount_allocations ?? []).reduce((a, d) => a + units(d.amount), 0n);
    add(units(l.price) * BigInt(l.quantity) - discount, l.tax_lines);
  }
  for (const s of order.shipping_lines ?? []) add(units(s.discounted_price ?? s.price), s.tax_lines);
  const r = checkoutPayments(lines, inboxes);
  const total = units(order.total_price);
  const diff = total - (r.total);
  if (r.payments.length && diff !== 0n) {
    if ((diff < 0n ? -diff : diff) > 100_000n * BigInt(lines.length)) throw new Error(`order ${order.id}: the lines do not add up to its total`);
    const largest = r.payments.reduce((a, p) => (p.amount > a.amount ? p : a));
    largest.amount += diff;
  }
  return { ...r, total };
}
