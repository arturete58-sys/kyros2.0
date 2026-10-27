import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { StrKey } from '@stellar/stellar-sdk';
import type { AddressInfo } from 'node:net';
import { paymentMiddleware, x402ResourceServer } from '@x402/express';
import { ExactStellarScheme } from '@x402/stellar/exact/server';
import type { FacilitatorClient } from '@x402/core/server';
import { kyrosPaymentOption } from '../src/index.js';

const USDC = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA';
const C = (n: number) => StrKey.encodeContract(Buffer.alloc(32, n));
const inboxes = { 0: C(1), 1900: C(2), 2100: C(3) };

// A facilitator that supports Stellar's exact scheme; the 402 response never reaches verify or settle.
const facilitator: FacilitatorClient = {
  getSupported: async () => ({ kinds: [{ x402Version: 2, scheme: 'exact', network: 'stellar:testnet', extra: { areFeesSponsored: true } }], extensions: [], signers: {} }),
  verify: async () => ({ isValid: false, invalidReason: 'test' }),
  settle: async () => ({ success: false, errorReason: 'test', transaction: '', network: 'stellar:testnet' }),
} as unknown as FacilitatorClient;

async function serve() {
  const server = new x402ResourceServer(facilitator).register('stellar:testnet', new ExactStellarScheme());
  const seen: string[] = [];
  const app = express();
  app.use(
    paymentMiddleware(
      {
        'GET /forecast': {
          accepts: kyrosPaymentOption({ seller: 'es', inboxes, network: 'stellar:testnet', asset: USDC, net: '0.01', crossBorderB2cEur: 50_000, onVat: (v) => seen.push(v.treatment) }),
          description: 'A forecast',
        },
      },
      server,
    ),
  );
  app.get('/forecast', (_req, res) => res.json({ ok: true }));
  const http = app.listen(0);
  await new Promise((r) => http.once('listening', r));
  return { url: `http://127.0.0.1:${(http.address() as AddressInfo).port}`, close: () => http.close(), seen };
}

async function required(url: string, headers: Record<string, string>) {
  const r = await fetch(`${url}/forecast`, { headers: { accept: 'application/json', ...headers } });
  assert.equal(r.status, 402);
  const h = r.headers.get('payment-required');
  assert.ok(h, 'PAYMENT-REQUIRED header');
  return JSON.parse(Buffer.from(h!, 'base64').toString('utf8')) as { accepts: { payTo: string; amount: string; asset: string; network: string; scheme: string }[] };
}

test('the 402 carries the buyer’s VAT and the Kyros address that splits it', async () => {
  const s = await serve();
  try {
    // A consumer in Spain: Spanish VAT, 0.01 + 21%.
    const es = await required(s.url, { 'x-buyer-country': 'ES' });
    assert.deepEqual([es.accepts[0].payTo, es.accepts[0].amount, es.accepts[0].asset, es.accepts[0].network], [inboxes[2100], '121000', USDC, 'stellar:testnet']);
    // A consumer in Germany above the One-Stop Shop threshold: German VAT.
    const de = await required(s.url, { 'cf-ipcountry': 'DE' });
    assert.deepEqual([de.accepts[0].payTo, de.accepts[0].amount], [inboxes[1900], '119000']);
    // A German business with its VAT number: reverse charge, no VAT.
    const b2b = await required(s.url, { 'x-buyer-country': 'DE', 'x-buyer-vat-id': 'DE123456789' });
    assert.deepEqual([b2b.accepts[0].payTo, b2b.accepts[0].amount], [inboxes[0], '100000']);
    // Outside the EU: no EU VAT.
    const us = await required(s.url, { 'x-buyer-country': 'US' });
    assert.deepEqual([us.accepts[0].payTo, us.accepts[0].amount], [inboxes[0], '100000']);
    assert.deepEqual(s.seen.filter((x, i, a) => a.indexOf(x) === i), ['domestic', 'oss-buyer-country', 'reverse-charge', 'outside-eu']);
  } finally {
    s.close();
  }
});
