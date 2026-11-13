/**
 * Failures Kyros has had, each reproduced so it cannot come back unnoticed.
 * (The input-VAT cent lost at exchange rates is covered in reserve-extras.test.ts,
 * the yield reserve due soon in the vault's own tests.)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, Networks, xdr, Account, TransactionBuilder, Operation, Asset, BASE_FEE } from '@stellar/stellar-sdk';
import { KyrosClient } from '../client.js';

const client = () => new KyrosClient({ rpcUrl: 'http://127.0.0.1:1', networkPassphrase: Networks.TESTNET, retryDelayMs: 1 });

test('Protocol 30 (November 2026): ledger values with millisecond close times decode', () => {
  // Before stellar-sdk 16.4.1 this threw "XDR Read Error: unknown StellarValueType
  // member for value 3", and the keeper stopped on every ledger after the upgrade.
  const signed = xdr.StellarValue.fromXDR(
    new xdr.StellarValue({
      txSetHash: Buffer.alloc(32, 1),
      closeTime: xdr.Uint64.fromString('1794500000'),
      upgrades: [],
      ext: xdr.StellarValueExt.stellarValueSignedMs(
        new xdr.StellarValueSignedMsValue({
          closeTimeMs: xdr.Uint64.fromString('1794500000123'),
          lcValueSignature: new xdr.LedgerCloseValueSignature({
            nodeId: xdr.PublicKey.publicKeyTypeEd25519(Keypair.random().rawPublicKey()),
            signature: Buffer.alloc(64, 2),
          }),
        }),
      ),
    }).toXDR(),
  );
  assert.equal(signed.ext().switch().value, 3);
  assert.equal(signed.ext().signedMsValue().closeTimeMs().toString(), '1794500000123');
});

function fakeTx(): never {
  return new TransactionBuilder(new Account(Keypair.random().publicKey(), '1'), { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.payment({ destination: Keypair.random().publicKey(), asset: Asset.native(), amount: '1' }))
    .setTimeout(120)
    .build() as never;
}

test('a stale sequence number from a lagging RPC is built and sent again (txBadSeq)', async () => {
  const c = client();
  let n = 0;
  c.prepare = async () => fakeTx();
  c.submit = async () => {
    if (++n < 3) throw Object.assign(new Error('rejected: txBadSeq'), { badSeq: true });
    return { hash: 'ok' };
  };
  assert.equal((await c.send(Keypair.random(), xdr.Operation.fromXDR(fakeOp()))).hash, 'ok');
  assert.equal(n, 3);
});

test('a transaction that failed when applied is simulated and sent once more, not forever', async () => {
  const c = client();
  let n = 0;
  c.prepare = async () => fakeTx();
  c.submit = async () => {
    n++;
    throw Object.assign(new Error('transaction FAILED'), { failedOnChain: true });
  };
  await assert.rejects(c.send(Keypair.random(), xdr.Operation.fromXDR(fakeOp())), /FAILED/);
  assert.equal(n, 2);
});

test('a transaction the network dropped (NOT_FOUND) is sent again until it lands', async () => {
  const c = client();
  const sends: string[] = [];
  let polls = 0;
  Object.assign(c.server, {
    sendTransaction: async () => (sends.push('send'), { status: 'PENDING', hash: 'h' }),
    pollTransaction: async () => (++polls < 3 ? { status: 'NOT_FOUND' } : { status: 'SUCCESS', ledger: 10, returnValue: undefined }),
  });
  const sent = await c.submit(fakeTx(), Keypair.random());
  assert.equal(sent.hash, 'h');
  assert.equal(sends.length, 3);
});

function fakeOp(): Buffer {
  return Operation.payment({ destination: Keypair.random().publicKey(), asset: Asset.native(), amount: '1' }).toXDR();
}

test('amounts typed the Spanish way are read as meant', async () => {
  const { normalizeAmount } = await import('../split.js');
  // Before: "1.210" became 1.21 and "1.210,50" was not a number at all.
  const cases: [string, string | null][] = [
    ['1.210', '1210'],
    ['1.210,50', '1210.50'],
    ['1,210.50', '1210.50'],
    ['1 210,5', '1210.5'],
    ['1 210,5', '1210.5'],
    ["1'210.5", '1210.5'],
    ['1.000.000', '1000000'],
    ['12,5', '12.5'],
    ['1210.5', '1210.5'],
    ['0.125', '0.125'],
    ['0,125', '0.125'],
    ['1000', '1000'],
    [',5', '0.5'],
    ['', null],
    ['abc', null],
    ['-5', null],
    ['1.2.3,4,5', null],
  ];
  for (const [text, want] of cases) assert.equal(normalizeAmount(text), want, text);
});

test('a token with no decimals is shown whole', async () => {
  const { formatAmount, parseAmount } = await import('../split.js');
  // Before: with 0 decimals 1210 came out as ".121".
  assert.equal(formatAmount(1210n, 0), '1210');
  assert.equal(formatAmount(-5n, 0), '-5');
  assert.equal(parseAmount('1210', 0), 1210n);
  assert.equal(formatAmount(12_105_000_000n), '1210.5');
});
