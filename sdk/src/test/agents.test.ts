import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, StrKey } from '@stellar/stellar-sdk';
import { readInvoice, invoicePlan, classifyDocument } from '../agents/invoice.js';
import { parsePayouts, checkPayouts, payoutsOf } from '../agents/payouts.js';
import { treasuryAdvice, fairValue, observedApyBps, projectYield } from '../agents/treasury.js';
import { buildLedger, parseReserveQuestion, answerReserveQuestion, checkTaxExport } from '../agents/reconcile.js';
import { vatEdits, holidaySyncPlan } from '../agents/law.js';
import { detectIntent, assistantReply, assistantDocument, assistantIntro, numberIn, type AssistantContext } from '../agents/assistant.js';
import { TEXT } from '../agents/assistant-text.js';
import { loadRulePack, upcomingDeadlines } from '../rulepacks.js';
import { taxToolCsv } from '../tax-exports.js';
import { invoiceReference } from '../client.js';
import type { VaultEventRow } from '../events.js';
import { daysFromCivil } from '../periods.js';

const contract = () => StrKey.encodeContract(Buffer.from(Keypair.random().rawPublicKey()));
const U = 10_000_000n;

test('invoice agent: a Spanish invoice with VAT and IRPF withheld becomes exact vault terms', () => {
  const text = `FACTURA Nº 2026-041  Fecha: 03/10/2026
    Cliente: Acme Soluciones SL, NIF B12345678
    Concepto: Desarrollo web  1  1.000,00
    Base imponible 1.000,00 €
    IVA 21% 210,00 €
    Retención IRPF 15% -150,00 €
    Total a pagar 1.060,00 €`;
  const r = readInvoice(text);
  assert.equal(r.number, '2026-041');
  assert.equal(r.base, 1000);
  assert.equal(r.vatRateBps, 2100);
  assert.equal(r.withholdingRateBps, 1500);
  assert.equal(r.total, 1060);
  assert.equal(r.treatment, 'standard');
  assert.ok(r.consistent);
  assert.equal(r.currency, 'EUR');
  // A 20% income-tax reserve becomes 5% on top of the 15% the client withholds.
  const p = invoicePlan(r, { vatBps: 2100, buckets: [{ name: 'irpf', bps: 2000 }] });
  assert.deepEqual(p.terms, { vatBps: 2100, withholdingBps: 1500, buckets: [{ name: 'irpf', bps: 500 }] });
  assert.deepEqual(p.reference, invoiceReference('2026-041'));
  assert.equal(classifyDocument(text), 'invoice');
});

test('invoice agent: reverse charge, small-business franchise and Italian ritenuta', () => {
  const rc = readInvoice('Invoice No. INV-0077 Bill to: Beta GmbH, VAT DE123456789 Net amount 2,500.00 EUR VAT 0% Reverse charge – Article 196 of Directive 2006/112/EC Total due 2,500.00 EUR');
  assert.equal(rc.treatment, 'reverse-charge');
  assert.equal(rc.number, 'INV-0077');
  assert.equal(rc.base, 2500);
  assert.equal(invoicePlan(rc, { vatBps: 2100, buckets: [{ name: 'irpf', bps: 2000 }] }).terms.vatBps, 0);

  const ku = readInvoice('Rechnung Nr. R-2026-12 Nettobetrag 800,00 € Gemäß § 19 UStG wird keine Umsatzsteuer berechnet. Gesamtbetrag 800,00 €');
  assert.equal(ku.treatment, 'franchise');
  assert.equal(ku.number, 'R-2026-12');

  const it = readInvoice("Fattura n. 15/2026 Imponibile 1.000,00 IVA 22% 220,00 Ritenuta d'acconto 20% 200,00 Totale da pagare 1.020,00");
  assert.equal(it.vatRateBps, 2200);
  assert.equal(it.withholdingRateBps, 2000);
  assert.equal(it.total, 1020);
  assert.ok(it.consistent);

  const exempt = readInvoice('Factura nº F-9 Base imponible 300,00 € Operación exenta de IVA (art. 20 de la Ley del IVA) Total 300,00 €');
  assert.equal(exempt.treatment, 'exempt');
});

