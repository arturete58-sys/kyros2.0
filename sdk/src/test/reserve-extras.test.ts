import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inputVatPlan, type Expense } from '../agents/expenses.js';
import { mixedPayers, type AddressPayment } from '../clients.js';
import { outsideDeposits, type WalletPayment } from '../wallets.js';
import { fixedFeeSuggestion, fixedPerPeriod } from '../fixed.js';
import { regimeChoices, suggestSetup } from '../activities.js';
import { loadRulePack, presetVatBps, termsFromPack } from '../rulepacks.js';
import { estimateFor, estimateTaxes } from '../estimate.js';
import { assetContract, flagsFromHorizon, holdersToAuthorize, issuerControls, SOVEREIGN_MONEY, sovereignFor } from '../sovereign.js';
import { dueAt, periodOf } from '../periods.js';
import { split, withFixed } from '../split.js';
import { fixedToScVal, fixedFromNative, splitFromScVal } from '../scval.js';
import { scValToNative, nativeToScVal, xdr } from '@stellar/stellar-sdk';

const U = 10_000_000n;
const Q = { kind: 'Quarter' } as const;
const q = (d: string) => periodOf(Q, BigInt(Date.parse(`${d}T12:00:00Z`) / 1000));
const exp = (date: string, base: number, inputVat: number, extra: Partial<Expense> = {}): Expense => ({ date, base, inputVat, category: 'software', deductible: true, ...extra });

test('input VAT comes back from the VAT held for its period, then later ones, never more than held', () => {
  const q1 = q('2027-02-10');
  const held = [
    { period: q1, token: 'EURC', available: 30n * U, perUnit: 1, preferred: true },
    { period: q1, token: 'USDC', available: 100n * U, perUnit: 1.1, preferred: false },
    { period: q1 + 1, token: 'EURC', available: 50n * U, perUnit: 1, preferred: true },
  ];
  const plan = inputVatPlan(
    [
      exp('2027-02-01', 100, 21), // all from Q1 EURC
      exp('2027-03-01', 100, 21), // 9 from Q1 EURC, 12 from Q1 USDC (13.2 USDC)
      exp('2027-05-01', 200, 42, { vatReclaimed: 2 }), // Q2 only: 40 left, 40 of the 50 held
      exp('2027-05-02', 100, 21, { deductible: false }), // not deductible: nothing
      exp('2027-06-01', 100, 21), // 10 left in Q2: 11 unclaimed
    ],
    held,
    q,
  );
  assert.deepEqual(plan.claims, [
    { period: q1, token: 'EURC', amount: 30n * U },
    { period: q1, token: 'USDC', amount: 132_000_000n },
    { period: q1 + 1, token: 'EURC', amount: 50n * U },
  ]);
  assert.deepEqual(plan.byExpense, [
    { index: 0, vat: 21 },
    { index: 1, vat: 21 },
    { index: 2, vat: 40 },
    { index: 4, vat: 10 },
  ]);
  assert.equal(plan.total, 92);
  assert.equal(plan.unclaimed, 11);
  // At an exchange rate the whole VAT comes back to the cent: 42 EUR at 1.1217 USD.
  const fx = inputVatPlan([exp('2027-02-01', 200, 42)], [{ period: q1, token: 'USDC', available: 483n * U, perUnit: 1.1217, preferred: false }], q);
  assert.deepEqual([fx.total, fx.unclaimed, fx.claims[0].amount], [42, 0, 471_100_000n]);
  // An expense after every period held gets nothing from earlier periods.
  const late = inputVatPlan([exp('2027-08-01', 100, 21)], held, q);
  assert.deepEqual([late.claims, late.unclaimed], [[], 21]);
});

const pay = (id: string, from: string, vatBps: number, amount: bigint): AddressPayment => ({ id, from, to: vatBps ? 'CGEN' : 'CABROAD', token: 'USDC', amount, at: '2027-02-10T10:00:00Z', vatBps });

test('a wallet that pays an address with VAT and one without is flagged, with the VAT on each side', () => {
  const list = [pay('a', 'GCLIENT', 2100, 1210n * U), pay('b', 'GCLIENT', 0, 1210n * U), pay('c', 'GHOME', 2100, 121n * U), pay('d', 'GABROAD', 0, 500n * U)];
  const m = mixedPayers(list, 2100);
  assert.equal(m.length, 1);
  assert.equal(m[0].from, 'GCLIENT');
  // Paid without VAT: if it owed VAT, 210 are missing. Paid with VAT: if it did not, 210 were set aside too many.
  assert.equal(m[0].missingVat, 210n * U);
  assert.equal(m[0].extraVat, 210n * U);
  // Once answered, the payments are settled and the wallet is no longer flagged.
  assert.deepEqual(mixedPayers(list, 2100, ['b']), []);
});

