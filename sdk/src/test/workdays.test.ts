import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scValToNative } from '@stellar/stellar-sdk';
import { daysFromCivil, duesAfter, periodOf, type PeriodKind } from '../periods.js';
import { listRulePacks, loadHolidays, loadRulePack, termsFromPack, upcomingDeadlines } from '../rulepacks.js';
import { duesFromNative, duesToScVal } from '../scval.js';
import { lockAt, nextOpen, payBy, registryHolidays, weekday, dayString } from '../workdays.js';
import { drawFrom, incomeTaxBuckets, suggestPrepayment, taxYearStart, type PeriodFigures } from '../installments.js';

const here = dirname(fileURLToPath(import.meta.url));
const vectors = JSON.parse(readFileSync(join(here, '..', '..', '..', 'test-vectors', 'vectors.json'), 'utf8'));
const endOf = (y: number, m: number, d: number) => (daysFromCivil(BigInt(y), m, d) + 1n) * 86_400n;
const U = 10_000_000n;

test('due days move past closed days and holidays like the contract and an independent calendar', () => {
  const cases = vectors.workdays as { end: string; closed: number; holidays: number[]; want: string }[];
  assert.ok(cases.length >= 300);
  for (const c of cases) assert.equal(String(nextOpen(BigInt(c.end), c.closed, new Set(c.holidays))), c.want, JSON.stringify(c));
  assert.equal(weekday(0), 3);
});

test('the day to pay and the day the lock opens, country by country', () => {
  const at = (cc: string, y: number, m: number, d: number) => {
    const pack = loadRulePack(cc);
    const h = loadHolidays(cc);
    const end = endOf(y, m, d);
    return [dayString(payBy(end, pack.calendar.workdays, h)), dayString(lockAt(end, pack.calendar.workdays, h))];
  };
  // Spain: Saturday 30 January 2027 moves to Monday; Epiphany (6 January) is national.
  assert.deepEqual(at('es', 2027, 1, 30), ['2027-02-01', '2027-02-01']);
  assert.deepEqual(at('es', 2027, 1, 6), ['2027-01-07', '2027-01-07']);
  // UK: Sunday 31 January 2027 does not move; pay by Friday 29th. The lock waits for Monday.
  assert.deepEqual(at('gb', 2027, 1, 31), ['2027-01-29', '2027-02-01']);
  // Netherlands: no extension for taxes paid on a return.
  assert.deepEqual(at('nl', 2027, 1, 31), ['2027-01-29', '2027-02-01']);
  // US: Saturday 15 April 2028; Emancipation Day (Sunday 16th) is observed on Monday 17th, so Tuesday 18th.
  assert.deepEqual(at('us', 2028, 4, 15), ['2028-04-18', '2028-04-18']);
  // Japan: 31 December 2026 is closed (29 Dec - 3 Jan), then Saturday/Sunday 2-3 Jan: Monday 4 January 2027.
  assert.deepEqual(at('jp', 2026, 12, 31), ['2027-01-04', '2027-01-04']);
  // Turkey: Saturday is not an official holiday, so a Saturday deadline stays; the lock still waits.
  assert.deepEqual(at('tr', 2027, 7, 31), ['2027-07-31', '2027-08-02']);
  // South Africa: the business day before.
  assert.deepEqual(at('za', 2027, 2, 28), ['2027-02-26', '2027-03-01']);
});

test('every pack says what happens on closed days, and its holidays are generated', () => {
  for (const id of listRulePacks()) {
    const pack = loadRulePack(id);
    const w = pack.calendar.workdays;
    assert.ok(w, `${id} workdays`);
    if (w.verified) assert.ok((w.sources ?? []).length > 0, id);
    const h = loadHolidays(id);
    assert.ok(h && h.years['2027'], `${id} holidays`);
    // Lock holidays include the ones that move the date shown.
    for (const [y, s] of Object.entries(h.years)) for (const d of s.pay) assert.ok(s.lock.includes(d), `${id} ${y} ${d}`);
    assert.ok(registryHolidays(h, 2027).length <= 120, id);
    // The lock is never earlier than the day to pay.
    for (const d of upcomingDeadlines(pack, pack.presets[0].id, new Date('2026-10-17T00:00:00Z'), 400, h)) assert.ok(d.lock >= d.date && d.lock >= d.legal, `${id} ${JSON.stringify(d)}`);
  }
});

