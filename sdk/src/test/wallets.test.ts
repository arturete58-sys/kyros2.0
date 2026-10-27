import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { outsideIncome, paymentsFromHorizon, pendingReserve, walletPaymentsHorizon, type HorizonRecord } from '../wallets.js';

const W = `G${'W'.repeat(55)}`;
const OWNER = `G${'O'.repeat(55)}`;
const CLIENT = `G${'C'.repeat(55)}`;
const VAULT = `C${'V'.repeat(55)}`;
const ISSUER = `G${'I'.repeat(55)}`;
const assets = [{ code: 'USDC', issuer: ISSUER }];
const rec = (id: string, at: string, x: Record<string, unknown>): HorizonRecord => ({ id, created_at: at, transaction_hash: id.padEnd(64, '0'), transaction_successful: true, type: '', ...x });

const records = [
  rec('1', '2026-10-20T10:00:00Z', { type: 'payment', from: CLIENT, to: W, amount: '1210.0000000', asset_code: 'USDC', asset_issuer: ISSUER }),
  rec('2', '2026-10-19T10:00:00Z', { type: 'payment', from: W, to: CLIENT, amount: '5.0000000', asset_code: 'USDC', asset_issuer: ISSUER }),
  rec('3', '2026-10-18T10:00:00Z', { type: 'payment', from: CLIENT, to: W, amount: '99.0000000', asset_code: 'USDC', asset_issuer: `G${'X'.repeat(55)}` }),
  rec('4', '2026-10-17T10:00:00Z', { type: 'path_payment_strict_receive', from: CLIENT, to: W, amount: '121.0000000', asset_code: 'USDC', asset_issuer: ISSUER }),
  rec('5', '2026-10-16T10:00:00Z', { type: 'invoke_host_function', asset_balance_changes: [{ type: 'transfer', from: VAULT, to: W, amount: '40.0000000', asset_code: 'USDC', asset_issuer: ISSUER }] }),
  rec('6', '2026-10-15T10:00:00Z', { type: 'payment', from: OWNER, to: W, amount: '500.0000000', asset_code: 'USDC', asset_issuer: ISSUER }),
  rec('7', '2025-12-31T10:00:00Z', { type: 'payment', from: CLIENT, to: W, amount: '300.0000000', asset_code: 'USDC', asset_issuer: ISSUER }),
];

test('the business’s other wallets: what they received, and what of it is income', async () => {
  const ps = paymentsFromHorizon(W, records, assets);
  assert.deepEqual(ps.map((p) => [p.id, p.amount]), [['1', 12_100_000_000n], ['4', 1_210_000_000n], ['5-0', 400_000_000n], ['6', 5_000_000_000n], ['7', 3_000_000_000n]]);

  // Pages from Horizon until the start of the tax year.
  const pages = [records.slice(0, 4), records.slice(4)];
  let i = 0;
  const fake = (async () => new Response(JSON.stringify({ _embedded: { records: pages[i] }, _links: { next: { href: `next-${++i}` } } }))) as unknown as typeof fetch;
  const year = await walletPaymentsHorizon('https://h', W, assets, '2026-01-01T00:00:00Z', { fetch: fake });
  assert.deepEqual(year.map((p) => p.id), ['1', '4', '5-0', '6']);

  // Not income: from the owner's own wallet, from the Kyros vault, or marked by the user.
  const inc = outsideIncome(year, { own: [OWNER, VAULT], notIncome: ['4'] });
  assert.deepEqual([inc.payments.map((p) => p.id), inc.total], [['1'], 12_100_000_000n]);

  // What Kyros would have set aside: 21% VAT and 20% of the base.
  const r = pendingReserve({ vatBps: 2100, buckets: [{ name: 'irpf', bps: 2000 }] }, inc.payments);
  assert.deepEqual([r.vat, r.reserve, r.total], [2_100_000_000n, 2_000_000_000n, 4_100_000_000n]);
});

test('live: Horizon on testnet, including transfers from Kyros contracts', { skip: !process.env.KYROS_LIVE_RESULTS }, async () => {
  const r = JSON.parse(readFileSync(process.env.KYROS_LIVE_RESULTS!, 'utf8'));
  const got = await walletPaymentsHorizon('https://horizon-testnet.stellar.org', r.accounts.freelancer, [{ code: 'KUSD', issuer: r.accounts.issuer }], r.startedAt);
  // The demo's freelancer is paid its net by the Router and swept inboxes: transfers from contracts.
  assert.ok(got.some((p) => p.from.startsWith('C')), JSON.stringify(got.slice(0, 5), (_, v) => (typeof v === 'bigint' ? String(v) : v)));
  // And the client account was funded by the issuer with a classic payment.
  const client = await walletPaymentsHorizon('https://horizon-testnet.stellar.org', r.accounts.client, [{ code: 'KUSD', issuer: r.accounts.issuer }], r.startedAt);
  assert.ok(client.some((p) => p.from === r.accounts.issuer));
});
