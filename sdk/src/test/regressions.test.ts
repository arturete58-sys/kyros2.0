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

test('a move proposal on a busy inbox is not missed', async () => {
  const { inboxMoves } = await import('../events.js');
  const { nativeToScVal, StrKey } = await import('@stellar/stellar-sdk');
  const sym = (s: string) => xdr.ScVal.scvSymbol(s);
  const thief = StrKey.encodeContract(Buffer.alloc(32, 9));
  const ev = (i: number, kind: string, value: xdr.ScVal) => ({ id: String(i), ledger: i, ledgerClosedAt: '2026-11-13T00:00:00Z', txHash: `h${i}`, topic: [sym('kyros_inbox'), sym(kind)], value });
  // 450 sweeps, then someone proposes moving the inbox to another vault.
  const all = [
    ...Array.from({ length: 450 }, (_, i) => ev(i, 'swept', nativeToScVal(1n, { type: 'i128' }))),
    ev(450, 'move_proposed', nativeToScVal({ vault: nativeToScVal(thief, { type: 'address' }), ready_at: nativeToScVal(99n, { type: 'u64' }) })),
  ];
  const asked: unknown[] = [];
  const server = {
    getEvents: async (req: { filters: { topics?: string[][] }[]; cursor?: string }) => {
      asked.push(req.filters[0].topics);
      const wanted = req.filters[0].topics ? all.filter((e) => req.filters[0].topics!.some((t) => t[1] === e.topic[1].toXDR('base64'))) : all;
      const from = req.cursor ? Number(req.cursor) : 0;
      const page = wanted.slice(from, from + 200);
      return { events: page, cursor: String(from + page.length) };
    },
  };
  // Before: one page of the inbox's events (the first 200 sweeps) and no move.
  const moves = await inboxMoves(server as never, 'CINBOX', 1);
  assert.equal(moves.length, 1);
  assert.equal(moves[0].vault, thief);
});

test('the guardian finds a proposal on a busy vault', async () => {
  const { vaultEvents, GUARD_EVENT_KINDS } = await import('../events.js');
  const { nativeToScVal, StrKey } = await import('@stellar/stellar-sdk');
  const sym = (s: string) => xdr.ScVal.scvSymbol(s);
  const thief = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 5));
  const ev = (i: number, topic: xdr.ScVal[], value: xdr.ScVal) => ({ id: String(i), ledger: i, ledgerClosedAt: '2026-11-13T00:00:00Z', txHash: `h${i}`, topic, value });
  const received = nativeToScVal({ gross: nativeToScVal(1n, { type: 'i128' }) });
  // 12,000 payments in a day, then someone proposes a new payout address.
  const all = [
    ...Array.from({ length: 12_000 }, (_, i) => ev(i, [sym('kyros_vault'), sym('received'), sym('T'), nativeToScVal(1, { type: 'u32' })], received)),
    ev(12_000, [sym('kyros_vault'), sym('payout_proposed')], nativeToScVal({ payout: nativeToScVal(thief, { type: 'address' }), ready_at: nativeToScVal(99n, { type: 'u64' }) })),
  ];
  const server = {
    getEvents: async (req: { filters: { topics?: string[][] }[]; cursor?: string }) => {
      const pats = req.filters.flatMap((f) => f.topics ?? []);
      const wanted = pats.length ? all.filter((e) => pats.some((p) => p.length === e.topic.length && p.every((t, i) => t === '*' || t === e.topic[i].toXDR('base64')))) : all;
      const from = req.cursor ? Number(req.cursor) : 0;
      const page = wanted.slice(from, from + 200);
      return { events: page, cursor: String(from + page.length) };
    },
  };
  // Reading everything stops after 50 pages (10,000 events) and never sees it.
  assert.equal((await vaultEvents(server as never, 'CV', 1)).some((r) => r.kind === 'payout_proposed'), false);
  const rows = await vaultEvents(server as never, 'CV', 1, { kinds: GUARD_EVENT_KINDS });
  assert.deepEqual(rows.map((r) => [r.kind, r.payout]), [['payout_proposed', thief]]);
});
