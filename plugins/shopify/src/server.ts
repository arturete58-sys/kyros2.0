/**
 * Kyros for Shopify: a small server the shop runs (it holds a Shopify Admin
 * token, never a crypto key).
 *
 * Shopify only lets approved payments partners add a payment method to its
 * checkout, so the buyer picks a manual payment method (say "USDC on Stellar")
 * and pays right after placing the order:
 *
 *   1. `orders/create` webhook: the order's lines are grouped by VAT rate into
 *      the transfers that pay it, one per rate to the seller's Kyros address.
 *   2. The Thank you page (the extension in `extensions/`) and the order
 *      confirmation email link to `/pay/<order id>?n=<confirmation number>`,
 *      where `<kyros-checkout>` takes the payment from any Stellar wallet.
 *   3. The widget posts each transaction hash; the server checks it on chain
 *      (address, amount, after the order) and, when every transfer is in,
 *      marks the order paid in Shopify.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import type { CheckoutCheck, ShopConfig } from 'kyros-sdk';
import { orderPayments, type ShopifyOrder } from './orders.js';
import { markPaid, verifyWebhook, type AdminApi } from './shopify.js';

export interface KyrosShopifyOptions {
  config: ShopConfig;
  admin: AdminApi;
  /** The webhook signing secret (the app's client secret). */
  webhookSecret: string;
  /** Where this server is reachable from the buyer's browser, e.g. https://pay.myshop.com */
  publicUrl: string;
  /** The manual payment method's name in Shopify: orders paid with another method are ignored. */
  paymentName?: RegExp;
  /** A JSON file that keeps the orders' transfers and what is paid. */
  storeFile?: string;
  /** Checks a transfer on chain (the SDK's `verifyCheckoutPayment` against a Stellar RPC). */
  verify: (e: { hash: string; token: string; to: string; amount: bigint; notBefore?: string }) => Promise<CheckoutCheck>;
  /** Stellar RPC the buyer's browser uses (required on mainnet). */
  rpc?: string;
  /** The widget's script. Default: public/kyros-checkout.js. */
  widgetFile?: string;
  log?: (msg: string) => void;
}

interface OrderRecord {
  gid: string;
  n: string;
  createdAt: string;
  statusUrl?: string;
  payments: { inbox: string; bps: number; amount: string }[];
  paid: Record<string, string>;
  complete: boolean;
}

interface Store {
  orders: Record<string, OrderRecord>;
  used: Record<string, string>;
}

