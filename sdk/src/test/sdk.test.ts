import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Account, Keypair, Networks, scValToNative, nativeToScVal, TransactionBuilder, BASE_FEE, Contract, xdr } from '@stellar/stellar-sdk';
import { split, validateRule, RuleError, formatAmount, parseAmount } from '../split.js';
import { periodOf, periodStart, periodEnd, periodLabel, dueDate, civilFromDays, daysFromCivil, type PeriodKind } from '../periods.js';
import { listRulePacks, loadRulePack, termsFromPack, vatRatesOn, presetVatBps, checkRuleVat, customRule, vatChanges, vatUpdatePlan } from '../rulepacks.js';
import { checkReserve, estimateTaxes } from '../estimate.js';
import { ruleToScVal, periodKindToScVal, splitFromScVal } from '../scval.js';
import { sep7TxUri } from '../sep7.js';
import { toCsv } from '../events.js';
import { invoiceReference } from '../client.js';

const here = dirname(fileURLToPath(import.meta.url));
const vectors = JSON.parse(readFileSync(join(here, '..', '..', '..', 'test-vectors', 'vectors.json'), 'utf8'));

test('the worked example: 1,210 USDC -> 800 net, 210 VAT, 200 income tax', () => {
  const s = split({ vatBps: 2100, buckets: [{ name: 'irpf', bps: 2000 }] }, parseAmount('1210'));
  assert.equal(formatAmount(s.net), '800');
  assert.equal(formatAmount(s.vat), '210');
  assert.equal(formatAmount(s.parts[0]), '200');
  assert.equal(formatAmount(s.reserve), '410');
});

test('every shared split vector matches the contract arithmetic', () => {
  assert.ok(vectors.splits.length >= 50);
  for (const c of vectors.splits) {
    const rule = { vatBps: c.vat_bps, buckets: c.buckets };
    validateRule(rule);
    const s = split(rule, BigInt(c.gross));
    assert.equal(s.base.toString(), c.base, c.rule);
    assert.equal(s.vat.toString(), c.vat, c.rule);
    assert.deepEqual(s.parts.map(String), c.parts, c.rule);
    assert.equal(s.reserve.toString(), c.reserve, c.rule);
    assert.equal(s.net.toString(), c.net, c.rule);
    assert.equal(s.net + s.reserve, s.gross);
  }
});

test('invalid rules are refused like in the contract', () => {
  assert.throws(() => validateRule({ vatBps: 10_001, buckets: [] }), RuleError);
  assert.throws(() => validateRule({ vatBps: 0, buckets: [{ name: 'vat', bps: 1 }] }), RuleError);
  assert.throws(() => validateRule({ vatBps: 0, buckets: [{ name: 'a', bps: 1 }, { name: 'a', bps: 1 }] }), RuleError);
  assert.throws(() => validateRule({ vatBps: 0, buckets: [{ name: 'a', bps: 6000 }, { name: 'b', bps: 4001 }] }), RuleError);
});

test('periods match the shared calendar vectors', () => {
  const kinds: [PeriodKind, string][] = [
    [{ kind: 'Month' }, 'month'],
    [{ kind: 'Quarter' }, 'quarter'],
    [{ kind: 'Year' }, 'year'],
    [{ kind: 'Seconds', seconds: 60n }, 'seconds60'],
  ];
  for (const p of vectors.periods) {
    const ts = BigInt(p.ts);
    for (const [k, key] of kinds) {
      const id = periodOf(k, ts);
      assert.equal(id, p[key].id, `${key} ${p.ts}`);
      assert.equal(periodStart(k, id).toString(), p[key].start, `${key} ${p.ts}`);
      assert.equal(periodEnd(k, id).toString(), p[key].end, `${key} ${p.ts}`);
    }
  }
  assert.equal(periodLabel({ kind: 'Quarter' }, 2027 * 4), '2027-Q1');
  // Q1 2027 ends on 1 April; Spain's pack adds 30 days.
  assert.equal(dueDate({ kind: 'Quarter' }, 2027 * 4, 30n * 86_400n), BigInt(Date.UTC(2027, 4, 1) / 1000));
  for (let z = -800_000n; z < 800_000n; z += 9_973n) {
    const [y, m, d] = civilFromDays(z);
    assert.equal(daysFromCivil(y, m, d), z);
  }
});

