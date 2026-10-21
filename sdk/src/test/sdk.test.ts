import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Account, StrKey, Keypair, Networks, scValToNative, nativeToScVal, TransactionBuilder, BASE_FEE, Contract, xdr } from '@stellar/stellar-sdk';
import { split, validateRule, RuleError, formatAmount, parseAmount } from '../split.js';
import { periodOf, periodStart, periodEnd, periodLabel, dueDate, dueAt, duesAfter, validDue, civilFromDays, daysFromCivil, type Due, type PeriodKind } from '../periods.js';
import { listRulePacks, loadRulePack, termsFromPack, vatRatesOn, presetVatBps, checkRuleVat, customRule, vatChanges, vatUpdatePlan, upcomingDeadlines, calendarOf } from '../rulepacks.js';
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
  // Q1 2027 ends on 1 April; a fixed delay of 30 days.
  assert.equal(dueDate({ kind: 'Quarter' }, 2027 * 4, duesAfter(30n * 86_400n)), BigInt(Date.UTC(2027, 4, 1) / 1000));
  for (const p of vectors.monthsPeriods) {
    for (const n of [2, 4, 6]) {
      const k: PeriodKind = { kind: 'Months', months: n };
      const id = periodOf(k, BigInt(p.ts));
      assert.equal(id, p[`months${n}`].id);
      assert.equal(periodStart(k, id).toString(), p[`months${n}`].start);
      assert.equal(periodEnd(k, id).toString(), p[`months${n}`].end);
    }
  }
  for (let z = -800_000n; z < 800_000n; z += 9_973n) {
    const [y, m, d] = civilFromDays(z);
    assert.equal(daysFromCivil(y, m, d), z);
  }
});

test('due dates match the shared calendar vectors (the contract checks the same ones)', () => {
  const rule = (r: Record<string, Record<string, number>>): Due => {
    if ('after' in r) return { after: BigInt(r.after as unknown as number) };
    if ('monthDay' in r) return { monthDay: r.monthDay as never };
    return { yearDate: r.yearDate as never };
  };
  const kindOf = (k: string): PeriodKind => (k.startsWith('Months') ? { kind: 'Months', months: Number(k.slice(6)) } : { kind: k as 'Month' });
  assert.ok(vectors.dues.length >= 500);
  for (const d of vectors.dues) {
    const r = rule(vectors.dueRules[d.rule]);
    assert.ok(validDue(r));
    assert.equal(dueAt(kindOf(d.kind), d.id, r).toString(), d.due, `${d.kind} ${d.id} ${d.rule}`);
  }
});