test('document agent tells notices, invoices, payout lists and tax-tool exports apart', () => {
  assert.equal(classifyDocument('Agencia Tributaria. Liquidación provisional. Importe a ingresar: 1.234,56 €. Plazo de ingreso: hasta el 20/11/2026.'), 'notice');
  assert.equal(classifyDocument('Finanzamt München. Bescheid für 2025 über Einkommensteuer. Abschlusszahlung fällig am 15.12.2026: 2.340,00 €'), 'notice');
  assert.equal(classifyDocument('vault,amount,reference\nCA...,10,inv-1\n', 'pagos.csv'), 'payouts-csv');
  assert.equal(classifyDocument('Date,Sent Amount,Sent Currency,Received Amount,Received Currency,Fee Amount,Fee Currency,Net Worth Amount,Net Worth Currency,Tag,Description,TxHash\n', 'koinly.csv'), 'tax-export-csv');
  assert.equal(classifyDocument('Lorem ipsum dolor sit amet.'), 'unknown');
});

test('payout agent: checks every line, catches wallets, duplicates and ambiguous amounts, and batches the run', () => {
  const [a, b, c] = [contract(), contract(), contract()];
  const g = Keypair.random().publicKey();
  const csv = [
    'Nombre;Dirección;Importe;Referencia;País',
    `Ana;${a};1500,00;NOM-10;ES`,
    `Ben;${b};250.5;NOM-11;DE`,
    `Cris;${c};"1,250.75";NOM-12;US`,
    `Dan;${g};100;NOM-13;FR`,
    `Ana;${a};1500,00;NOM-10;ES`,
    `Eva;${c};1.500;NOM-14;IT`,
    `Fer;${b};1.12345678;NOM-15;PT`,
    `Gus;not-an-address;10;NOM-16;ES`,
  ].join('\n');
  const lines = parsePayouts(csv);
  assert.equal(lines.length, 8);
  assert.equal(lines[0].name, 'Ana');
  const check = checkPayouts(lines, { perRun: 2 });
  const byLine = Object.fromEntries(check.problems.map((p) => [p.line, p.problem]));
  assert.deepEqual(byLine, { 5: 'not-a-vault', 6: 'duplicate', 7: 'ambiguous-amount', 8: 'too-many-decimals', 9: 'not-an-address' });
  assert.equal(check.total, 1500n * U + 2505n * U / 10n + 125075n * U / 100n);
  assert.deepEqual(check.runs.map((r) => r.length), [2, 1]);
  const payouts = payoutsOf(check.runs[0]);
  assert.equal(payouts[0].vault, a);
  assert.deepEqual(payouts[0].reference, invoiceReference('NOM-10'));
  assert.throws(() => parsePayouts('nombre,referencia\nx,y'), /address/);
});

test('treasury agent: convert at a good price, wait for a better one, convert anyway near the due date', () => {
  const now = 1_800_000_000n;
  const day = 86_400n;
  const conversion = { maxSlippageBps: 100 };
  const base = { held: 1000n * U, now, conversion, noticeSecs: day, fairOut: 920n * U };
  // 0.3% from the oracle with a 1% tolerance: good.
  assert.equal(treasuryAdvice({ ...base, dueAt: now + 30n * day, quotedOut: 917_240_0000n }).decision, 'convert-now');
  // 0.8%: within the floor but not good, a month ahead: wait.
  const w = treasuryAdvice({ ...base, dueAt: now + 30n * day, quotedOut: 912_640_0000n });
  assert.equal(w.decision, 'wait');
  assert.equal(w.spreadBps, 80);
  // Same price, five days ahead: convert now.
  const soon = treasuryAdvice({ ...base, dueAt: now + 5n * day, quotedOut: 912_640_0000n });
  assert.equal(soon.decision, 'convert-now');
  assert.ok(soon.reasons.includes('due-soon'));
  // The vault would refuse the swap (below its floor).
  assert.equal(treasuryAdvice({ ...base, dueAt: now + 30n * day, quoteError: 'simulation failed: Error(Contract, #22) SwapBelowFloor' }).decision, 'cannot-quote');
  // No conversion set up, and its notice is longer than the time to the due date.
  const setup = treasuryAdvice({ held: 10n * U, now, dueAt: now + day, conversion: null, noticeSecs: 2n * day });
  assert.equal(setup.decision, 'set-up-conversion');
  assert.ok(setup.reasons.includes('notice-longer-than-due'));
  assert.equal(treasuryAdvice({ ...base, held: 0n, dueAt: now }).decision, 'nothing-to-convert');
});