test('the Spain rule pack loads and gives valid vault terms', () => {
  const pack = loadRulePack('es');
  const t = termsFromPack(pack, 'general');
  assert.deepEqual(t.rule, { vatBps: 2100, buckets: [{ name: 'irpf', bps: 2000 }] });
  assert.deepEqual(t.period, { kind: 'Quarter' });
  assert.equal(t.dueOffsetSecs, 30n * 86_400n);
  for (const p of pack.presets) termsFromPack(pack, p.id);
  assert.throws(() => termsFromPack(pack, 'nope'));
});

test('every bundled rule pack is valid, and presets can override the calendar', () => {
  const ids = listRulePacks();
  const expected = ['ad', 'ae', 'ar', 'au', 'bh', 'br', 'bs', 'ca', 'ch', 'co', 'cy', 'de', 'ee', 'es', 'fr', 'gb', 'ge', 'hk', 'id', 'ie', 'in', 'it', 'jp', 'ke', 'kr',
    'ky', 'li', 'lu', 'mc', 'mt', 'mx', 'ng', 'nl', 'pa', 'ph', 'pk', 'pr', 'pt', 'sg', 'sv', 'th', 'tr', 'ua', 'us', 'vn', 'za'];
  assert.deepEqual(ids, expected);
  for (const id of ids) {
    const pack = loadRulePack(id);
    assert.equal(pack.id, id);
    assert.equal(pack.country, id.toUpperCase());
    assert.ok(pack.sources && pack.sources.length > 0, `${id} cites sources`);
    assert.ok(pack.reviewed, `${id} has a review date`);
    for (const p of pack.presets) {
      // The rate written in each preset is the one in force when the pack was reviewed.
      assert.equal(presetVatBps(pack, p.id, pack.reviewed!), p.vatBps, `${id}/${p.id} VAT`);
      const t = termsFromPack(pack, p.id, pack.reviewed!);
      const s = split(t.rule, parseAmount('1000'));
      assert.equal(s.net + s.reserve, s.gross, `${id}/${p.id}`);
    }
  }
  const ae = loadRulePack('ae');
  assert.deepEqual(termsFromPack(ae, 'vat-only').period, { kind: 'Quarter' });
  assert.deepEqual(termsFromPack(ae, 'vat-and-corporate-tax').period, { kind: 'Year' });
  assert.equal(termsFromPack(ae, 'vat-and-corporate-tax').dueOffsetSecs, 273n * 86_400n);
  // Germany, VAT 19% + 30%: 1,190 gross -> 190 VAT, 300 income tax, 700 net.
  const de = split(termsFromPack(loadRulePack('de'), 'standard').rule, parseAmount('1190'));
  assert.deepEqual([de.vat, de.parts[0], de.net].map((x) => formatAmount(x)), ['190', '300', '700']);
});

test('contract types encode as Soroban expects (sorted struct keys, enum vectors)', () => {
  const r = scValToNative(ruleToScVal({ vatBps: 2100, buckets: [{ name: 'irpf', bps: 2000 }] }));
  assert.deepEqual(Object.keys(r), ['buckets', 'vat_bps']);
  assert.equal(r.vat_bps, 2100);
  assert.deepEqual(scValToNative(periodKindToScVal({ kind: 'Quarter' })), ['Quarter']);
  assert.deepEqual(scValToNative(periodKindToScVal({ kind: 'Seconds', seconds: 120n })), ['Seconds', 120n]);
  const map = ruleToScVal({ vatBps: 1, buckets: [] }).map()!;
  assert.deepEqual(map.map((e) => e.key().sym().toString()), ['buckets', 'vat_bps']);
  // A Split as the contract returns it: a map with sorted symbol keys.
  const i = (n: bigint) => nativeToScVal(n, { type: 'i128' });
  const entry = (k: string, v: xdr.ScVal) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(k), val: v });
  const sv = xdr.ScVal.scvMap([
    entry('base', i(8n)), entry('gross', i(10n)), entry('net', i(7n)),
    entry('parts', xdr.ScVal.scvVec([i(1n)])), entry('reserve', i(3n)), entry('vat', i(2n)),
  ]);
  assert.deepEqual(splitFromScVal(sv), { gross: 10n, base: 8n, vat: 2n, parts: [1n], reserve: 3n, net: 7n });
});