test('vault dues carry the closed days and the holiday registry, and survive encoding', () => {
  const t = termsFromPack(loadRulePack('es'), 'general', '2026-10-17', { holidayRegistry: 'CCJZ5DGASBWQXR5MPFCJXMBI333XE5U3FSJTNQU7RIKE3P5GN2K2WYD5' });
  assert.equal(t.dues.closed, 0b110_0000);
  assert.deepEqual(t.dues.holidays, { registry: 'CCJZ5DGASBWQXR5MPFCJXMBI333XE5U3FSJTNQU7RIKE3P5GN2K2WYD5', country: 'ES' });
  assert.deepEqual(duesFromNative(scValToNative(duesToScVal(t.dues))), t.dues);
  assert.deepEqual(duesFromNative(scValToNative(duesToScVal(duesAfter(60n)))), duesAfter(60n));
  // The Cayman pack follows the IRS calendar, so US holidays.
  assert.equal(termsFromPack(loadRulePack('ky'), loadRulePack('ky').presets[0].id, '2026-10-17', { holidayRegistry: 'CCJZ5DGASBWQXR5MPFCJXMBI333XE5U3FSJTNQU7RIKE3P5GN2K2WYD5' }).dues.holidays?.country, 'US');
});

test('modelo 130: 20% of the year so far, minus withholding and earlier payments', () => {
  const pack = loadRulePack('es');
  const kind: PeriodKind = { kind: 'Quarter' };
  const q1 = periodOf(kind, BigInt(Date.UTC(2027, 1, 10) / 1000));
  const periods: PeriodFigures[] = [
    // Q1: 10,000 income, 300 withheld by a client; the reserve set aside 2,000 and nothing was paid yet.
    { id: q1, income: 10_000n * U, withheld: 300n * U, incomeHeld: 2_000n * U, incomePaid: 0n },
    // Q2 (still running on 20 April): not counted for the 1T.
    { id: q1 + 1, income: 5_000n * U, withheld: 0n, incomeHeld: 1_000n * U, incomePaid: 0n },
  ];
  const rule = pack.calendar.prepayments![0].amount;
  const s = suggestPrepayment(rule, pack, kind, endOf(2027, 4, 20), periods, { expenses: 2_000n * U });
  // 20% x (10,000 - 2,000) - 300 = 1,300.
  assert.equal(s.amount, 1_300n * U);
  assert.equal(s.needs, undefined);
  // Without expenses it is an upper bound, and says so.
  assert.equal(suggestPrepayment(rule, pack, kind, endOf(2027, 4, 20), periods).needs, 'expenses');
  // 2T after paying the 1T: 20% x (15,000 - 3,000) - 300 - 1,300 = 800.
  periods[0].incomePaid = 1_300n * U;
  assert.equal(suggestPrepayment(pack.calendar.prepayments![1].amount, pack, kind, endOf(2027, 7, 20), periods, { expenses: 3_000n * U }).amount, 800n * U);
  // 4T on 30 January counts the previous year.
  assert.equal(taxYearStart('01-01', endOf(2028, 1, 30), -1), daysFromCivil(2027n, 1, 1) * 86_400n);
  // Which reserve pays: oldest first, and what is missing.
  const d = drawFrom([{ period: q1 + 1, token: 'T', bucket: 'irpf', amount: 1_000n * U }, { period: q1, token: 'T', bucket: 'irpf', amount: 700n * U }], 800n * U);
  assert.deepEqual(d.items.map((i) => [i.period, i.amount]), [[q1, 700n * U], [q1 + 1, 100n * U]]);
  assert.equal(d.short, 0n);
  assert.deepEqual(incomeTaxBuckets(pack, 'general'), ['irpf']);
});