test('the Spain rule pack loads and gives valid vault terms', () => {
  const pack = loadRulePack('es');
  const t = termsFromPack(pack, 'general');
  assert.deepEqual(t.rule, { vatBps: 2100, buckets: [{ name: 'irpf', bps: 2000 }] });
  assert.deepEqual(t.period, { kind: 'Quarter' });
  // VAT: the 20th after each quarter, 30 January for the fourth; the income-tax reserve: 30 June of the next year.
  const q1 = 2027 * 4;
  const at = (d: Due) => new Date(Number(dueAt(t.period, q1, d) - 1n) * 1000).toISOString().slice(0, 10);
  assert.equal(at(t.dues.buckets.vat), '2027-04-20');
  assert.equal(at(t.dues.default), '2028-06-30');
  assert.equal(new Date(Number(dueAt(t.period, q1 + 3, t.dues.buckets.vat) - 1n) * 1000).toISOString().slice(0, 10), '2028-01-30');
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
  // A preset without VAT has no VAT date; a preset can give a bucket its own date.
  assert.equal(calendarOf(loadRulePack('es'), 'no-vat').vat, undefined);
  assert.deepEqual(termsFromPack(loadRulePack('br'), 'pessoa-fisica').dues.buckets.irpf_inss, { yearDate: { fyStartMonth: 1, fyStartDay: 1, month: 5, day: 31, yearsAfter: 1 } });
  // The UK: the 2026/27 tax year (from 6 April) is settled on 31 January 2028.
  const gb = termsFromPack(loadRulePack('gb'), 'standard');
  assert.equal(new Date(Number(dueAt(gb.period, 2026 * 4 + 2, gb.dues.default) - 1n) * 1000).toISOString().slice(0, 10), '2028-01-31');
  // Australia: the October-December BAS is due on 28 February.
  const au = termsFromPack(loadRulePack('au'), 'gst');
  assert.equal(new Date(Number(dueAt(au.period, 2026 * 4 + 3, au.dues.buckets.vat) - 1n) * 1000).toISOString().slice(0, 10), '2027-02-28');
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
  // leave EUR 70,000. RETA 2026: 70,000 less the 7% general deduction is EUR 5,425 a month, band 11
  // (4,050 to 6,000), minimum base EUR 1,732.03 at 31.5%: EUR 6,547.07 a year. IRPF on EUR 63,452.93 is the
  // state scale (EUR 9,200) plus the default regional scale (EUR 9,200): EUR 18,401, about 23% of revenue.
  const es = loadRulePack('es');
  const a = checkReserve(es, 'general', { revenue: 80_000, expenses: 8_000 });
  assert.equal(a.lines!.find((l) => l.name === 'reta')!.amount, 6547.07);
  assert.equal(Math.round(a.incomeTax!), 18_401);
  assert.equal(a.status, 'short');
  assert.equal(a.requiredBps, 2301);
  // Madrid's own scale is lower; the Basque foral system replaces both scales.
  assert.equal(Math.round(checkReserve(es, 'general', { revenue: 80_000, expenses: 8_000, region: 'MD' }).incomeTax!), 17_637);
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

  // The Bahamas: no income tax. A US person in the Cayman Islands owes US tax the pack cannot estimate.
  assert.equal(checkReserve(loadRulePack('bs'), 'vat-only', { revenue: 100_000 }).requiredBps, 0);
  assert.equal(checkReserve(loadRulePack('ky'), 'us-person', { revenue: 100_000 }).status, 'unknown');
  // Liechtenstein: CHF 100,000 of profit pays 12.285% AHV/IV/FAK, then the Art. 19 tariff with a 180% communal surcharge.
  const li = checkReserve(loadRulePack('li'), 'standard', { revenue: 100_000, expenses: 0 });
  assert.equal(Math.round(li.lines!.find((l) => l.name === 'ahv_iv_fak')!.amount), 12_290);
  assert.equal(Math.round(li.incomeTax!), 7_396);
  // Argentina: the monotributo is the fee of the category (services, August 2026): ARS 40 million is category F.
  assert.equal(checkReserve(loadRulePack('ar'), 'monotributo', { revenue: 40_000_000 }).lines![0].amount, 1_809_410.52);
  assert.equal(checkReserve(loadRulePack('ar'), 'monotributo', { revenue: 40_000_000 }).precision, 'exact');
  // Ganancias: nothing until the ganancia no imponible plus the special deduction (ARS 27,088,521.14).
  assert.equal(checkReserve(loadRulePack('ar'), 'responsable-inscripto', { revenue: 27_000_000, expenses: 0 }).incomeTax, 0);
  // United Arab Emirates: Small Business Relief up to AED 3 million of revenue (to 2029), 9% above AED 375,000 of profit beyond it.
  assert.equal(checkReserve(loadRulePack('ae'), 'vat-and-corporate-tax', { revenue: 2_900_000 }).incomeTax, 0);
  assert.ok(checkReserve(loadRulePack('ae'), 'vat-and-corporate-tax', { revenue: 3_100_000 }).incomeTax! > 0);
  // Luxembourg, class 1: EUR 80,000 of profit pays 23.98% social contributions and 1.4% dependency
  // (EUR 20,304), and income tax on the remaining EUR 59,696 with the 7% employment fund contribution.
  const lu = checkReserve(loadRulePack('lu'), 'standard', { revenue: 100_000, expenses: 20_000 });
  assert.equal(Math.round(lu.lines!.find((l) => l.name === 'cotisations_sociales')!.amount), 19_184);
  assert.equal(Math.round(lu.incomeTax!), 11_819);
  // The minimum base (the social minimum wage) applies to small profits.
  assert.equal(Math.round(checkReserve(loadRulePack('lu'), 'standard', { revenue: 20_000, expenses: 0 }).lines!.find((l) => l.name === 'cotisations_sociales')!.amount), 7780);

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
  // Spain to France: other due dates, new vault.
  const es = termsFromPack(loadRulePack('es'), 'general');
  const toFr = changeCountryPlan({ period: 'Quarter', dues: es.dues }, { pack: loadRulePack('fr'), presetId: 'micro-bnc-vat' }, '2026-10-16');
  assert.equal(toFr.sameVault, false);
  assert.ok(toFr.steps.some((s) => s.startsWith('propose_vault')));
  // Germany to the Netherlands with the user's own 25% reserve.
  const de = loadRulePack('de');
  const toNl = changeCountryPlan(
    { period: de.calendar.period, dues: termsFromPack(de, 'standard').dues },
    { pack: loadRulePack('nl'), presetId: 'standard', reserves: [{ name: 'ib', bps: 2500 }] },
    '2026-10-16',
  );
  assert.deepEqual(toNl.rule, { vatBps: 2100, buckets: [{ name: 'ib', bps: 2500 }] });
  assert.deepEqual(toNl.follow, { country: 'NL', rate: 'standard' });
  // The same calendar keeps the vault.
  const nl = termsFromPack(loadRulePack('nl'), 'standard');
  const same = changeCountryPlan({ period: 'Quarter', dues: nl.dues, following: true }, { pack: loadRulePack('nl'), presetId: 'standard' }, '2026-10-16');
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

test('Spain RETA 2026: the fee follows the band of monthly net income, from the reduced table to the top band', () => {
  const es = loadRulePack('es');
  const reta = (revenue: number) => checkReserve(es, 'general', { revenue, expenses: 0 }).lines!.find((l) => l.name === 'reta')!.amount;
  // 12,000 - 5% = 11,400; less 7% = 10,602 a year (EUR 883.50 a month): reduced table, band 2, base 718.95.
  assert.equal(reta(12_000), 2717.63);
  // 30,000 - 5% = 28,500; less 7% = 26,505 (EUR 2,208.75 a month): general band 6, base 1,274.51.
  assert.equal(reta(30_000), 4817.65);
  // Above EUR 6,000 a month the top band applies: base 1,928.10 at 31.5%.
  assert.equal(reta(200_000), 7288.22);
});

test('safety margin: strict countries and rough estimates need more than the estimate', () => {
  const es = loadRulePack('es');
  // Spain is strict and IRPF is an estimate: 4 points over the need.
  const t = checkReserve(es, 'general', { revenue: 80_000, expenses: 8_000, region: 'MD', reserveBps: 2300 });
  assert.equal(t.enforcement, 'strict');
  assert.equal(t.marginBps, 400);
  assert.equal(t.recommendedBps, t.requiredBps! + 400);
  assert.equal(t.status, 'tight');
  assert.equal(checkReserve(es, 'general', { revenue: 80_000, expenses: 8_000, region: 'MD', reserveBps: 2700 }).status, 'ok');
  // An exact regime needs no margin.
  assert.equal(checkReserve(loadRulePack('it'), 'forfettario', { revenue: 50_000 }).marginBps, 0);
});

test('activity and client set the VAT, the regime and the reserve automatically', async () => {
  const { suggestSetup } = await import('../activities.js');
  const es = loadRulePack('es');
  const dev = suggestSetup(es, { activity: 'software', client: 'consumer-local', revenue: 80_000, expenses: 8_000, region: 'MD', date: '2026-10-16' });
  assert.equal(dev.vat.bps, 2100);
  assert.equal(dev.presetId, 'general');
  assert.ok(dev.reserveBps > 2000);
  // Same freelancer billing a German company: reverse charge, no VAT in the vault.
  assert.equal(suggestSetup(es, { activity: 'software', client: 'business-eu', date: '2026-10-16' }).vat.treatment, 'reverse-charge');
  // A physiotherapist in Spain: exempt. A restaurant: 10%. A bookshop: 4%.
  assert.equal(suggestSetup(es, { activity: 'health', client: 'consumer-local', date: '2026-10-16' }).vat.treatment, 'exempt');
  assert.equal(suggestSetup(es, { activity: 'hospitality', client: 'consumer-local', date: '2026-10-16' }).vat.bps, 1000);
  assert.equal(suggestSetup(es, { activity: 'books', client: 'consumer-local', date: '2026-10-16' }).vat.bps, 400);
  // A client outside the country: no VAT; the UAE: 5% at home.
  assert.equal(suggestSetup(loadRulePack('ae'), { activity: 'consulting', client: 'abroad', date: '2026-10-16' }).vat.bps, 0);
  assert.equal(suggestSetup(loadRulePack('ae'), { activity: 'consulting', client: 'consumer-local', date: '2026-10-16' }).vat.bps, 500);
  // An exact regime keeps its own reserve (Italy forfettario has no margin).
  const it = suggestSetup(loadRulePack('it'), { activity: 'software', client: 'consumer-local', revenue: 50_000, date: '2026-10-16' });
  assert.ok(it.rule.buckets.length === 1);
  // Every pack answers for every activity and client.
  const { ACTIVITIES } = await import('../activities.js');
  for (const id of listRulePacks()) {
    const p = loadRulePack(id);
    for (const a of Object.keys(ACTIVITIES)) for (const c of ['consumer-local', 'business-local', 'business-eu', 'abroad'] as const) {
      const r = suggestSetup(p, { activity: a as never, client: c, revenue: 60_000, date: '2026-10-16' });
      assert.ok(r.rule.vatBps >= 0 && r.reserveBps >= 0, `${id} ${a} ${c}`);
    }
  }
});

test('upcoming deadlines: Spain in mid-October 2026', () => {
  const ds = upcomingDeadlines(loadRulePack('es'), 'general', new Date('2026-10-17T00:00:00Z'), 300);
  const first = ds.slice(0, 3).map((d) => `${d.date} ${d.kind}${d.bucket ? `:${d.bucket}` : ''}`);
  // Q3 VAT and the 3T modelo 130 on 20 October, then Q4 VAT: due 30 January 2027, a Saturday, so Monday 1 February.
  assert.deepEqual(first, ['2026-10-20 vat:vat', '2026-10-20 prepayment', '2027-02-01 vat:vat']);
  assert.equal(ds[2].legal, '2027-01-30');
  assert.equal(ds[2].lock, '2027-02-01');
  assert.ok(ds.some((d) => d.date === '2027-06-30' && d.kind === 'income'));
});

test('every pack calendar gives valid due rules and cites its sources', () => {
  for (const id of listRulePacks()) {
    const pack = loadRulePack(id);
    assert.ok(pack.calendar.note.length > 20, id);
    assert.ok((pack.calendar.sources ?? []).length > 0, `${id} calendar sources`);
    for (const p of pack.presets) {
      const t = termsFromPack(pack, p.id, pack.reviewed!);
      for (const d of [t.dues.default, ...Object.values(t.dues.buckets)]) assert.ok(validDue(d), `${id}/${p.id}`);
      // Nothing falls due before its period ends, nor more than three years after.
      for (const d of [t.dues.default, ...Object.values(t.dues.buckets)]) {
        const end = periodEnd(t.period, 2027 * 4);
        const due = dueAt(t.period, periodOf(t.period, end - 1n), d);
        assert.ok(due >= periodEnd(t.period, periodOf(t.period, end - 1n)) && due < end + 3n * 366n * 86_400n, `${id}/${p.id}`);
      }
    }
  }
});

test('a client abroad gets its own terms and VAT not owed is taken back with a correction', async () => {
  const { KyrosClient } = await import('../client.js');
  const { abroadTerms } = await import('../split.js');
  const c = new KyrosClient({ rpcUrl: 'https://soroban-testnet.stellar.org', networkPassphrase: Networks.TESTNET });
  const vault = StrKey.encodeContract(Buffer.alloc(32, 4));
  const payer = Keypair.random().publicKey();
  const rule = { vatBps: 2100, buckets: [{ name: 'irpf', bps: 2000 }] };
  const t = abroadTerms(rule);
  assert.deepEqual(t, { vatBps: 0, withholdingBps: 0, buckets: [{ name: 'irpf', bps: 2000 }] });
  // The VAT a payment of 1,210 carried is what a correction takes back.
  assert.equal(split(rule, 1_210n).vat, 210n);
  const call = c.expectPayerOp(vault, payer, t).body().invokeHostFunctionOp().hostFunction().invokeContract();
  assert.equal(call.functionName().toString(), 'expect_payer');
  assert.equal(scValToNative(call.args()[0]), payer);
  assert.deepEqual(scValToNative(call.args()[1]), { vat_bps: 0, withholding_bps: 0, buckets: [{ name: 'irpf', bps: 2000 }] });
  const corr = c.proposeCorrectionOp(vault, { period: 8108, token: vault, bucket: 'vat', amount: 210n }).body().invokeHostFunctionOp().hostFunction().invokeContract();
  assert.equal(corr.functionName().toString(), 'propose_correction');
  assert.deepEqual(corr.args().map((a) => scValToNative(a)), [8108, vault, 'vat', 210n]);
  assert.equal(c.applyCorrectionOp(vault, 3).body().invokeHostFunctionOp().hostFunction().invokeContract().functionName().toString(), 'apply_correction');
});

test('a mainnet vault is never deployed with a notice shorter than a day', async () => {
  const { KyrosClient, MIN_MAINNET_NOTICE_SECS } = await import('../client.js');
  const c = new KyrosClient({ rpcUrl: 'https://example.invalid', networkPassphrase: Networks.PUBLIC });
  const owner = Keypair.random().publicKey();
  const v = { owner, rule: { vatBps: 2100, buckets: [] }, taxDestination: owner, noticeSecs: 120n, period: { kind: 'Quarter' as const }, dues: { default: { kind: 'AfterEnd' as const, secs: 0n } } as never, tokens: [] };
  assert.throws(() => c.deployVault(Keypair.random(), Buffer.alloc(32), v), /at least 86400 seconds/);
  assert.equal(MIN_MAINNET_NOTICE_SECS, 86_400n);
});

test('brief RPC failures are retried; contract errors are not', async () => {
  const { retrying, KyrosError } = await import('../client.js');
  let n = 0;
  assert.equal(await retrying(async () => (++n < 3 ? Promise.reject(new Error('fetch failed')) : 'ok'), { attempts: 4 }), 'ok');
  assert.equal(n, 3);
  n = 0;
  await assert.rejects(retrying(async () => { n++; throw new KyrosError('simulation failed: Error(Contract, #4)'); }), /Contract, #4/);
  assert.equal(n, 1);
  n = 0;
  assert.equal(await retrying(async () => (++n < 2 ? Promise.reject(new Error('Account not found: G...')) : 'ok'), { alsoIf: (e) => /Account not found/.test(e.message) }), 'ok');
});
