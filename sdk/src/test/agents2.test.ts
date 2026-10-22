import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Address, Keypair, MuxedAccount, Account, StrKey } from '@stellar/stellar-sdk';
import { daysByCountry, residenceWatch, residenceWindow, scheduleMove, type DayLog } from '../agents/residence.js';
import { x402Vat, x402Gross, x402Price, x402Requirement, x402RatesNeeded, EU_STANDARD_VAT } from '../agents/x402.js';
import { expenseFromDocument, expenseImpact } from '../agents/expenses.js';
import { guardAlerts, guardStopOp, guardMessage } from '../agents/watchdog.js';
import { checkIban, checkSettlement, settlementOps, workingDaysBefore } from '../agents/settlement.js';
import { blendRates, lendingAdvice } from '../agents/blend.js';
import { AGENTS, isActive } from '../agents/catalog.js';
import { assistantReply, assistantDocument, assistantExpenseAdded, countriesIn, detectIntent, type AssistantContext } from '../agents/assistant.js';
import { loadRulePack, calendarOf, duesOfCalendar, upcomingDeadlines } from '../rulepacks.js';
import { KyrosClient } from '../client.js';
import type { VaultEventRow, InboxMove } from '../events.js';

const U = 10_000_000n;
const contract = () => StrKey.encodeContract(Buffer.from(Keypair.random().rawPublicKey()));
const client = new KyrosClient({ rpcUrl: 'http://localhost:1', networkPassphrase: 'Test SDF Network ; September 2015' });

