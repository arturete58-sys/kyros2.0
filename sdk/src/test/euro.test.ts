// Tests for the euro reserve, yield, anchor and invoicing parts of the SDK.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Keypair, MuxedAccount, Networks, StrKey, TransactionBuilder, WebAuth, scValToNative, xdr } from '@stellar/stellar-sdk';
import { split, splitWithheld, validateWithholding, RuleError } from '../split.js';
import { checkBuiltInAddresses, stablecoinContract, STABLECOINS } from '../assets.js';
import { conversionToScVal, invoiceTermsToScVal } from '../scval.js';
import { anchorAuth, anchorInfo, anchorPayout, startWithdrawal, withdrawalStatus } from '../anchor.js';
import { money, payableUnits, requestRef, requestTerms, requestTotals, type PaymentRequest } from '../payment-request.js';
import { invoiceReference } from '../client.js';

const UNIT = 10_000_000n;

test('an invoice with IRPF withheld splits like the contract: 1,060 -> 1,000 base, 210 VAT, 50 reserve, 800 net', () => {
  const rule = { vatBps: 2100, buckets: [{ name: 'irpf', bps: 500 }] };
  const s = splitWithheld(rule, 1500, 1_060n * UNIT);
  assert.deepEqual([s.base, s.vat, s.parts[0], s.reserve, s.net], [1_000n * UNIT, 210n * UNIT, 50n * UNIT, 260n * UNIT, 800n * UNIT]);
  // No withholding is the plain split.
  assert.deepEqual(splitWithheld(rule, 0, 1_210n * UNIT), split(rule, 1_210n * UNIT));
  assert.throws(() => validateWithholding({ vatBps: 2100, buckets: [{ name: 'irpf', bps: 9000 }] }, 1500), RuleError);
});

test('built-in token, oracle and router addresses are well formed', () => {
  checkBuiltInAddresses();
  assert.ok(StrKey.isValidContract(stablecoinContract('mainnet', 'EURC')));
  assert.equal(STABLECOINS.mainnet.EURC.issuer, 'GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP2');
});

test('a conversion and invoice terms encode as the contract types (sorted struct keys, enum vectors)', () => {
  const c = scValToNative(
    conversionToScVal({
      fromToken: stablecoinContract('testnet', 'USDC'),
      toToken: stablecoinContract('testnet', 'EURC'),
      swapper: stablecoinContract('testnet', 'USDC'),
      oracle: stablecoinContract('testnet', 'EURC'),
      fromPrice: { other: 'USD' },
      toPrice: { other: 'EUR' },
      maxSlippageBps: 100,
      maxAgeSecs: 3600n,
    }),
  ) as Record<string, unknown>;
  assert.deepEqual(c.from_price, ['Other', 'USD']);
  assert.equal(c.max_age_secs, 3600n);
  const keys = invoiceTermsToScVal({ vatBps: 2100, withholdingBps: 1500, buckets: [{ name: 'irpf', bps: 500 }] })
    .map()!
    .map((e: xdr.ScMapEntry) => e.key().sym().toString());
  assert.deepEqual(keys, ['buckets', 'vat_bps', 'withholding_bps']);
});

const consulting: PaymentRequest = {
  invoiceNumber: '2026A-0044',
  currency: 'EUR',
  withholding: { rate: '15' },
  lines: [
    { description: 'Consultoría', quantity: '1', unitPrice: '1000', vatRate: '21' },
    { description: 'Horas de soporte', quantity: '2.5', unitPrice: '40.10', vatRate: '21' },
  ],
};

test('expected payment totals: line, then VAT per rate, then withholding, to the cent', () => {
  const t = requestTotals(consulting);
  assert.deepEqual(t.lines.map(money), ['1000.00', '100.25']);
  assert.equal(money(t.net), '1100.25');
  assert.equal(money(t.tax), '231.05'); // 1100.25 x 21% = 231.0525
  assert.equal(money(t.withheld), '165.04'); // 1100.25 x 15% = 165.0375
  assert.equal(money(t.payable), '1166.26');
  assert.equal(payableUnits(consulting), 1_166_2600000n);
  assert.deepEqual(requestTerms(consulting, [{ name: 'irpf', bps: 500 }]), { vatBps: 2100, withholdingBps: 1500, buckets: [{ name: 'irpf', bps: 500 }] });
  // The vault's split of the payable amount gives back the request's own VAT, to the cent.
  const s = splitWithheld({ vatBps: 2100, buckets: [{ name: 'irpf', bps: 500 }] }, 1500, payableUnits(consulting));
  assert.ok(s.vat >= 231_0400000n && s.vat <= 231_0600000n, s.vat.toString());
  assert.deepEqual(requestRef(consulting), invoiceReference('2026A-0044'));
});