test('SEP-7 links carry the transaction and the message', () => {
  const src = new Account(Keypair.random().publicKey(), '1');
  const tx = new TransactionBuilder(src, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
    .addOperation(new Contract('CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC').call('quote'))
    .setTimeout(60)
    .build();
  const uri = sep7TxUri(tx, { msg: 'Invoice INV-2027-001', networkPassphrase: Networks.TESTNET });
  assert.ok(uri.startsWith('web+stellar:tx?xdr='));
  const q = new URLSearchParams(uri.slice('web+stellar:tx?'.length));
  assert.equal(q.get('xdr'), tx.toXDR());
  assert.equal(q.get('msg'), 'Invoice INV-2027-001');
  assert.throws(() => sep7TxUri(tx, { msg: 'x'.repeat(301) }));
});

test('CSV export: one line per event, amounts in whole units, links to transactions', () => {
  const csv = toCsv([
    { ledger: 1, closedAt: '2027-02-10T12:00:00Z', txHash: 'ab', kind: 'received', token: 'C1', period: 8108, gross: 12_100_000_000n, net: 8_000_000_000n, vat: 2_100_000_000n, parts: [2_000_000_000n], reserve: 4_100_000_000n, reference: 'ff' },
  ]);
  const [head, line] = csv.trim().split('\n');
  assert.equal(head.split(',')[0], 'closed_at');
  assert.ok(line.includes(',1210,800,210,200,'));
  assert.ok(line.endsWith('/tx/ab'));
});

test('invoice references are 32-byte hashes, never the invoice itself', () => {
  const r = invoiceReference('INV-2027-001');
  assert.equal(r.length, 32);
  assert.notDeepEqual(invoiceReference('INV-2027-002'), r);
});

test('VAT tables follow their dates; a vault learns when its rate changes', () => {
  const ee = loadRulePack('ee');
  assert.equal(vatRatesOn(ee, '2025-06-30').standard, 2200);
  assert.equal(vatRatesOn(ee, '2025-07-01').standard, 2400);
  assert.equal(termsFromPack(ee, 'standard', '2025-03-01').rule.vatBps, 2200);

  // Vietnam's temporary 8% ends after 2026: the rule is current now and flagged for 2027.
  const vn = loadRulePack('vn');
  assert.equal(presetVatBps(vn, 'company-vat-8', '2026-12-31'), 800);
  assert.throws(() => presetVatBps(vn, 'company-vat-8', '2027-01-01'));
  const now = checkRuleVat(vn, 'company-vat-8', 800, '2026-10-16');
  assert.equal(now.upToDate, true);
  assert.deepEqual(now.next, { from: '2027-01-01', bps: undefined, proposed: false });
  assert.equal(checkRuleVat(vn, 'company-vat-8', 800, '2027-01-02').upToDate, false);

  // Switzerland: 8.5% from 2028 is only proposed, so it is reported but never applied.
  const ch = loadRulePack('ch');
  assert.deepEqual(checkRuleVat(ch, 'standard', 810, '2026-10-16').next, { from: '2028-01-01', bps: 850, proposed: true });
  assert.equal(presetVatBps(ch, 'standard', '2028-06-01'), 810);
  assert.equal(vatChanges(ch, '2026-10-16').length, 1);

  // Thailand: back to the statutory 10% on 1 October 2027 unless extended.
  const th = loadRulePack('th');
  assert.equal(presetVatBps(th, 'vat-registered', '2027-09-30'), 700);
  assert.equal(presetVatBps(th, 'vat-registered', '2027-10-01'), 1000);
  assert.equal(checkRuleVat(th, 'vat-registered', 900, '2026-10-16').upToDate, false);

  // What the app asks the owner to sign so the vault follows the table.
  const thRule = { vatBps: 700, buckets: [{ name: 'pit', bps: 1800 }] };
  const plan = vatUpdatePlan(th, 'vat-registered', thRule, 7 * 86_400, '2026-10-16');
  assert.equal(plan.action, 'schedule');
  assert.deepEqual(plan.rule, { vatBps: 1000, buckets: [{ name: 'pit', bps: 1800 }] });
  assert.equal(plan.effectiveAt, BigInt(Date.UTC(2027, 9, 1) / 1000));
  assert.equal(plan.signBy!.toISOString(), '2027-09-24T00:00:00.000Z');
  assert.equal(vatUpdatePlan(th, 'vat-registered', thRule, 0, '2027-10-02').action, 'update');
  assert.equal(vatUpdatePlan(ch, 'standard', { vatBps: 810, buckets: [] }, 0, '2026-10-16').action, 'review');
  assert.equal(vatUpdatePlan(vn, 'company-vat-8', { vatBps: 800, buckets: [] }, 0, '2026-10-16').action, 'review');
  assert.equal(vatUpdatePlan(ee, 'standard', { vatBps: 2400, buckets: [] }, 0, '2026-10-16').action, 'none');

  // A rule the user composes: a country rate plus their own reserve.
  assert.deepEqual(customRule(loadRulePack('es'), { vatRate: 'reduced', reserves: [{ name: 'irpf', bps: 1500 }] }, '2026-10-16'),
    { vatBps: 1000, buckets: [{ name: 'irpf', bps: 1500 }] });
  assert.throws(() => customRule(loadRulePack('es'), { vatRate: 'nope', reserves: [] }));
});

test('reserve check: short, ok, generous, and exact regimes', () => {
  // Spain, EUR 80,000 a year with EUR 8,000 of expenses: 5% hard-to-justify expenses (capped at EUR 2,000)
  // leave EUR 70,000; RETA (capped at EUR 7,100) is deducted, and IRPF on EUR 62,900 is the state scale
  // (EUR 9,076) plus the default regional scale (EUR 9,076): EUR 18,152, about 22.7% of revenue.
  const es = loadRulePack('es');
  const a = checkReserve(es, 'general', { revenue: 80_000, expenses: 8_000 });
  assert.equal(Math.round(a.incomeTax!), 18_152);
  assert.equal(a.status, 'short');
  assert.equal(a.requiredBps, 2269);
  // Madrid's own scale: EUR 8,323 instead of 9,076; the Basque foral system replaces both scales.
  assert.equal(Math.round(checkReserve(es, 'general', { revenue: 80_000, expenses: 8_000, region: 'MD' }).incomeTax!), 17_399);
  assert.equal(checkReserve(es, 'general', { revenue: 80_000, expenses: 8_000, region: 'BI' }).lines!.filter((l) => l.kind === 'incomeTax').length, 1);
  assert.equal(es.regions!.length, 21);
  assert.equal(checkReserve(es, 'general', { revenue: 80_000, expenses: 8_000, reserveBps: 3000 }).status, 'ok');
  assert.equal(checkReserve(es, 'general', { revenue: 12_000, expenses: 1_200 }).status, 'generous');

  // Italy, forfettario: 78% x (15% + 26.07%) = 32.03% of revenue; the preset reserves 33%.
  const it = checkReserve(loadRulePack('it'), 'forfettario', { revenue: 50_000 });
  assert.equal(it.requiredBps, 3204);
  assert.equal(it.status, 'ok');

  // Mexico, RESICO: one rate on all income by band.
  const mx = estimateTaxes(loadRulePack('mx').presets.find((p) => p.id === 'resico')!.estimate!, { revenue: 800_000 });
  assert.equal(mx.incomeTax, 12_000);

  // Ukraine, group 3: 6% of income is exact; the fixed ESV only counts if the reserve should cover it.
  const ua = loadRulePack('ua');
  assert.equal(checkReserve(ua, 'fop-group-3', { revenue: 1_000_000 }).requiredBps, 600);
  assert.equal(checkReserve(ua, 'fop-group-3', { revenue: 1_000_000, covers: ['incomeTax', 'social'] }).status, 'short');

  // India, presumptive: 50% of INR 20 lakh is taxable; under the INR 12 lakh rebate nothing is due.
  assert.equal(checkReserve(loadRulePack('in'), 'presumptive-gst', { revenue: 2_000_000 }).owed, 0);

  // The Bahamas: no income tax. Switzerland: no estimate, so the check says it cannot tell.
  assert.equal(checkReserve(loadRulePack('bs'), 'vat-only', { revenue: 100_000 }).requiredBps, 0);
  assert.equal(checkReserve(loadRulePack('ch'), 'standard', { revenue: 100_000 }).status, 'unknown');

  // Extra regional tax and fixed contributions entered by the user.
  const us = checkReserve(loadRulePack('us'), 'self-employed', { revenue: 100_000, activity: 'software' });
  const usState = checkReserve(loadRulePack('us'), 'self-employed', { revenue: 100_000, activity: 'software', extraIncomeTaxBps: 500 });
  assert.ok(usState.requiredBps! > us.requiredBps!);
  assert.equal(us.expenses, 10_000);
});

test('United States: federal 2026 with QBI and half SE deduction, plus the state the user lives in', () => {
  const us = loadRulePack('us');
  // USD 100,000 profit, Texas (no state income tax).
  const tx = checkReserve(us, 'self-employed', { revenue: 100_000, expenses: 0, region: 'TX' });
  // SE tax: 100,000 x 92.35% x 15.3% = 14,129.55.
  assert.equal(Math.round(tx.social!), 14_130);
  // Income tax: (100,000 - 7,064.78 half SE - 16,100) = 76,835.22 taxable; QBI 20% -> 61,468.18;
  // 10% x 12,400 + 12% x 38,000 + 22% x 11,068.18 = 8,235
  assert.equal(Math.round(tx.incomeTax!), 8_235);
  assert.equal(tx.precision, 'estimate');
  // California adds its own brackets; Florida adds nothing; an unknown state is refused.
  const ca = checkReserve(us, 'self-employed', { revenue: 100_000, expenses: 0, region: 'CA' });
  assert.ok(ca.incomeTax! - tx.incomeTax! > 4_000 && ca.incomeTax! - tx.incomeTax! < 7_000);
  assert.equal(checkReserve(us, 'self-employed', { revenue: 100_000, expenses: 0, region: 'FL' }).incomeTax, tx.incomeTax);
  assert.throws(() => checkReserve(us, 'self-employed', { revenue: 1, region: 'XX' }));
  assert.equal(us.regions!.length, 51);
});

test('every pack with an estimate gives a sensible answer across incomes', () => {
  for (const id of listRulePacks()) {
    const pack = loadRulePack(id);
    for (const p of pack.presets) {
      for (const revenue of [0, 10_000, 100_000, 1_000_000, 100_000_000]) {
        const c = checkReserve(pack, p.id, { revenue });
        if (c.status === 'unknown') continue;
        // Fixed minimum contributions can exceed a very small revenue; at high revenue no estimate passes 100%.
        assert.ok(Number.isFinite(c.requiredBps!) && c.requiredBps! >= 0, `${id}/${p.id} at ${revenue}: ${c.requiredBps}`);
        if (revenue === 100_000_000) assert.ok(c.requiredBps! <= 10_000, `${id}/${p.id} at ${revenue}: ${c.requiredBps}`);
      }
    }
  }
});

test('the registry plan publishes enacted changes ahead and never proposals', async () => {
  const { registryEntries, registrySyncPlan } = await import('../registry.js');
  const day = (d: string) => BigInt(Date.parse(`${d}T00:00:00Z`) / 1000);
  const now = day('2026-10-16');
  const week = 7n * 86_400n;

  // Thailand: 7% today, 10% from 1 October 2027.
  const th = loadRulePack('th');
  assert.deepEqual(registryEntries(th).standard, [{ from: day('2025-10-01'), bps: 700 }, { from: day('2027-10-01'), bps: 1000 }]);
  const plan = registrySyncPlan(th, {}, now, week);
  assert.deepEqual(plan.map((a) => a.kind), ['seed', 'publish']);
  // Already on chain: nothing to do.
  assert.equal(registrySyncPlan(th, registryEntries(th), now, week).length, 0);
  // Close to the date, the change can no longer be published in time.
  assert.equal(registrySyncPlan(th, { standard: [{ from: day('2025-10-01'), bps: 700 }] }, day('2027-09-28'), week)[0].kind, 'late');

  // Vietnam: the temporary 8% ends; its goods fall back to the standard 10%.
  const vn = registryEntries(loadRulePack('vn'));
  assert.deepEqual(vn.temporary_reduced.at(-1), { from: day('2027-01-01'), bps: 1000 });

  // Switzerland: 8.5% is only proposed, so it is never published; a stale future entry is withdrawn.
  const ch = loadRulePack('ch');
  assert.ok(!registrySyncPlan(ch, {}, now, week).some((a) => a.kind === 'publish'));
  const withdraw = registrySyncPlan(ch, { standard: [{ from: day('2024-01-01'), bps: 810 }, { from: day('2028-01-01'), bps: 850 }] }, now, week);
  assert.deepEqual(withdraw.filter((a) => a.rate === 'standard').map((a) => a.kind), ['withdraw']);
});

test('moving country: same calendar keeps the vault, a new calendar moves the inbox', async () => {
  const { changeCountryPlan } = await import('../registry.js');
  // Spain (quarterly + 30 days) to France (quarterly + 31 days): different due offset, new vault.
  const toFr = changeCountryPlan({ period: 'Quarter', dueOffsetSecs: 30n * 86_400n }, { pack: loadRulePack('fr'), presetId: 'micro-bnc-vat' }, '2026-10-16');
  assert.equal(toFr.sameVault, false);
  assert.ok(toFr.steps.some((s) => s.startsWith('propose_vault')));
  // Germany to the Netherlands with the user's own 25% reserve.
  const de = loadRulePack('de');
  const toNl = changeCountryPlan(
    { period: de.period, dueOffsetSecs: BigInt(de.dueOffsetDays) * 86_400n },
    { pack: loadRulePack('nl'), presetId: 'standard', reserves: [{ name: 'ib', bps: 2500 }] },
    '2026-10-16',
  );
  assert.deepEqual(toNl.rule, { vatBps: 2100, buckets: [{ name: 'ib', bps: 2500 }] });
  assert.deepEqual(toNl.follow, { country: 'NL', rate: 'standard' });
  // Same calendar as Ireland? Year + 304 vs Year + 120: still a new vault. Same pack calendar: same vault.
  const same = changeCountryPlan({ period: 'Year', dueOffsetSecs: 120n * 86_400n, following: true }, { pack: loadRulePack('nl'), presetId: 'standard' }, '2026-10-16');
  assert.equal(same.sameVault, true);
  assert.equal(same.steps[0].startsWith('unfollow'), true);
});

test('objective prepayments: last year\'s tax or a share of profit', () => {
  // US: last year's tax USD 20,000 on AGI 160,000 -> 110% = 22,000; on 100,000 revenue that is 22%.
  const us = checkReserve(loadRulePack('us'), 'self-employed', { revenue: 100_000, expenses: 0, region: 'TX', lastYearTax: 20_000, lastYearIncome: 160_000 });
  assert.deepEqual([Math.round(us.prepayment!.amount), us.prepayment!.requiredBps, us.prepayment!.covered], [22_000, 2200, true]);
  // UK: two payments on account = last year's bill.
  assert.equal(checkReserve(loadRulePack('gb'), 'standard', { revenue: 50_000, lastYearTax: 9_000, reserveBps: 1500 }).prepayment!.covered, false);
  // Spain: modelo 130 = 20% of profit, objective whatever the final IRPF.
  const es = checkReserve(loadRulePack('es'), 'general', { revenue: 80_000, expenses: 8_000 });
  assert.equal(es.prepayment!.amount, 14_000);
  // No rule: no prepayment figure.
  assert.equal(checkReserve(loadRulePack('nl'), 'standard', { revenue: 50_000, lastYearTax: 5_000 }).prepayment, undefined);
});

test('where do I pay? residence from days, homes and citizenship', async () => {
  const { residenceGuide } = await import('../rulepacks.js');
  const packs = listRulePacks().map((id) => loadRulePack(id));
  // A Spanish freelancer living in Bali: 250 days in Indonesia, 60 in Spain, no home kept in Spain.
  const bali = residenceGuide(packs, { days: { ID: 250, ES: 60 }, citizenships: ['ES'] });
  assert.deepEqual(bali.findings.filter((f) => f.resident === 'likely').map((f) => f.country), ['ID']);
  assert.match(bali.summary, /ID is likely/);
  // Keeping a home in Spain makes Spain possible too.
  assert.equal(residenceGuide(packs, { days: { ID: 250, ES: 60 }, homes: ['ES'] }).findings.find((f) => f.country === 'ES')!.resident, 'possible');
  // A US citizen in Dubai: the US taxes them anyway; the UAE has no income tax.
  const us = residenceGuide(packs, { days: { AE: 300 }, citizenships: ['US'] });
  assert.deepEqual(us.findings.filter((f) => f.resident === 'likely').map((f) => f.country).sort(), ['AE', 'US']);
  // Every pack says how it decides residence.
  for (const p of packs) assert.ok(p.residence && p.residence.tests.length > 0, p.id);
});

test('safety margin: strict countries and rough estimates need more than the estimate', () => {
  const es = loadRulePack('es');
  // Spain is strict and IRPF is an estimate: 4 points over the need.
  const t = checkReserve(es, 'general', { revenue: 80_000, expenses: 8_000, region: 'MD', reserveBps: 2300 });
  assert.equal(t.enforcement, 'strict');
  assert.equal(t.marginBps, 400);
  assert.equal(t.recommendedBps, t.requiredBps! + 400);
  assert.equal(t.status, 'tight');
  assert.equal(checkReserve(es, 'general', { revenue: 80_000, expenses: 8_000, region: 'MD', reserveBps: 2600 }).status, 'ok');
  // An exact regime needs no margin.
  assert.equal(checkReserve(loadRulePack('it'), 'forfettario', { revenue: 50_000 }).marginBps, 0);
});