const json = (res: ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

const read = (req: IncomingMessage) =>
  new Promise<Buffer>((ok, ko) => {
    const parts: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 2_000_000) ko(new Error('too large'));
      else parts.push(c);
    });
    req.on('end', () => ok(Buffer.concat(parts)));
    req.on('error', ko);
  });

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function kyrosShopify(o: KyrosShopifyOptions): Server {
  const log = o.log ?? ((m: string) => console.log(new Date().toISOString(), m));
  const file = o.storeFile;
  let store: Store = file && existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Store) : { orders: {}, used: {} };
  const save = () => file && writeFileSync(file, JSON.stringify(store, null, 1));
  const widget = () => readFileSync(o.widgetFile ?? new URL('../../public/kyros-checkout.js', import.meta.url), 'utf8');
  const want = ['EURC', 'KEUR'].includes(o.config.asset.code.toUpperCase()) ? 'EUR' : 'USD';
  const paymentName = o.paymentName ?? /kyros|stellar|usdc|eurc/i;

  async function onOrder(order: ShopifyOrder) {
    if (!(order.payment_gateway_names ?? []).some((g) => paymentName.test(g))) return 'not a Kyros order';
    if (order.currency !== want) return `the order is in ${order.currency}; ${o.config.asset.code} pays ${want}`;
    const r = orderPayments(order, o.config.inboxes);
    if (r.missing.length) return `no Kyros payment address for VAT ${r.missing.map((b) => b / 100).join('%, ')}%: add it in the Kyros app`;
    // The id from the GraphQL id, as text: order ids can outgrow JavaScript's exact integers.
    const id = order.admin_graphql_api_id?.split('/').pop() ?? String(order.id);
    store.orders[id] ??= {
      gid: order.admin_graphql_api_id ?? `gid://shopify/Order/${order.id}`,
      n: order.confirmation_number ?? '',
      createdAt: order.created_at,
      statusUrl: order.order_status_url,
      payments: r.payments.map((p) => ({ inbox: p.inbox, bps: p.vatBps, amount: p.amount.toString() })),
      paid: {},
      complete: false,
    };
    save();
    return 'ok';
  }

  async function onStatus(id: string, body: { key?: string; hash?: string | null }) {
    const rec = store.orders[id];
    if (!rec || !body.key || body.key !== rec.n) return [404, { error: 'unknown order' }] as const;
    const hash = (body.hash ?? '').toLowerCase();
    if (hash && !rec.complete) {
      if (!/^[0-9a-f]{64}$/.test(hash)) return [422, { error: 'not a transaction hash' }] as const;
      if (store.used[hash]) return [409, { error: 'this transaction was already used' }] as const;
      const notBefore = new Date(Date.parse(rec.createdAt) - 60_000).toISOString();
      let matched = false;
      for (const p of rec.payments) {
        if (rec.paid[p.inbox]) continue;
        // The RPC may take a few seconds to show it.
        let v: CheckoutCheck = { ok: false, reason: 'not-found' };
        for (let i = 0; i < 3 && !v.ok; i++) {
          v = await o.verify({ hash, token: o.config.asset.contract, to: p.inbox, amount: BigInt(p.amount), notBefore });
          if (v.ok || v.reason !== 'not-found') break;
          await new Promise((r) => setTimeout(r, 2000));
        }
        if (v.ok) {
          rec.paid[p.inbox] = hash;
          store.used[hash] = id;
          matched = true;
          log(`order ${id}: ${p.amount} units at the VAT ${p.bps / 100}% address, ${hash}`);
          break;
        }
      }
      if (!matched) return [422, { error: 'the transaction does not pay this order' }] as const;
      if (rec.payments.every((p) => rec.paid[p.inbox])) {
        await markPaid(o.admin, rec.gid, Object.values(rec.paid));
        rec.complete = true;
        log(`order ${id}: paid`);
      }
      save();
    }
    return [200, { paid: Object.keys(rec.paid), complete: rec.complete, redirect: rec.complete ? (rec.statusUrl ?? null) : null }] as const;
  }

  function payPage(id: string, n: string) {
    const rec = store.orders[id];
    if (!rec || rec.n !== n) return null;
    const a = o.config.asset;
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pay order</title><style>body{font:16px/1.5 system-ui,sans-serif;margin:0;padding:24px 16px;display:flex;justify-content:center}main{width:100%;max-width:460px;display:flex;flex-direction:column;gap:16px}a{color:#2e4a6c}</style></head>
<body><main>
<kyros-checkout network="${esc(o.config.network)}" rpc="${esc(o.rpc ?? '')}" asset-contract="${esc(a.contract)}" asset-code="${esc(a.code)}"
 payments="${esc(JSON.stringify(rec.payments))}" status-url="${esc(`${o.publicUrl}/orders/${id}/status`)}" order-key="${esc(rec.n)}" return-url="${esc(rec.statusUrl ?? '')}"></kyros-checkout>
${rec.statusUrl ? `<a href="${esc(rec.statusUrl)}">← Order</a>` : ''}
</main><script src="${esc(o.publicUrl)}/kyros-checkout.js"></script></body></html>`;
  }

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://local');
      const m = url.pathname.match(/^\/(?:pay|orders)\/(\d+)(\/status)?$/);
      if (req.method === 'POST' && url.pathname === '/webhooks/orders-create') {
        const raw = await read(req);
        if (!verifyWebhook(raw, req.headers['x-shopify-hmac-sha256'] as string | undefined, o.webhookSecret)) return json(res, 401, { error: 'bad signature' });
        const order = JSON.parse(raw.toString('utf8')) as ShopifyOrder;
        const r = await onOrder(order);
        if (r !== 'ok' && r !== 'not a Kyros order') log(`order ${order.id}: ${r}`);
        return json(res, 200, { result: r });
      }
      if (req.method === 'POST' && m && m[2]) {
        res.setHeader('access-control-allow-origin', '*');
        const [code, body] = await onStatus(m[1], JSON.parse((await read(req)).toString('utf8') || '{}'));
        return json(res, code, body);
      }
      if (req.method === 'OPTIONS' && m && m[2]) {
        res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'content-type' });
        return res.end();
      }
      if (req.method === 'GET' && url.pathname.startsWith('/pay/') && m && !m[2]) {
        const page = payPage(m[1], url.searchParams.get('n') ?? '');
        if (!page) return json(res, 404, { error: 'unknown order (it may still be arriving: reload in a few seconds)' });
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(page);
      }
      if (req.method === 'GET' && url.pathname === '/kyros-checkout.js') {
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'public, max-age=3600' });
        return res.end(widget());
      }
      if (url.pathname === '/health') return json(res, 200, { ok: true });
      json(res, 404, { error: 'not found' });
    } catch (e) {
      log(`error: ${(e as Error).message}`);
      json(res, 500, { error: 'server error' });
    }
  });
}
