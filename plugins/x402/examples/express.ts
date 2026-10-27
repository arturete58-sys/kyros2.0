/**
 * A paid API endpoint on x402 whose payments go into Kyros:
 *   KYROS_INBOXES='{"2100":"C...","1900":"C...","0":"C..."}' node dist/examples/express.js
 * The inboxes come from the Kyros app (Settings → Sell online).
 */
import express from 'express';
import { paymentMiddleware, x402ResourceServer } from '@x402/express';
import { HTTPFacilitatorClient } from '@x402/core/server';
import { ExactStellarScheme } from '@x402/stellar/exact/server';
import { kyrosPaymentOption } from '../src/index.js';

const facilitator = new HTTPFacilitatorClient({ url: process.env.FACILITATOR_URL ?? 'https://x402.org/facilitator' });
const server = new x402ResourceServer(facilitator).register('stellar:testnet', new ExactStellarScheme());

const app = express();
app.use(
  paymentMiddleware(
    {
      'GET /forecast': {
        description: 'Weather forecast',
        accepts: kyrosPaymentOption({
          seller: 'es',
          inboxes: JSON.parse(process.env.KYROS_INBOXES ?? '{}'),
          network: 'stellar:testnet',
          asset: process.env.KYROS_ASSET ?? 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
          net: '0.01',
          // Keep the evidence of where each buyer is (EU rules for consumers).
          onVat: (vat, buyer) => console.log(new Date().toISOString(), buyer.country ?? '?', vat.treatment, vat.vatBps),
        }),
      },
    },
    server,
  ),
);
app.get('/forecast', (_req, res) => res.json({ city: 'Valencia', tomorrow: 'sunny' }));
app.listen(4021, () => console.log('http://localhost:4021/forecast'));
