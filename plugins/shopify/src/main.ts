/**
 * Runs Kyros for Shopify:
 *
 *   SHOPIFY_SHOP=myshop.myshopify.com SHOPIFY_ADMIN_TOKEN=shpat_... SHOPIFY_WEBHOOK_SECRET=... \
 *   KYROS_CONFIG='{"network":"testnet",...}' PUBLIC_URL=https://pay.myshop.com \
 *   PORT=8787 node dist/src/main.js
 *
 * KYROS_CONFIG comes from the Kyros app (Settings → Sell online). The Admin
 * token needs read_orders and write_orders. On mainnet set STELLAR_RPC to
 * your RPC provider.
 */
import { checkoutVerifier, type ShopConfig } from 'kyros-sdk';
import { kyrosShopify } from './server.js';

const env = (k: string, d?: string) => {
  const v = process.env[k] ?? d;
  if (v === undefined || v === '') throw new Error(`set ${k}`);
  return v;
};

const config = JSON.parse(env('KYROS_CONFIG')) as ShopConfig;
const rpcUrl = process.env.STELLAR_RPC || (config.network === 'testnet' ? 'https://soroban-testnet.stellar.org' : '');
if (!rpcUrl) throw new Error('set STELLAR_RPC (mainnet has no public RPC run by SDF)');

kyrosShopify({
  config,
  admin: { shop: env('SHOPIFY_SHOP'), token: env('SHOPIFY_ADMIN_TOKEN'), version: process.env.SHOPIFY_API_VERSION },
  webhookSecret: env('SHOPIFY_WEBHOOK_SECRET'),
  publicUrl: env('PUBLIC_URL').replace(/\/$/, ''),
  paymentName: process.env.KYROS_PAYMENT_NAME ? new RegExp(process.env.KYROS_PAYMENT_NAME, 'i') : undefined,
  storeFile: process.env.KYROS_STORE ?? 'kyros-orders.json',
  rpc: process.env.STELLAR_RPC,
  verify: checkoutVerifier(rpcUrl),
}).listen(Number(process.env.PORT ?? 8787), () => console.log(`Kyros for Shopify on :${process.env.PORT ?? 8787}`));