test('reserve for income received in another wallet: VAT and income-tax parts, by period and token', () => {
  const rule = { vatBps: 2100, buckets: [{ name: 'irpf', bps: 2000 }] };
  const p = (id: string, at: string, code: string, amount: bigint): WalletPayment => ({ id, wallet: 'GOTHER', from: 'GX', amount, code, at, hash: id });
  const deps = outsideDeposits(rule, [p('1', '2027-02-10T00:00:00Z', 'USDC', 1210n * U), p('2', '2027-02-11T00:00:00Z', 'USDC', 121n * U), p('3', '2027-05-01T00:00:00Z', 'EURC', 1210n * U), p('4', '2027-05-01T00:00:00Z', 'XYZ', U)], (at) => q(at.slice(0, 10)), (c) => (c === 'XYZ' ? undefined : `C_${c}`));
  const q1 = q('2027-02-10');
  assert.deepEqual(deps, [
    { period: q1, token: 'C_USDC', bucket: 'irpf', amount: 220n * U },
    { period: q1, token: 'C_USDC', bucket: 'vat', amount: 231n * U },
    { period: q1 + 1, token: 'C_EURC', bucket: 'irpf', amount: 200n * U },
    { period: q1 + 1, token: 'C_EURC', bucket: 'vat', amount: 210n * U },
  ]);
});

