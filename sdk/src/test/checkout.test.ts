import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, StrKey } from '@stellar/stellar-sdk';
import { checkoutPayments, shopOwnRates, shopRatesNeeded, shopVat, toUnits } from '../checkout.js';
import { loadRulePack } from '../rulepacks.js';

const C = () => StrKey.encodeContract(Buffer.from(Keypair.random().rawPublicKey()));

test('checkout: an order is paid with one transfer per VAT rate', () => {
  const inboxes = { 2100: C(), 1000: C(), 0: C() };
  const u = (x: string) => toUnits(x);
  const r = checkoutPayments(
    [
      { net: u('800'), vat: u('168'), vatBps: 2100 },
      { net: u('20'), vat: u('2'), vatBps: 1000 },
      { net: u('5'), vat: u('1.05'), vatBps: 2100 },
      { net: u('50'), vat: 0n, vatBps: 0 },
      { net: 0n, vat: 0n, vatBps: 400 },
    ],
    inboxes,
  );
  assert.deepEqual(r.payments, [
    { inbox: inboxes[2100], vatBps: 2100, amount: u('974.05') },
    { inbox: inboxes[1000], vatBps: 1000, amount: u('22') },
    { inbox: inboxes[0], vatBps: 0, amount: u('50') },
  ]);
  assert.deepEqual([r.missing, r.total], [[], u('1046.05')]);
  assert.deepEqual(checkoutPayments([{ net: u('10'), vat: u('0.4'), vatBps: 400 }], inboxes).missing, [400]);
  assert.equal(toUnits('0.0000001'), 1n);
  assert.throws(() => toUnits('0.00000001'));
});

test('checkout: the rates a shop needs, and the VAT of a sale without a tax engine', () => {
  const es = loadRulePack('es');
  assert.deepEqual(shopRatesNeeded(es, { presetId: 'general' }), [0, 400, 1000, 2100]);
  // The Canary Islands charge IGIC, not IVA.
  assert.deepEqual(shopOwnRates(es, 'canarias-igic'), [300, 700]);
  assert.deepEqual(shopRatesNeeded(es, { presetId: 'canarias-igic' }), [0, 300, 700]);
  // Selling to EU consumers above the threshold: every member state's standard rate too.
  const oss = shopRatesNeeded(es, { presetId: 'general', oss: true });
  assert.ok(oss.includes(1700) && oss.includes(2700) && oss.includes(400));
  assert.equal(shopVat(es, { country: 'FR', vatId: 'FR12345678901' }, { kind: 'goods' }).evidence, 'EU business buyer FR12345678901: exempt intra-community supply');
  assert.equal(shopVat(es, { country: 'FR' }, { kind: 'goods', crossBorderB2cEur: 2_000 }).vatBps, 2100);
  assert.equal(shopVat(es, { country: 'FR' }, { kind: 'goods', crossBorderB2cEur: 20_000 }).vatBps, 2000);
});