test('other prepayment rules: last year, annualised, the notice', () => {
  const gb = loadRulePack('gb');
  const kind: PeriodKind = { kind: 'Quarter' };
  const poa = gb.calendar.prepayments![0].amount;
  assert.equal(suggestPrepayment(poa, gb, kind, endOf(2027, 1, 31), []).needs, 'previousYear');
  assert.equal(suggestPrepayment(poa, gb, kind, endOf(2027, 1, 31), [], { previousYearTax: 8_000n * U }).amount, 4_000n * U);
  const de = loadRulePack('de');
  assert.equal(suggestPrepayment(de.calendar.prepayments![0].amount, de, kind, endOf(2027, 3, 10), [], { notice: 900n * U }).amount, 900n * U);
  // US: by 15 June, half of the year's tax estimated from the reserve so far (Jan to mid-June), minus Q1's payment.
  const us = loadRulePack('us');
  const q1 = periodOf(kind, BigInt(Date.UTC(2027, 1, 10) / 1000));
  const s = suggestPrepayment(us.calendar.prepayments![1].amount, us, kind, endOf(2027, 6, 15), [
    { id: q1, income: 0n, withheld: 0n, incomeHeld: 0n, incomePaid: 1_000n * U },
    { id: q1 + 1, income: 0n, withheld: 0n, incomeHeld: 1_200n * U, incomePaid: 0n },
  ]);
  assert.ok(s.estimate! > 4_000n * U && s.estimate! < 5_000n * U, String(s.estimate));
  assert.equal(s.amount, (s.estimate! * 500_000n) / 1_000_000n - 1_000n * U);
});

test('reading a tax notice: the due date and the amount, in several languages', async () => {
  const { readNotice, parseNoticeAmount } = await import('../notice.js');
  const today = '2027-05-01';
  const de = readNotice(
    'Finanzamt Musterstadt. Bescheid für 2026 über Einkommensteuer vom 12.05.2027. Steuernummer 12/345/67890. ' +
      'Abrechnung: festgesetzt 9.870,00 €, abzüglich Vorauszahlungen 6.000,00 €. Nachzahlung 3.870,00 €. Bitte zahlen Sie den Betrag spätestens am 15.06.2027.',
    today,
  );
  assert.equal(de.date, '2027-06-15');
  assert.equal(de.amount, 3870);
  const nl = readNotice('Aanslag inkomstenbelasting 2026. Dagtekening 3 mei 2027. Te betalen bedrag € 1.234,56. Betaal uiterlijk 30 juni 2027.', today);
  assert.equal(nl.date, '2027-06-30');
  assert.equal(nl.amount, 1234.56);
  const en = readNotice('Notice of Assessment, Year of Assessment 2027, issued on 15 May 2027. Amount payable: S$2,150.40. Payment is due by 14 June 2027.', today);
  assert.equal(en.date, '2027-06-14');
  assert.equal(en.amount, 2150.4);
  const es = readNotice('Liquidación provisional. Fecha de emisión: 02/05/2027. Importe a ingresar: 845,20 euros. Plazo de ingreso: hasta el 20 de junio de 2027.', today);
  assert.equal(es.date, '2027-06-20');
  assert.equal(es.amount, 845.2);
  const fr = readNotice("Avis d'impôt 2027 sur les revenus 2026. Montant à payer : 1 520,00 €. Date limite de paiement : 15 septembre 2027.", today);
  assert.equal(fr.date, '2027-09-15');
  assert.equal(fr.amount, 1520);
  assert.equal(parseNoticeAmount('1,234.56'), 1234.56);
  assert.equal(parseNoticeAmount("12'345.00"), 12345);
});