test('a fixed amount per period comes out of the net, as the vault does', () => {
  const rule = { vatBps: 2100, buckets: [{ name: 'irpf', bps: 2000 }] };
  const fixed = [{ bucket: 'social', token: 'T', amount: 300n * U }];
  const s = withFixed(split(rule, 1210n * U), fixed, 'T', {});
  assert.deepEqual([s.fixed, s.net, s.reserve], [300n * U, 500n * U, 710n * U]);
  // Partly filled already: only the rest; another token: nothing.
  assert.equal(withFixed(split(rule, 1210n * U), fixed, 'T', { social: 250n * U }).fixed, 50n * U);
  assert.equal(withFixed(split(rule, 1210n * U), fixed, 'OTHER', {}).fixed, 0n);
  // A month of 293.10 is 879.30 a quarter.
  assert.equal(fixedPerPeriod(293.1, Q), 8_793_000_000n);
  assert.equal(fixedPerPeriod(100, { kind: 'Month' }), 100n * U);
  // Encoding round trip, and a split from a vault that took a fixed amount.
  const f = fixedFromNative(scValToNative(fixedToScVal([{ bucket: 'social', token: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC', amount: 5n }])));
  assert.deepEqual(f, [{ bucket: 'social', token: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC', amount: 5n }]);
  const sv = xdr.ScVal.scvMap(
    (['base', 'fixed', 'gross', 'net', 'parts', 'reserve', 'vat'] as const).map(
      (k) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(k), val: k === 'parts' ? xdr.ScVal.scvVec([nativeToScVal(1n, { type: 'i128' })]) : nativeToScVal({ base: 8n, fixed: 4n, gross: 10n, net: 3n, reserve: 7n, vat: 2n }[k], { type: 'i128' }) }),
    ),
  );
  assert.equal(splitFromScVal(sv).fixed, 4n);
});

test('the self-employed fee as a fixed amount: Spain adds it, where the reserve already counts it, the reserve drops', () => {
  const es = loadRulePack('es');
  const rule = { vatBps: 2100, buckets: [{ name: 'irpf', bps: 2000 }] };
  const s = fixedFeeSuggestion(es, 'general', rule, { revenue: 30_000, activity: 'software' })!;
  // 30,000 revenue, 10% costs and the 5% general relief: 25,650 profit, 23,854.50 for the band (93%): 4,570.59 a year.
  assert.equal(s.bucket, 'social');
  assert.equal(s.monthly, 380.88);
  assert.equal(s.inReserve, false);
  assert.equal(s.proposal, undefined);
  const gb = loadRulePack('gb');
  const g = fixedFeeSuggestion(gb, 'standard', { vatBps: 2000, buckets: [{ name: 'income_tax', bps: 3000 }] }, { revenue: 50_000, activity: 'software' })!;
  assert.equal(g.inReserve, true);
  assert.ok(g.proposal!.buckets[0].bps < 3000);
});

test('Argentina: the monotributo is offered in onboarding and charges no IVA', () => {
  const ar = loadRulePack('ar');
  assert.deepEqual(regimeChoices(ar).map((r) => r.id), ['monotributo']);
  assert.deepEqual(regimeChoices(loadRulePack('es')), []);
  const s = suggestSetup(ar, { activity: 'software', client: 'business-local', revenue: 20_000_000, presetId: 'monotributo' });
  assert.equal(s.presetId, 'monotributo');
  assert.equal(s.vat.bps, 0);
  assert.equal(s.rule.vatBps, 0);
  assert.equal(s.rule.buckets[0].name, 'monotributo');
  assert.match(s.reasons[0], /Monotributo: no IVA/);
  // Without choosing it, a client at home leads to responsable inscripto with IVA.
  assert.equal(suggestSetup(ar, { activity: 'software', client: 'business-local', revenue: 20_000_000 }).presetId, 'responsable-inscripto');
  assert.throws(() => suggestSetup(ar, { activity: 'software', client: 'business-local', presetId: 'responsable-inscripto' }));
});

test('Bermuda and the Marshall Islands: the self-employed taxes and their dates', () => {
  const bm = loadRulePack('bm');
  const t = termsFromPack(bm, 'self-employed', '2026-10-30');
  // No VAT; payroll tax at 0.5% while the payroll is under BMD 200,000, due on the 15th after each quarter.
  assert.deepEqual(t.rule, { vatBps: 0, buckets: [{ name: 'payroll_tax', bps: 50 }] });
  assert.equal(estimateTaxes(estimateFor(bm, 'self-employed')!, { revenue: 100_000, expenses: 20_000 }).incomeTax, 400);
  assert.equal(estimateTaxes(estimateFor(bm, 'self-employed')!, { revenue: 300_000, expenses: 0 }).incomeTax, 6_000);
  // Social insurance: a fixed BMD 75.30 a week, suggested as a fixed fee (326.30 a month), not in the percentage reserve.
  assert.equal(estimateTaxes(estimateFor(bm, 'self-employed')!, { revenue: 100_000, expenses: 20_000 }).social, 3_915.6);
  const bmFee = fixedFeeSuggestion(bm, 'self-employed', t.rule, { revenue: 100_000 })!;
  assert.deepEqual([bmFee.monthly, bmFee.inReserve], [326.3, false]);
  const q = periodOf(t.period, BigInt(Date.parse('2026-11-10T00:00:00Z') / 1000));
  assert.equal(new Date(Number(dueAt(t.period, q, t.dues.default) - 1n) * 1000).toISOString().slice(0, 10), '2027-01-15');

  const mh = loadRulePack('mh');
  // Small business: 3% of revenue above USD 10,000, USD 80 below; due on the last day of the month after the quarter.
  const g = termsFromPack(mh, 'gross-revenue', '2026-10-30');
  assert.deepEqual(g.rule, { vatBps: 0, buckets: [{ name: 'gross_revenue_tax', bps: 300 }, { name: 'social_security', bps: 1725 }] });
  const est = estimateFor(mh, 'gross-revenue')!;
  assert.equal(estimateTaxes(est, { revenue: 8_000 }).incomeTax, 80);
  assert.equal(estimateTaxes(est, { revenue: 60_000 }).incomeTax, 1_500);
  // Social security 12% and health fund 5.25% of gross earnings, each up to its yearly maximum (6,400 and 1,400).
  assert.equal(estimateTaxes(est, { revenue: 20_000 }).social, 3_450);
  assert.equal(estimateTaxes(est, { revenue: 60_000 }).social, 7_800);
  assert.equal(new Date(Number(dueAt(g.period, q, g.dues.default) - 1n) * 1000).toISOString().slice(0, 10), '2027-01-31');
  // Registered for consumption tax: 12% monthly, 21 days after the month; net profit tax due 31 December after the tax year.
  const c = termsFromPack(mh, 'consumption-tax', '2026-10-30');
  assert.deepEqual(c.period, { kind: 'Month' });
  assert.equal(c.rule.vatBps, 1200);
  const nov = periodOf(c.period, BigInt(Date.parse('2026-11-10T00:00:00Z') / 1000));
  assert.equal(new Date(Number(dueAt(c.period, nov, c.dues.buckets.vat) - 1n) * 1000).toISOString().slice(0, 10), '2026-12-21');
  assert.equal(new Date(Number(dueAt(c.period, nov, c.dues.default) - 1n) * 1000).toISOString().slice(0, 10), '2027-12-31');
  // Before 1 October 2026 there was no consumption tax.
  assert.throws(() => presetVatBps(mh, 'consumption-tax', '2026-09-30'), /not in force/);
});

test('public money on Stellar: what exists, and what the issuer can do with it in a vault', () => {
  assert.deepEqual(sovereignFor('bm').map((m) => [m.name, m.status]), [['Bermuda Digital Dollar', 'announced']]);
  assert.deepEqual(sovereignFor('MH').map((m) => m.kind), ['sovereign-bond']);
  assert.deepEqual(sovereignFor('ES'), []);
  for (const m of SOVEREIGN_MONEY) assert.ok(m.sources.length > 0, m.id);
  // A typical central bank asset: holders need authorization, and the issuer can freeze and claw back.
  const f = flagsFromHorizon({ asset_code: 'CBDC', asset_issuer: 'G', flags: { auth_required: true, auth_revocable: true, auth_clawback_enabled: true } });
  assert.deepEqual(issuerControls(f), ['authorization', 'freeze', 'clawback']);
  assert.deepEqual(issuerControls(flagsFromHorizon({ asset_code: 'USDC', asset_issuer: 'G', flags: {} })), []);
  assert.deepEqual(holdersToAuthorize({ vault: 'CV', owner: 'GO', inboxes: ['CI', 'CV'] }), ['CV', 'CI', 'GO']);
  const kusd = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
  assert.match(assetContract('USDC', kusd, 'Test SDF Network ; September 2015'), /^C[A-Z2-7]{55}$/);
});