test('anchor: SEP-1, SEP-10 login, SEP-24 withdrawal, and a muxed payout only to the tax destination', async () => {
  const server = Keypair.random();
  const anchorAccount = Keypair.random().publicKey();
  const owner = Keypair.random();
  let domain = '';
  const http = createServer(async (req, res) => {
    const url = new URL(req.url!, `http://${domain}`);
    const send = (code: number, body: unknown, type = 'application/json') => {
      res.writeHead(code, { 'content-type': type });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    let body = '';
    for await (const chunk of req) body += chunk;
    if (url.pathname === '/.well-known/stellar.toml') {
      return send(
        200,
        [
          `NETWORK_PASSPHRASE="${Networks.TESTNET}"`,
          `SIGNING_KEY="${server.publicKey()}"`,
          `WEB_AUTH_ENDPOINT="http://${domain}/auth"`,
          `TRANSFER_SERVER_SEP0024="http://${domain}/sep24"`,
          '[[CURRENCIES]]',
          'code="EURC"',
          `issuer="${STABLECOINS.testnet.EURC.issuer}"`,
        ].join('\n'),
        'text/plain',
      );
    }
    if (url.pathname === '/auth' && req.method === 'GET') {
      const tx = WebAuth.buildChallengeTx(server, url.searchParams.get('account')!, domain, 300, Networks.TESTNET, domain);
      return send(200, { transaction: tx, network_passphrase: Networks.TESTNET });
    }
    if (url.pathname === '/auth' && req.method === 'POST') {
      const signed = JSON.parse(body).transaction;
      WebAuth.verifyChallengeTxSigners(signed, server.publicKey(), Networks.TESTNET, [owner.publicKey()], domain, domain);
      return send(200, { token: 'jwt-for-owner' });
    }
    if (req.headers.authorization !== 'Bearer jwt-for-owner') return send(403, { error: 'forbidden' });
    if (url.pathname === '/sep24/transactions/withdraw/interactive') return send(200, { type: 'interactive_customer_info_needed', url: `http://${domain}/form`, id: 'w1' });
    if (url.pathname === '/sep24/transaction') {
      return send(200, { transaction: { id: 'w1', status: 'pending_user_transfer_start', withdraw_anchor_account: anchorAccount, withdraw_memo: '4242', withdraw_memo_type: 'id', amount_in: '4310' } });
    }
    send(404, { error: 'not found' });
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  domain = `127.0.0.1:${(http.address() as AddressInfo).port}`;
  try {
    const a = await anchorInfo(domain, { allowHttp: true });
    assert.equal(a.signingKey, server.publicKey());
    const token = await anchorAuth(a, owner, Networks.TESTNET);
    assert.equal(token, 'jwt-for-owner');
    // A challenge signed by someone else is rejected before signing.
    const fake = { ...a, signingKey: Keypair.random().publicKey() };
    await assert.rejects(() => anchorAuth(fake, owner, Networks.TESTNET));
    const started = await startWithdrawal(a, token, { assetCode: 'EURC', account: owner.publicKey(), amount: '4310' });
    assert.equal((started as { interactiveUrl: string }).interactiveUrl, `http://${domain}/form`);
    const target = await withdrawalStatus(a, token, 'w1');
    const to = anchorPayout(target, anchorAccount);
    const m = MuxedAccount.fromAddress(to, '0');
    assert.equal(m.baseAccount().accountId(), anchorAccount);
    assert.equal(m.id(), '4242');
    assert.throws(() => anchorPayout(target, Keypair.random().publicKey()), /propose the anchor's account/);
    assert.throws(() => anchorPayout({ ...target, memoType: 'text', memo: 'abc' }, anchorAccount), /id memo/);
  } finally {
    http.close();
  }
});

// Silence the unused-import check for helpers used only as types above.
void TransactionBuilder;

test('tax tool exports: the base is income, the VAT is held apart, tax paid leaves', async () => {
  const { taxToolCsv } = await import('../tax-exports.js');
  const rows = [
    { ledger: 1, closedAt: '2026-10-17T10:00:00Z', txHash: 'aa', kind: 'received' as const, token: 'C1', gross: 1_210n * UNIT, net: 800n * UNIT, vat: 210n * UNIT, reserve: 410n * UNIT, reference: '00'.repeat(32) },
    { ledger: 2, closedAt: '2026-10-18T10:00:00.123Z', txHash: 'bb', kind: 'tax_paid' as const, token: 'C1', amount: 210n * UNIT, bucket: 'vat' },
    { ledger: 3, closedAt: '2026-10-19T10:00:00Z', txHash: 'cc', kind: 'released' as const, token: 'C1', amount: 5n * UNIT },
  ];
  const k = taxToolCsv('koinly', rows, () => 'USDC').trim().split('\n');
  assert.equal(k[0], 'Date,Sent Amount,Sent Currency,Received Amount,Received Currency,Fee Amount,Fee Currency,Net Worth Amount,Net Worth Currency,Tag,Description,TxHash');
  assert.equal(k.length, 4);
  assert.ok(k[1].startsWith('2026-10-17 10:00:00,,,1000,USDC,,,,,other income,"Payment received, excluding VAT; 200 set aside for income tax'), k[1]);
  assert.ok(k[2].startsWith('2026-10-17 10:00:00,,,210,USDC,,,,,,"VAT collected'), k[2]);
  assert.match(k[3], /^2026-10-18 10:00:00,210,USDC,,,,,,,,Tax paid from the Kyros vault \(VAT\),bb$/);
  const c = taxToolCsv('cointracking', rows, () => 'USDC').trim().split('\n');
  assert.equal(c[0], 'Type,Buy Amount,Buy Currency,Sell Amount,Sell Currency,Fee,Fee Currency,Exchange,Trade-Group,Comment,Date,Tx-ID');
  assert.match(c[1], /^Income,1000,USDC,,,,,Kyros,,/);
  assert.match(c[3], /^Withdrawal,,,210,USDC,/);
});