function log(spans: [string, string, number][]): DayLog {
  const out: DayLog = {};
  for (const [country, from, n] of spans) for (let i = 0; i < n; i++) out[new Date(Date.parse(`${from}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10)] = country;
  return out;
}

test('residence agent: days against each country’s test, with the day a threshold is crossed', () => {
  const es = loadRulePack('es');
  const pt = loadRulePack('pt');
  const l = log([['ES', '2026-01-01', 40], ['PT', '2026-02-10', 150]]);
  assert.deepEqual(daysByCountry(l, '2026-01-01', '2026-12-31'), { ES: 40, PT: 150 });
  assert.deepEqual(residenceWindow(es, '2026-07-09'), { from: '2026-01-01', to: '2026-12-31', kind: 'calendar-year' });
  assert.equal(residenceWindow(pt, '2026-07-09').from, '2025-07-10');
  // GB counts its tax year from 6 April.
  assert.deepEqual(residenceWindow(loadRulePack('gb'), '2026-03-01'), { from: '2025-04-06', to: '2026-04-05', kind: 'tax-year' });
  const w = residenceWatch([es, pt], l, '2026-07-09');
  const ptc = w.counts.find((c) => c.country === 'PT')!;
  assert.equal(ptc.days, 150);
  // More than 183: 184 days are needed, 34 to go, met on 12 August if the user stays.
  assert.equal(ptc.left, 34);
  assert.equal(ptc.metOn, '2026-08-12');
  assert.deepEqual(w.alerts.map((a) => a.country), []);
  assert.deepEqual(residenceWatch([es, pt], l, '2026-07-09', { warnDays: 40 }).alerts.map((a) => a.country), ['PT']);
});

test('residence agent: a move keeps the payment address and switches on the right date', () => {
  const es = loadRulePack('es');
  const cal = calendarOf(es, 'general');
  const current = { period: cal.period, dues: duesOfCalendar(cal), noticeSecs: 86_400n };
  const toPt = scheduleMove(current, { pack: loadRulePack('pt'), presetId: loadRulePack('pt').presets.find((p) => p.buckets.length)!.id }, '2027-01-01');
  if (toPt.plan.sameVault) assert.equal(toPt.ruleAt!.at, BigInt(Date.parse('2027-01-01T00:00:00Z') / 1000));
  else assert.equal(toPt.proposeBy, '2026-12-31');
  // Same pack, same calendar: the rule changes at the exact moment.
  const same = scheduleMove(current, { pack: es, presetId: 'general' }, '2027-01-01');
  assert.equal(same.plan.sameVault, true);
  assert.equal(same.ruleAt!.at, BigInt(Date.parse('2027-01-01T00:00:00Z') / 1000));
});

test('x402 agent: VAT by where the buyer is, the seller always nets the same', () => {
  const es = loadRulePack('es');
  const d = '2026-10-22';
  assert.deepEqual(x402Vat(es, { country: 'ES' }, { date: d }).vatBps, 2100);
  assert.equal(x402Vat(es, { country: 'DE', vatId: 'DE123456789' }, { date: d }).treatment, 'reverse-charge');
  assert.equal(x402Vat(es, { country: 'FR' }, { date: d, crossBorderB2cEur: 25_000 }).vatBps, 2000);
  assert.equal(x402Vat(es, { country: 'FR' }, { date: d, crossBorderB2cEur: 4_000 }).treatment, 'seller-country-under-threshold');
  assert.equal(x402Vat(es, { country: 'US' }, { date: d }).vatBps, 0);
  assert.equal(x402Vat(es, {}, { date: d }).treatment, 'unknown-buyer');
  assert.equal(x402Vat(loadRulePack('us'), { country: 'DE' }, { date: d }).treatment, 'export');
  assert.equal(Object.keys(EU_STANDARD_VAT).length, 27);
  // 0.01 USDC net at 21%: 0.0121 gross.
  assert.equal(x402Gross(100_000n, 2100), 121_000n);
  assert.equal(x402Price(121_000n), '$0.0121');
  assert.equal(x402Price(10n * U), '$10');
  const inboxes = { 0: contract(), 2100: contract(), 2000: contract() };
  const r = x402Requirement({ pack: es, inboxes, network: 'stellar:testnet' }, 100_000n, { country: 'ES' }, { date: d });
  assert.equal(r.payTo, inboxes[2100]);
  assert.equal(r.price, '$0.0121');
  assert.throws(() => x402Requirement({ pack: es, inboxes, network: 'stellar:testnet' }, 100_000n, { country: 'HU' }, { date: d, ossOptIn: true }), /27%/);
  assert.equal(x402RatesNeeded(es, { date: d }).join(','), '0,2100');
  assert.ok(x402RatesNeeded(es, { oss: true, date: d }).includes(2700));
});

test('expense agent: a supplier invoice lowers the modelo 130 and, when it can, the reserve', () => {
  const { expense } = expenseFromDocument('Acme Hosting S.L. Factura nº H-2026-311 Servidor cloud y dominio. Base imponible 1.000,00 € IVA 21% 210,00 € Total 1.210,00 €', '2026-10-01');
  assert.equal(expense.base, 1000);
  assert.equal(expense.inputVat, 210);
  assert.equal(expense.category, 'software');
  assert.equal(expense.deductible, true);
  assert.equal(expense.ref, 'H-2026-311');
  const es = loadRulePack('es');
  const rule = { vatBps: 2100, buckets: [{ name: 'irpf', bps: 2000 }] };
  const im = expenseImpact(es, 'general', rule, { revenue: 40_000, expenses: [{ ...expense, base: 15_000, inputVat: 3_150 }], activity: 'software', incomeYtd: 30_000, withheldYtd: 0, paidYtd: 2_000 });
  // 20% of 30,000 - 2,000 paid = 4,000; with 15,000 of expenses 20% of 15,000 - 2,000 = 1,000.
  assert.deepEqual(im.es130, { before: 4000, after: 1000 });
  assert.equal(im.inputVat, 3150);
  assert.ok(im.recommendedAfter! < im.recommendedBefore!);
  assert.ok(im.proposal);
  assert.ok(im.proposal!.buckets[0].bps < 2000);
});

test('guardian agent: a change nobody made from this device is flagged with the operation that stops it', () => {
  const vault = contract();
  const inbox = contract();
  const thief = Keypair.random().publicKey();
  const now = 1_800_000_000n;
  const tx = (n: number) => n.toString(16).padStart(64, '0');
  const rows: VaultEventRow[] = [
    { ledger: 10, closedAt: '2026-10-22T08:00:00Z', txHash: tx(1), kind: 'destination_proposed', destination: thief, readyAt: now + 3600n },
    { ledger: 11, closedAt: '2026-10-22T08:01:00Z', txHash: tx(2), kind: 'rule_proposed', rule: { vatBps: 2100, reserveBps: 1900 }, readyAt: now + 3600n },
    { ledger: 12, closedAt: '2026-10-22T08:02:00Z', txHash: tx(3), kind: 'strategy_proposed', adapter: contract(), readyAt: now + 3600n },
    { ledger: 13, closedAt: '2026-10-22T08:03:00Z', txHash: tx(4), kind: 'strategy_stopped' },
    { ledger: 14, closedAt: '2026-10-22T08:04:00Z', txHash: tx(5), kind: 'conversion_proposed', adapter: contract(), readyAt: now - 10n },
  ];
  const moves: InboxMove[] = [{ ledger: 15, closedAt: '2026-10-22T08:05:00Z', txHash: tx(6), kind: 'move_proposed', vault: contract(), readyAt: now + 60n }];
  const a = guardAlerts(rows, moves, { now, mine: new Set([tx(2)]), currentReserveBps: 2000 });
  assert.deepEqual(a.map((x) => [x.kind, x.severity, x.mine]), [
    ['destination', 'critical', false],
    ['rule', 'warning', true],
    ['inbox-move', 'critical', false],
  ]);
  // Cancelled: nothing left to flag for the destination.
  const cancelled = guardAlerts([...rows, { ledger: 20, closedAt: '2026-10-22T09:00:00Z', txHash: tx(9), kind: 'change_cancelled' }], [], { now });
  assert.equal(cancelled.filter((x) => x.kind === 'destination').length, 0);
  const op = guardStopOp(client, a[0], vault, inbox);
  assert.equal(op.body().invokeHostFunctionOp().hostFunction().invokeContract().functionName().toString(), 'cancel');
  assert.equal(guardStopOp(client, a[2], vault, inbox).body().invokeHostFunctionOp().hostFunction().invokeContract().functionName().toString(), 'cancel_move');
  assert.match(guardMessage(a[0], vault), /new tax destination/);
});

test('settlement agent: IBAN, anchor, destination and the day to start', () => {
  assert.deepEqual(checkIban('ES91 2100 0418 4502 0005 1332'), { ok: true, iban: 'ES9121000418450200051332', country: 'ES' });
  assert.deepEqual(checkIban('ES91 2100 0418 4502 0005 1333'), { ok: false, reason: 'checksum' });
  assert.deepEqual(checkIban('ES91 2100 0418'), { ok: false, reason: 'length' });
  assert.deepEqual(checkIban('DE89370400440532013000'), { ok: true, iban: 'DE89370400440532013000', country: 'DE' });
  // Friday 20 November 2026, three working days before: Tuesday 17.
  assert.equal(workingDaysBefore('2026-11-20', 3), '2026-11-17');
  assert.equal(workingDaysBefore('2026-11-23', 1), '2026-11-20');
  const anchor = Keypair.random().publicKey();
  const ok = checkSettlement({ iban: 'ES9121000418450200051332', amount: 500, deadline: '2026-11-20', today: '2026-11-10', info: { enabled: true, feeFixed: 1, feePercent: 0.5 }, taxDestination: anchor, target: { account: anchor, memo: '123', memoType: 'id' } });
  assert.deepEqual(ok.issues, []);
  assert.equal(ok.fee, 3.5);
  const bad = checkSettlement({ iban: 'ES00', amount: 5, deadline: '2026-11-20', today: '2026-11-19', info: { enabled: false, minAmount: 10 }, taxDestination: Keypair.random().publicKey(), target: { account: anchor, memo: 'x', memoType: 'text' } });
  assert.deepEqual(bad.issues.map((i) => i.kind), ['iban', 'withdrawals-off', 'below-minimum', 'destination-differs', 'memo-type', 'late']);
  const vault = contract();
  const [op] = settlementOps(client, vault, anchor, { id: 't1', account: anchor, memo: '42', memoType: 'id' }, [{ period: 8106, token: contract(), bucket: 'vat', amount: 500n * U }]);
  const args = op.body().invokeHostFunctionOp().hostFunction().invokeContract().args();
  const muxed = new MuxedAccount(new Account(anchor, '0'), '42').accountId();
  assert.equal(Address.fromScVal(args[4]).toString(), muxed);
});

test('treasury agent with Blend v2: pool rates by its own model, and when to lend or bring it back', () => {
  const cfg = { util: 7_500_000, max_util: 9_500_000, r_base: 100_000, r_one: 500_000, r_two: 5_000_000, r_three: 15_000_000 };
  const S12 = 1_000_000_000_000n;
  // 100 supplied, 75 borrowed: at the target, 1% + 5% = 6% for borrowers; lenders get 6% x 75% x (1 - 20%) = 3.6%.
  const r = blendRates(cfg, { b_rate: S12, d_rate: S12, b_supply: 100n * U, d_supply: 75n * U, ir_mod: 10_000_000n }, 2_000_000);
  assert.deepEqual([r.utilizationBps, r.borrowAprBps, r.supplyAprBps], [7500, 600, 360]);
  assert.equal(r.liquidity, 25n * U);
  // 96% utilization: over the kink, the steep slope.
  const hot = blendRates(cfg, { b_rate: S12, d_rate: S12, b_supply: 100n * U, d_supply: 96n * U, ir_mod: 10_000_000n }, 2_000_000);
  assert.equal(hot.utilizationBps, 9600);
  assert.equal(hot.borrowAprBps, 5600 + 3000);
  const now = 1_800_000_000n;
  const day = 86_400n;
  // 4,200 at 3.6% for 90 days: about 37.28.
  const lend = lendingAdvice({ amount: 4_200n * U, dueAt: now + 90n * day, now, rates: { ...r, liquidity: 10_000n * U } });
  assert.equal(lend.decision, 'lend');
  assert.equal(lend.untilDue, (4_200n * U * 360n * 90n) / (10_000n * 365n));
  assert.equal(lendingAdvice({ amount: 4_200n * U, dueAt: now + 5n * day, now, rates: r }).decision, 'not-worth-it');
  assert.equal(lendingAdvice({ amount: 4_200n * U, dueAt: now + 90n * day, now, rates: hot }).decision, 'pool-too-full');
  assert.equal(lendingAdvice({ amount: 4_200n * U, dueAt: now + 5n * day, now, rates: hot, invested: 4_200n * U }).decision, 'withdraw-now');
  assert.equal(lendingAdvice({ amount: 4_200n * U, dueAt: now + 60n * day, now, rates: r, invested: 20n * U }).decision, 'keep');
});

test('agent catalogue: what is switched on now', () => {
  assert.deepEqual(AGENTS.filter((a) => a.status === 'active').map((a) => a.id), ['assistant', 'documents', 'reconcile', 'law', 'guardian', 'expenses', 'residence', 'payouts', 'treasury-fx']);
  assert.equal(isActive('x402'), false);
  assert.equal(isActive('guardian'), true);
});

const es = loadRulePack('es');
const now = new Date('2026-10-22T09:00:00Z');
const cal = calendarOf(es, 'general');
const ctx = (over: Partial<AssistantContext> = {}): AssistantContext => ({
  lang: 'es',
  now,
  countryName: 'España',
  pack: es,
  presetId: 'general',
  rule: { vatBps: 2100, buckets: [{ name: 'irpf', bps: 2000 }] },
  revenue: 40_000,
  activity: 'software',
  deadlines: upcomingDeadlines(es, 'general', now),
  calendar: { period: cal.period, dues: duesOfCalendar(cal), noticeSecs: 86_400n },
  loadPacks: async (cs) => cs.map((c) => loadRulePack(c.toLowerCase())),
  incomeYtd: 30_000,
  paidYtd: 2_000,
  ...over,
});

test('assistant: residence, moves, expenses, the guardian, x402 and paying through an anchor', async () => {
  assert.deepEqual(countriesIn('llevo 150 días en Portugal y 40 en España').map((c) => [c.country, c.days]), [['PT', 150], ['ES', 40]]);
  assert.deepEqual(countriesIn('120 days in the UK, 60 in Germany').map((c) => [c.country, c.days]), [['GB', 120], ['DE', 60]]);
  for (const [q, want] of [
    ['Llevo 150 días en Portugal y 40 en España, ¿dónde tributo?', 'residence'],
    ['¿Hay algún cambio sospechoso en mi bóveda?', 'guard'],
    ['Creo que me han robado la llave', 'guard'],
    ['¿Qué gastos puedo deducir?', 'expense'],
    ['Vendo una API con x402', 'x402'],
    ['¿Es correcto este IBAN ES91 2100 0418 4502 0005 1332?', 'settlement'],
    ['Me mudo a Portugal el 1 de enero de 2027', 'move'],
  ] as const)
    assert.equal(detectIntent(q), want, q);

  const res = await assistantReply('Llevo 150 días en Portugal y 40 en España, ¿dónde tributo?', ctx());
  assert.match(res.text, /Portugal: 150 de 183 días; te faltan 34/);
  assert.match(res.text, /convenio/);

  const mv = await assistantReply('Me mudo a Portugal el 1 de enero de 2027', ctx());
  assert.match(mv.text, /Mudanza a Portugal el 1 de enero de 2027/);

  const ex = await assistantReply('¿Qué gastos puedo deducir?', ctx({ expenses: [{ date: '2026-09-01', base: 15_000, inputVat: 3_150, category: 'software', deductible: true }] }));
  assert.match(ex.text, /modelo 130/);
  assert.equal(ex.actions[0]?.kind, 'propose-rule');

  const added = assistantExpenseAdded(ctx(), { date: '2026-10-01', base: 1000, inputVat: 210, category: 'software', deductible: true });
  assert.match(added.text, /Gasto apuntado/);

  const g0 = await assistantReply('¿Hay algún cambio sospechoso?', ctx({ guard: [] }));
  assert.match(g0.text, /No hay ningún cambio pendiente/);
  const g1 = await assistantReply('¿Hay algún cambio sospechoso?', ctx({ guard: [{ kind: 'destination', tx: 'a'.repeat(64), at: '2026-10-22T08:00:00Z', readyAt: 1_800_000_000n, detail: 'G...', severity: 'critical', mine: false }] }));
  assert.equal(g1.actions[0]?.kind, 'stop-change');

  const iban = await assistantReply('¿Es correcto este IBAN ES91 2100 0418 4502 0005 1332?', ctx());
  assert.match(iban.text, /es correcto/);
  const badIban = await assistantReply('mi IBAN es ES91 2100 0418 4502 0005 1333', ctx());
  assert.match(badIban.text, /dígitos de control/);
  assert.match((await assistantReply('Vendo una API con x402', ctx())).text, /x402/);

  // An invoice: mine (register the payment) or a supplier's (an expense).
  const inv = await assistantDocument('Acme Hosting S.L. FACTURA Nº H-1 Base imponible 100,00 € IVA 21% 21,00 € Total 121,00 €', 'f.pdf', ctx());
  assert.deepEqual(inv.actions.map((a) => a.kind), ['register-invoice', 'add-expense']);
});