test('treasury agent: fair value from the oracle, observed yield and the yield until the due date', () => {
  // Oracle in USD with 14 decimals: USDC 1.00, EURC 1.08 -> 108 USDC is 100 EURC.
  assert.equal(fairValue(108n * U, { price: 10n ** 14n, decimals: 14 }, { price: 108n * 10n ** 12n, decimals: 14 }), 100n * U);
  const now = 1_800_000_000n;
  // 1,000 invested for 73 days earned 8: 4% a year.
  assert.equal(observedApyBps({ invested: 1000n * U, surplus: 8n * U }, now - 73n * 86_400n, now), 400);
  assert.equal(observedApyBps({ invested: 1000n * U, surplus: 1n }, now - 3600n, now), undefined);
  const y = projectYield(10_000n * U, 365, now, now + 100n * 86_400n, 'given');
  assert.equal(y.untilDue, 100n * U);
  assert.equal(y.days, 100);
});

function sampleEvents(): VaultEventRow[] {
  const usd = contract();
  const q3 = 2026 * 4 + 2;
  const tx = (n: number) => n.toString(16).padStart(64, 'a');
  return [
    { ledger: 1, closedAt: '2026-07-10T10:00:00Z', txHash: tx(1), kind: 'received', token: usd, period: q3, gross: 12100n * U, net: 8000n * U, vat: 2100n * U, parts: [2000n * U], reserve: 4100n * U, reference: '0'.repeat(64) },
    { ledger: 2, closedAt: '2026-08-05T10:00:00Z', txHash: tx(2), kind: 'received', token: usd, period: q3, gross: 3575n * U, net: 2364n * U, vat: 620n * U, parts: [591n * U], reserve: 1211n * U },
    { ledger: 3, closedAt: '2026-10-20T10:00:00Z', txHash: tx(3), kind: 'tax_paid', token: usd, period: q3, amount: 2720n * U, bucket: 'vat' },
    { ledger: 4, closedAt: '2026-04-12T10:00:00Z', txHash: tx(4), kind: 'received', token: usd, period: q3 - 1, gross: 1210n * U, net: 800n * U, vat: 210n * U, parts: [200n * U], reserve: 410n * U },
  ];
}

