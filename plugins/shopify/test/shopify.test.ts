import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { checkoutVerifier, toUnits, type CheckoutCheck, type ShopConfig } from 'kyros-sdk';
import { orderPayments, type ShopifyOrder } from '../src/orders.js';
import { verifyWebhook } from '../src/shopify.js';
import { kyrosShopify } from '../src/server.js';

const C = (c: string) => `C${c.repeat(55)}`;
const inboxes = { 2100: C('D'), 1000: C('E'), 0: C('F') };
const u = (x: string) => toUnits(x);

// A Spanish shop (prices include VAT): a laptop at 21% with a 10 € discount, a book at 10%, shipping at 21%.
const euOrder: ShopifyOrder = {
  id: 5938273652345,
  admin_graphql_api_id: 'gid://shopify/Order/5938273652345',
  confirmation_number: 'XPAV284CT',
  currency: 'EUR',
  total_price: '984.95',
  taxes_included: true,
  created_at: '2026-10-27T18:00:00+01:00',
  order_status_url: 'https://myshop.example/123/orders/abc/authenticate?key=k',
  payment_gateway_names: ['EURC on Stellar (Kyros)'],
  line_items: [
    { price: '968.00', quantity: 1, discount_allocations: [{ amount: '10.00' }], tax_lines: [{ price: '166.26', rate: 0.21 }] },
    { price: '11.00', quantity: 2, tax_lines: [{ price: '2.00', rate: 0.1 }] },
  ],
  shipping_lines: [{ price: '4.95', discounted_price: '4.95', tax_lines: [{ price: '0.86', rate: 0.21 }] }],
};

test('a Shopify order as one transfer per VAT rate', () => {
  const r = orderPayments(euOrder, inboxes);
  assert.deepEqual(
    r.payments.map((p) => [p.vatBps, p.amount]),
    [
      [2100, u('962.95')],
      [1000, u('22')],
    ],
  );
  assert.equal(r.total, u('984.95'));
  // Prices before tax (United States style): the tax is added, a state and a county rate together.
  const us: ShopifyOrder = {
    ...euOrder,
    currency: 'USD',
    taxes_included: false,
    total_price: '108.25',
    line_items: [{ price: '50.00', quantity: 2, tax_lines: [{ price: '6.00', rate: 0.06 }, { price: '2.25', rate: 0.0225 }] }],
    shipping_lines: [],
  };
  const ru = orderPayments(us, { ...inboxes, 825: C('G') });
  assert.deepEqual(ru.payments.map((p) => [p.vatBps, p.amount]), [[825, u('108.25')]]);
  assert.deepEqual(orderPayments(us, inboxes).missing, [825]);
});

test('webhooks are trusted only with Shopify’s signature', () => {
  const body = JSON.stringify(euOrder);
  const sig = createHmac('sha256', 'secret').update(body).digest('base64');
  assert.equal(verifyWebhook(body, sig, 'secret'), true);
  assert.equal(verifyWebhook(body, sig, 'other'), false);
  assert.equal(verifyWebhook(body + ' ', sig, 'secret'), false);
  assert.equal(verifyWebhook(body, undefined, 'secret'), false);
});

