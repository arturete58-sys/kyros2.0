import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clientTerms } from '../clients.js';
import { loadRulePack } from '../rulepacks.js';
import { split } from '../split.js';

const es = loadRulePack('es');
const rule = { vatBps: 2100, buckets: [{ name: 'irpf', bps: 2000 }] };

test('one address per client: each client’s payments split with that client’s VAT', () => {
  // A business at home that withholds 15% IRPF: Spanish VAT, and the vault keeps 5% (15 of the 20 are paid for you).
  const home = clientTerms(es, rule, { country: 'ES', business: true, withholdingBps: 1500 });
  assert.deepEqual([home.vatBps, home.withholdingBps, home.buckets, home.treatment], [2100, 1500, [{ name: 'irpf', bps: 500 }], 'domestic']);
  // An EU business with its VAT number: reverse charge, no VAT reserved.
  const de = clientTerms(es, rule, { country: 'DE', business: true, vatId: 'DE123456789' });
  assert.deepEqual([de.vatBps, de.treatment], [0, 'reverse-charge']);
  // The same payment of 1,000 to each address: 173.55 of VAT for the client at home, none for the German business.
  const g = 10_000_000_000n;
  assert.equal(split({ vatBps: home.vatBps, buckets: home.buckets }, g).vat, 1_735_537_191n);
  assert.equal(split({ vatBps: de.vatBps, buckets: de.buckets }, g).vat, 0n);
  // Outside the EU: no VAT. An EU business without a VAT number is a consumer, and the evidence says so.
  assert.equal(clientTerms(es, rule, { country: 'US', business: true }).vatBps, 0);
  const noId = clientTerms(es, rule, { country: 'FR', business: true }, { crossBorderB2cEur: 1_000 });
  assert.deepEqual([noId.vatBps, noId.treatment], [2100, 'seller-country-under-threshold']);
  assert.match(noId.evidence, /no VAT number/);
  // An EU consumer above the One-Stop Shop threshold: their country's rate.
  assert.equal(clientTerms(es, rule, { country: 'FR', business: false }, { crossBorderB2cEur: 50_000 }).vatBps, 2000);
  // A reduced rate chosen by the user applies at home.
  assert.equal(clientTerms(es, { ...rule, vatBps: 1000 }, { country: 'ES', business: false }).vatBps, 1000);
});