test('reconciliation agent: why was 2,591 set aside for income tax in Q3, payment by payment', () => {
  const rows = sampleEvents();
  const kind = { kind: 'Quarter' as const };
  const ledger = buildLedger(rows, { buckets: ['irpf'], periodKind: kind });
  assert.deepEqual(ledger.map((l) => l.label), ['2026-Q2', '2026-Q3']);
  const q = parseReserveQuestion('¿Por qué en el tercer trimestre se reservaron 2.591 EURC en mi Modelo 130?', new Date('2026-10-22T09:00:00Z'));
  assert.equal(q.label, '2026-Q3');
  assert.equal(q.tax, 'income');
  assert.equal(q.metric, 'reserved');
  assert.equal(q.amount, 2591);
  const a = answerReserveQuestion(q, ledger, { periodKind: kind, incomeBuckets: ['irpf'] });
  assert.equal(Object.values(a.totals)[0], 2591n * U);
  assert.equal(a.entries.length, 2);
  assert.deepEqual(a.matches, []);
  // Asked as VAT paid in Q3: the payment on 20 October.
  const paid = answerReserveQuestion(parseReserveQuestion('How much VAT did I pay in Q3 2026?', new Date('2026-10-22T09:00:00Z')), ledger, { periodKind: kind, incomeBuckets: ['irpf'] });
  assert.equal(Object.values(paid.totals)[0], 2720n * U);
  // Other languages and forms.
  assert.equal(parseReserveQuestion('Warum wurde im 2. Quartal so viel zurückgelegt?', new Date('2026-10-22')).label, '2026-Q2');
  assert.equal(parseReserveQuestion('pourquoi le trimestre dernier ?', new Date('2026-10-22')).label, '2026-Q3');
  assert.equal(parseReserveQuestion('IVA de marzo', new Date('2026-10-22')).label, '2026-03');
  assert.equal(parseReserveQuestion('cuánto IVA en el Q4', new Date('2026-10-22')).label, '2026-Q4');
  assert.equal(parseReserveQuestion('IVA de diciembre', new Date('2026-10-22')).label, '2025-12');
});

test('reconciliation agent: a tax-tool export is checked against the chain', () => {
  const rows = sampleEvents();
  const csv = taxToolCsv('koinly', rows, () => 'USDC');
  const ok = checkTaxExport(csv, rows);
  assert.equal(ok.tool, 'koinly');
  assert.equal(ok.fileTxs, 4);
  assert.deepEqual([ok.missing.length, ok.unknown.length, ok.differs.length], [0, 0, 0]);
  // The accountant dropped a line and changed an amount.
  const lines = csv.trim().split('\n');
  const edited = [lines[0], ...lines.slice(1).filter((l) => !l.includes(rows[3].txHash))].join('\n').replace('10000,USDC', '9000,USDC');
  const bad = checkTaxExport(edited, rows);
  assert.deepEqual(bad.missing, [rows[3].txHash]);
  assert.equal(bad.differs.length, 1);
  assert.equal(bad.differs[0].chain, 12100);
});

test('law agent: a different official standard rate becomes a reviewable pack edit; holidays sync by the registry rules', () => {
  const es = loadRulePack('es');
  const { edits, left } = vatEdits(
    [es],
    [
      { pack: 'es', country: 'ES', rate: 'standard', packBps: 2100, officialBps: [2200], source: 'TEDB' },
      { pack: 'es', country: 'ES', rate: 'reduced', packBps: 1000, officialBps: [1000, 500], source: 'TEDB' },
    ],
    '2026-10-22',
  );
  assert.equal(edits.length, 1);
  assert.match(edits[0].summary, /21% → 22%/);
  const t = edits[0].after.vatRates!.find((x) => x.from === '2026-10-22')!;
  assert.equal(t.rates.standard, 2200);
  assert.equal(t.rates.reduced, es.vatRates!.find((x) => !x.proposed)!.rates.reduced);
  assert.equal(left.length, 1);
  // Unchanged pack is not edited.
  assert.equal(vatEdits([es], [{ pack: 'es', country: 'ES', rate: 'standard', officialBps: [2100], source: 'TEDB' }], '2026-10-22').edits.length, 0);

  const data = { source: 'test', country: 'ES', years: { '2026': { pay: [], lock: ['01-01', '12-08', '12-25'] }, '2027': { pay: [], lock: ['01-01', '01-06'] } } };
  const day = (y: number, m: number, d: number) => Number(daysFromCivil(BigInt(y), m, d));
  const today = day(2026, 10, 22);
  const plan = holidaySyncPlan(data, { 2026: [day(2026, 1, 1), day(2026, 12, 25), day(2026, 3, 19)], 2027: [] }, [2026, 2027], today);
  assert.deepEqual(plan, [
    { kind: 'add', country: 'ES', year: 2026, day: day(2026, 12, 8) },
    { kind: 'kept', country: 'ES', year: 2026, days: [day(2026, 3, 19)] },
    { kind: 'set', country: 'ES', year: 2027, days: [day(2027, 1, 1), day(2027, 1, 6)] },
  ]);
});

