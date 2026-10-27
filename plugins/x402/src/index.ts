/**
 * Kyros for x402 sellers on Stellar.
 *
 * `kyrosPaymentOption` is an x402 payment option (for `@x402/express`,
 * `@x402/hono`, `@x402/next`... any server built on `@x402/core`) whose price
 * and `payTo` depend on the buyer: the price carries the buyer's VAT so the
 * seller nets the same everywhere, and `payTo` is the seller's Kyros payment
 * address for that VAT rate. The payment lands in that address (an inbox) and
 * the seller's vault splits it: the VAT and the income-tax reserve stay locked
 * until they are due, the rest goes to the seller.
 *
 * The seller makes the addresses once, in the Kyros app (Settings → Sell
 * online) or with `shopInboxTermsOp`; nothing here holds a key. The x402
 * facilitator verifies and settles the payment as usual.
 *
 *   import { paymentMiddleware, x402ResourceServer } from '@x402/express';
 *   app.use(paymentMiddleware({ 'GET /forecast': { accepts: kyrosPaymentOption({ ... }) } }, server));
 */
import type { HTTPRequestContext, PaymentOption } from '@x402/core/http';
import { loadRulePack, toUnits, x402Gross, x402Vat, type RulePack, type ShopInboxes, type X402Buyer, type X402Vat } from 'kyros-sdk';

export type StellarNetwork = 'stellar:testnet' | 'stellar:pubnet';

export interface KyrosX402Options {
  /** The seller's rule pack (`es`, `de`...) or a loaded pack. */
  seller: RulePack | string;
  /** The seller's Kyros payment address for each VAT rate (bps → inbox `C...`), from the app's Sell online screen. */
  inboxes: ShopInboxes;
  network: StellarNetwork;
  /** The token contract the buyer pays with (USDC's Stellar Asset Contract). */
  asset: string;
  /** What the seller nets per request, before VAT: "0.01" (token units, 7 decimals) or a bigint of units. */
  net: string | bigint;
  /** Who is buying, from the request. Default: `buyerFromHeaders`. */
  buyer?: (ctx: HTTPRequestContext) => X402Buyer | Promise<X402Buyer>;
  /** The seller's cross-border sales to EU consumers this year (EUR), for the EUR 10,000 One-Stop Shop threshold. Unknown: treated as above it (the buyer's country's rate); give it while you are below. */
  crossBorderB2cEur?: number;
  /** The seller opted into charging the buyer's country's VAT below the threshold. */
  ossOptIn?: boolean;
  /** Called with the VAT used for each request, to keep the evidence of where the buyer is. */
  onVat?: (vat: X402Vat, buyer: X402Buyer, ctx: HTTPRequestContext) => void;
  maxTimeoutSeconds?: number;
}

const header = (ctx: HTTPRequestContext, name: string) => ctx.adapter.getHeader(name)?.trim() || undefined;

/**
 * The buyer from the request: `X-Buyer-Country` and `X-Buyer-VAT-ID` sent by
 * the buyer's agent, else the country a CDN reports (Cloudflare, Vercel,
 * CloudFront). For EU consumers the law asks for two pieces of evidence that
 * do not contradict each other; keep them with `onVat`.
 */
export function buyerFromHeaders(ctx: HTTPRequestContext): X402Buyer {
  const country = header(ctx, 'x-buyer-country') ?? header(ctx, 'cf-ipcountry') ?? header(ctx, 'x-vercel-ip-country') ?? header(ctx, 'cloudfront-viewer-country');
  const vatId = header(ctx, 'x-buyer-vat-id');
  return { country: country && /^[A-Za-z]{2}$/.test(country) ? country.toUpperCase() : undefined, vatId };
}

/** The VAT, price (token units) and address for one request. */
export async function kyrosQuote(o: KyrosX402Options, ctx: HTTPRequestContext): Promise<{ vat: X402Vat; buyer: X402Buyer; amount: bigint; payTo: string }> {
  const pack = typeof o.seller === 'string' ? loadRulePack(o.seller) : o.seller;
  const buyer = await (o.buyer ?? buyerFromHeaders)(ctx);
  const vat = x402Vat(pack, buyer, { crossBorderB2cEur: o.crossBorderB2cEur, ossOptIn: o.ossOptIn });
  const payTo = o.inboxes[vat.vatBps];
  if (!payTo) throw new Error(`Kyros: no payment address for VAT ${vat.vatBps / 100}% (${vat.evidence}); add one in the Kyros app`);
  const net = typeof o.net === 'bigint' ? o.net : toUnits(o.net);
  return { vat, buyer, amount: x402Gross(net, vat.vatBps), payTo };
}

/**
 * An x402 payment option whose price includes the buyer's VAT and whose
 * `payTo` is the Kyros address that splits that VAT.
 */
export function kyrosPaymentOption(o: KyrosX402Options): PaymentOption {
  // Price and payTo are asked for separately; both come from the same quote of the same request.
  const quotes = new WeakMap<HTTPRequestContext, ReturnType<typeof kyrosQuote>>();
  const quote = (ctx: HTTPRequestContext) => {
    let q = quotes.get(ctx);
    if (!q) {
      q = kyrosQuote(o, ctx).then((r) => {
        o.onVat?.(r.vat, r.buyer, ctx);
        return r;
      });
      quotes.set(ctx, q);
    }
    return q;
  };
  return {
    scheme: 'exact',
    network: o.network,
    price: async (ctx) => ({ asset: o.asset, amount: (await quote(ctx)).amount.toString() }),
    payTo: async (ctx) => (await quote(ctx)).payTo,
    ...(o.maxTimeoutSeconds ? { maxTimeoutSeconds: o.maxTimeoutSeconds } : {}),
  };
}