test('order placed, paid from a Stellar wallet, marked paid in Shopify', async () => {
  const config: ShopConfig = { network: 'testnet', asset: { code: 'EURC', issuer: `G${'A'.repeat(55)}`, contract: C('B') }, inboxes, vault: C('V') };
  const dir = mkdtempSync(join(tmpdir(), 'kyros-shopify-'));
  const widgetFile = join(dir, 'w.js');
  writeFileSync(widgetFile, '/* widget */');
  const shopifyCalls: { query: string; variables: Record<string, unknown> }[] = [];
  const fakeShopify = (async (url: string, init: RequestInit) => {
    assert.match(String(url), /^https:\/\/myshop\.myshopify\.com\/admin\/api\/2025-10\/graphql\.json$/);
    const b = JSON.parse(String(init.body));
    shopifyCalls.push(b);
    const data = b.query.includes('orderMarkAsPaid') ? { orderMarkAsPaid: { order: { id: 'x' }, userErrors: [] } } : { metafieldsSet: { userErrors: [] }, tagsAdd: { userErrors: [] } };
    return new Response(JSON.stringify({ data }), { status: 200 });
  }) as typeof fetch;
  // On chain: two transfers, one per rate, each made after the order.
  const chain: Record<string, { to: string; amount: bigint }> = { ['a'.repeat(64)]: { to: inboxes[2100], amount: u('962.95') }, ['b'.repeat(64)]: { to: inboxes[1000], amount: u('22') } };
  const verify = async (e: { hash: string; to: string; amount: bigint }): Promise<CheckoutCheck> => {
    const t = chain[e.hash];
    if (!t) return { ok: false, reason: 'no-transfer' };
    if (t.to !== e.to) return { ok: false, reason: 'no-transfer' };
    return t.amount === e.amount ? { ok: true, from: 'GBUYER', ledger: 1, closedAt: '2026-10-27T17:05:00Z' } : { ok: false, reason: 'wrong-amount' };
  };
  const server = kyrosShopify({ config, admin: { shop: 'myshop.myshopify.com', token: 't', fetch: fakeShopify }, webhookSecret: 'secret', publicUrl: 'https://pay.example', storeFile: join(dir, 'store.json'), verify, widgetFile, log: () => {} });
  server.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const body = JSON.stringify(euOrder);
    const hook = (sig: string) => fetch(`${base}/webhooks/orders-create`, { method: 'POST', headers: { 'x-shopify-hmac-sha256': sig }, body });
    assert.equal((await hook('bad')).status, 401);
    assert.deepEqual(await (await hook(createHmac('sha256', 'secret').update(body).digest('base64'))).json(), { result: 'ok' });

    // The pay page needs the confirmation number.
    assert.equal((await fetch(`${base}/pay/${euOrder.id}?n=WRONG`)).status, 404);
    const page = await (await fetch(`${base}/pay/${euOrder.id}?n=XPAV284CT`)).text();
    assert.match(page, /<kyros-checkout network="testnet"/);
    assert.match(page, new RegExp(`&#34;inbox&#34;:&#34;${inboxes[2100]}&#34;`));
    assert.equal(await (await fetch(`${base}/kyros-checkout.js`)).text(), '/* widget */');

    const status = (hash: string | null, key = 'XPAV284CT') => fetch(`${base}/orders/${euOrder.id}/status`, { method: 'POST', body: JSON.stringify({ key, hash }) });
    assert.equal((await status(null, 'WRONG')).status, 404);
    assert.equal((await status('c'.repeat(64))).status, 422);
    assert.deepEqual(await (await status('a'.repeat(64))).json(), { paid: [inboxes[2100]], complete: false, redirect: null });
    assert.equal(shopifyCalls.length, 0);
    assert.equal((await status('a'.repeat(64))).status, 409);
    assert.deepEqual(await (await status('b'.repeat(64))).json(), { paid: [inboxes[2100], inboxes[1000]], complete: true, redirect: euOrder.order_status_url });
    assert.deepEqual(shopifyCalls[0].variables, { input: { id: euOrder.admin_graphql_api_id } });
    assert.match(shopifyCalls[1].query, /metafieldsSet[\s\S]*tagsAdd/);
    // What is paid survives a restart.
    assert.equal(JSON.parse(readFileSync(join(dir, 'store.json'), 'utf8')).orders[String(euOrder.id)].complete, true);
  } finally {
    server.close();
  }
});

test('live: a real testnet transfer into a Kyros address, checked on the Stellar RPC', { skip: !process.env.KYROS_LIVE_RESULTS }, async () => {
  const r = JSON.parse(readFileSync(process.env.KYROS_LIVE_RESULTS!, 'utf8'));
  const i = r.steps.findIndex((s: { step: string }) => s.step.startsWith('A second payment address for clients abroad'));
  const verify = checkoutVerifier('https://soroban-testnet.stellar.org');
  const e = { hash: r.steps[i + 1].tx, token: r.token, to: r.steps[i].detail, amount: u('1000'), notBefore: r.startedAt };
  const ok = await verify(e);
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.deepEqual(await verify({ ...e, amount: u('999') }), { ok: false, reason: 'wrong-amount' });
});