const es = loadRulePack('es');
const now = new Date('2026-10-22T09:00:00Z');
const ctx = (lang: AssistantContext['lang'] = 'es'): AssistantContext => ({
  lang,
  now,
  countryName: 'España',
  pack: es,
  presetId: 'general',
  rule: { vatBps: 2100, buckets: [{ name: 'irpf', bps: 2000 }] },
  revenue: 40_000,
  activity: 'software',
  spendable: { usd: 8000n * U, eur: 0n },
  buckets: { vat: { usd: 2720n * U, eur: 0n }, irpf: { usd: 2591n * U, eur: 0n } },
  deadlines: upcomingDeadlines(es, 'general', now),
  events: sampleEvents(),
  periodKind: { kind: 'Quarter' },
  incomeBuckets: ['irpf'],
});

test('assistant: understands the same questions in six languages', () => {
  const cases: [string, string][] = [
    ['¿Cuándo es mi próximo plazo?', 'deadline'],
    ['When is my next tax deadline?', 'deadline'],
    ['Wann ist die nächste Frist fällig?', 'deadline'],
    ['¿Cuánto tengo apartado?', 'reserved'],
    ['Combien j’ai mis de côté ?', 'reserved'],
    ['¿Es suficiente si facturo 40.000 al año?', 'enough'],
    ['Reicht meine Rücklage bei 60.000 Umsatz?', 'enough'],
    ['¿Por qué en el tercer trimestre se reservaron 2.715 EURC en mi Modelo 130?', 'why'],
    ['Perché lo scorso trimestre è stato accantonato tanto?', 'why'],
    ['¿Qué IVA cobro?', 'vat'],
    ['Tengo un cliente en otro país', 'abroad'],
    ['Me ha llegado una carta de Hacienda', 'notice'],
    ['¿Cómo exporto a Koinly?', 'export'],
    ['¿Cuándo convierto la reserva a euros?', 'fx'],
    ['¿Cuánto rendiría en Blend al 4 %?', 'yield'],
    ['Tengo que pagar a varias personas a la vez', 'payouts'],
    ['¿Qué ha cambiado en la ley?', 'law'],
    ['Me mudo a Portugal', 'move'],
    ['¿Puede Kyros tocar mi dinero?', 'custody'],
    ['¿Qué pasa si pago tarde?', 'late'],
    ['¿Cuánto puedo gastar?', 'spendable'],
    ['hola', 'greet'],
    ['asdf qwerty', 'unknown'],
  ];
  for (const [q, want] of cases) assert.equal(detectIntent(q), want, q);
  // The suggested questions work in every language.
  const want = ['deadline', 'reserved', 'enough', 'why', 'law', 'abroad'];
  for (const l of ['es', 'en', 'pt', 'fr', 'de', 'it'] as const)
    (['q1', 'q2', 'q3', 'q4', 'q5', 'q6'] as const).forEach((k, i) => assert.equal(detectIntent(TEXT[k][l]), want[i], `${k}.${l}: ${TEXT[k][l]}`));
  for (const q of ['Was passiert, wenn ich zu spät zahle?', 'Et si je paie en retard ?', 'E se pago in ritardo?', 'E se pagar com atraso?']) assert.equal(detectIntent(q), 'late', q);
  assert.equal(numberIn('si facturo 40.000 al año'), 40_000);
  assert.equal(numberIn('bei 60k Umsatz'), 60_000);
  assert.equal(numberIn('with 55,500 a year in 2026'), 55_500);
  // Every text exists in every language.
  for (const [k, v] of Object.entries(TEXT)) for (const l of ['es', 'en', 'pt', 'fr', 'de', 'it']) assert.ok((v as Record<string, string>)[l], `${k}.${l}`);
});

