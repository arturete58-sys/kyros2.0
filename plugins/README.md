# Selling online with Kyros

Plugins for sellers who get paid in stablecoins on Stellar: an online shop (WooCommerce or Shopify) and a pay-per-use API (x402). Every sale lands in the seller's Kyros vault, which splits it on arrival: the VAT and the income-tax reserve stay locked until they are due, and the rest goes to the seller.

None of them holds a key or the seller's money. The buyer pays from their own wallet straight into the seller's payment addresses, and the plugins only check on chain that the payment happened.

## How it works

1. **One payment address per VAT rate.** In the Kyros app, open **Settings → Sell online** and pick the rates you charge: your country's rates, 0% (exports, EU business buyers) and, if you sell to EU consumers above EUR 10,000 a year, the other member states' standard rates. Each address is an inbox that your vault splits with that rate (`expect_payer`, keyed by the inbox; you sign once per rate). The app gives you the settings to paste into the plugin. They contain no key.
2. **At checkout**, the order's lines are grouped by VAT rate and the buyer pays each group to its address with a token transfer.
3. **The split happens when the address is swept** (`sweep`, which anyone may call): the Kyros app does it while it is open, and the keeper does it all the time (`KEEPER_SECRET=S... kyros-keeper --network testnet --watch <inbox>:<token>`, one `--watch` per address; its key only pays network fees).

## WooCommerce (`woocommerce/kyros-checkout`)

A payment gateway for the classic and the block checkout.

- **Install**: zip the `kyros-checkout` folder and upload it in Plugins → Add new → Upload, or copy it to `wp-content/plugins`.
- **Settings**: WooCommerce → Settings → Payments → Kyros. Paste the configuration from the app. The store's currency must be the stablecoin's: USD for USDC, EUR for EURC. On mainnet, also set your Stellar RPC provider.
- **VAT**: comes from your WooCommerce tax settings. Each line, shipping and fee is grouped by its rate. If a rate has no Kyros address, the order page says which one to add.
- **Payment**: the order's payment page shows `<kyros-checkout>`. The buyer connects any Stellar wallet (LOBSTR, Freighter, xBull, Albedo, Hana, Rabet...) and signs one transfer per VAT rate in the order. After each transfer, the browser sends the transaction hash to `POST /wp-json/kyros/v1/orders/{id}`.
- **Checks before an order is marked paid**: Horizon confirms the transfer, to the right address, of the exact amount, made after the order was created. A transaction pays one order only, once.

The tests run in CI: the core in plain PHP, then inside WordPress with WooCommerce. An order there is paid with a real transfer made on testnet by the testnet demo.

## Shopify (`shopify`)

Shopify lets only approved payments partners add a payment method to its checkout. So Kyros works the way bank transfers do there: the buyer picks a manual payment method (for example "USDC on Stellar"), places the order, and pays right after, from any Stellar wallet. The order is marked paid when the transfers are seen on chain.

- **A small server you run** (`npm run build && npm start`). It holds a Shopify Admin token with `read_orders` and `write_orders`, never a crypto key. You can run it on any Node host. Settings come from the environment: `SHOPIFY_SHOP`, `SHOPIFY_ADMIN_TOKEN`, `SHOPIFY_WEBHOOK_SECRET`, `KYROS_CONFIG` (from the Kyros app), `PUBLIC_URL`, and `STELLAR_RPC` on mainnet.
- **What it does with each order:**
  - The `orders/create` webhook (signature checked) turns the order into one transfer per VAT rate. The rates come from Shopify's tax lines, with prices including or excluding tax and after discounts.
  - `/pay/<order>?n=<confirmation number>` shows `<kyros-checkout>`.
  - Each transaction hash is checked on the Stellar RPC: right address, exact amount, after the order, used once.
  - When every transfer is in, the order is marked paid (`orderMarkAsPaid`), with the transactions in a `kyros.transactions` metafield and a `kyros-paid` tag.
- **The Thank you page** (`extensions/kyros-pay-link`, a checkout UI extension on the 2026-01 API): when the buyer chose a manual payment method, a "Pay now" button and a QR code (to pay from a phone wallet) lead to that page. `shopify.app.toml.example` has the scopes and the webhook.

The tests cover a European order with VAT included, a US order with state and county tax, the webhook signature, and the whole flow against a stand-in for Shopify's Admin API. A live test checks a real testnet transfer on the Stellar RPC, and the extension is type-checked against Shopify's API.

## x402 (`x402`, `@kyros/x402`)

An x402 payment option for any server built on `@x402/core` (`@x402/express`, `@x402/hono`, `@x402/next`...). The price includes the buyer's VAT, so you net the same everywhere. `payTo` is your Kyros address for that VAT.

```ts
import { paymentMiddleware, x402ResourceServer } from '@x402/express';
import { ExactStellarScheme } from '@x402/stellar/exact/server';
import { kyrosPaymentOption } from '@kyros/x402';

const server = new x402ResourceServer(facilitator).register('stellar:testnet', new ExactStellarScheme());
app.use(paymentMiddleware({
  'GET /forecast': {
    accepts: kyrosPaymentOption({ seller: 'es', inboxes, network: 'stellar:testnet', asset: USDC, net: '0.01', crossBorderB2cEur: 4_000 }),
  },
}, server));
```

The buyer comes from `X-Buyer-Country` and `X-Buyer-VAT-ID`, or from the country your CDN reports (Cloudflare, Vercel, CloudFront). For EU consumers the law asks for two pieces of evidence that do not contradict each other: keep them with `onVat`. The VAT follows the same rules as the x402 agent: your rate at home; reverse charge for EU businesses; the buyer's rate for EU consumers above the threshold (yours below it); none outside the EU. The test runs the real `@x402/express` middleware and reads the 402 it answers.

## The widget (`checkout-widget`)

`<kyros-checkout>` is one script with no server of its own, for any shop that can render an HTML element and receive a POST:

```html
<script src="kyros-checkout.js"></script>
<kyros-checkout network="testnet" asset-contract="C..." asset-code="USDC"
  payments='[{"inbox":"C...","bps":2100,"amount":"121000000"}]'
  status-url="https://shop.example/api/kyros/orders/123" order-key="..."
  return-url="https://shop.example/thanks"></kyros-checkout>
```

The shop's endpoint checks each hash with `verifyCheckoutPayment` (SDK, Node) or `Kyros_Core::verify` (PHP), and answers `{ paid: [inbox...], complete, redirect }`.

## What is not here

- **Shopify as a payment method at checkout**: that needs Shopify's approval as a payments partner. Until then, the manual payment method above.
- **Stripe's crypto payments**: they settle into the merchant's Stripe balance, so the money never passes through the seller's own vault.
- **Mixed carts**: a cart with several VAT rates takes one signature per rate. A single transfer would need the vault to accept several rates in one payment, which is a contract change.
