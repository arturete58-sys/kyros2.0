import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Account, Keypair, Networks, scValToNative, nativeToScVal, TransactionBuilder, BASE_FEE, Contract, xdr } from '@stellar/stellar-sdk';
import { split, validateRule, RuleError, formatAmount, parseAmount } from '../split.js';
import { periodOf, periodStart, periodEnd, periodLabel, dueDate, civilFromDays, daysFromCivil, type PeriodKind } from '../periods.js';
import { listRulePacks, loadRulePack, termsFromPack } from '../rulepacks.js';
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
  for (const id of ['ad', 'ae', 'ch', 'de', 'ee', 'es', 'fr', 'gb', 'ge', 'hk', 'ie', 'it', 'lu', 'nl', 'pt', 'sg', 'us']) assert.ok(ids.includes(id), id);
  for (const id of ids) {
    const pack = loadRulePack(id);
    assert.equal(pack.id, id);
    assert.ok(pack.sources && pack.sources.length > 0, `${id} cites sources`);
    for (const p of pack.presets) {
      const t = termsFromPack(pack, p.id);
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