test('assistant: answers from the pack and the vault, with the next step', async () => {
  const intro = assistantIntro(ctx());
  assert.match(intro.text, /España/);
  assert.equal(intro.actions.length, 6);

  const d = await assistantReply('¿Cuándo es mi próximo plazo?', ctx());
  assert.equal(d.intent, 'deadline');
  assert.match(d.text, /IVA/);
  assert.equal(d.actions[0].kind, 'go');

  const r = await assistantReply('¿Cuánto tengo apartado?', ctx());
  assert.match(r.text, /5311,00 USDC/);
  assert.match(r.text, /Renta \(IRPF\): 2591,00 USDC/);

  const e = await assistantReply('¿Es suficiente mi reserva si facturo 40.000?', ctx());
  assert.equal(e.intent, 'enough');
  assert.match(e.text, /40\.000 EUR/);

  const w = await assistantReply('¿Por qué en el tercer trimestre se reservaron 2.591 en la renta?', ctx());
  assert.equal(w.intent, 'why');
  assert.match(w.text, /En el 3\.º trimestre de 2026 tu bóveda apartó/);
  assert.match(w.text, /2591,00 USDC/);
  assert.match(w.text, /tx /);

  const v = await assistantReply('What VAT do I charge?', ctx('en'));
  assert.match(v.text, /21\s%/);

  const law = await assistantReply('¿Qué ha cambiado en la ley?', ctx());
  assert.match(law.text, /Verifactu/);

  const fxNone = await assistantReply('¿Convierto a euros?', ctx());
  assert.equal(fxNone.intent, 'fx');

  const unknown = await assistantReply('asdf qwerty', ctx('de'));
  assert.equal(unknown.intent, 'unknown');
  assert.match(unknown.text, /Fristen/);
});

test('assistant: reads attached documents with the agents and proposes what to sign', async () => {
  const inv = await assistantDocument('FACTURA Nº A-77 Base imponible 2.000,00 € IVA 21% 420,00 € Retención IRPF 15% -300,00 € Total a pagar 2.120,00 €', 'factura.pdf', ctx());
  assert.equal(inv.intent, 'invoice');
  const reg = inv.actions[0];
  assert.equal(reg.kind, 'register-invoice');
  if (reg.kind === 'register-invoice') assert.deepEqual(reg.terms, { vatBps: 2100, withholdingBps: 1500, buckets: [{ name: 'irpf', bps: 500 }] });

  const notice = await assistantDocument('Agencia Tributaria. Ejercicio 2025. Liquidación provisional. Importe a ingresar: 1.234,56 €. Fecha límite de ingreso: 20/11/2026.', 'carta.pdf', ctx());
  assert.equal(notice.intent, 'notice');
  const ap = notice.actions[0];
  assert.equal(ap.kind, 'apply-notice');
  if (ap.kind === 'apply-notice') {
    assert.equal(ap.date, '2026-11-20');
    assert.equal(ap.amount, 1234.56);
    assert.equal(new Date(Number(ap.taxYearStart) * 1000).getUTCFullYear(), 2025);
  }

  const v = contract();
  const pay = await assistantDocument(`address,amount,reference\n${v},100,NOM-1\n${v},250.5,NOM-2\n`, 'nomina.csv', ctx());
  assert.equal(pay.intent, 'payouts');
  assert.equal(pay.actions[0]?.kind, 'pay-many');
  assert.match(pay.text, /2 pagos correctos/);

  const bad = await assistantDocument(`address,amount,reference\n${Keypair.random().publicKey()},100,NOM-1\n`, 'nomina.csv', ctx());
  assert.equal(bad.actions.length, 0);
  assert.match(bad.text, /Línea 2/);

  const exp = await assistantDocument(taxToolCsv('koinly', sampleEvents(), () => 'USDC'), 'koinly.csv', ctx());
  assert.equal(exp.intent, 'export');
  assert.match(exp.text, /Cuadra/);
});
