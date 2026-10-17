// Tests for paying a vault from another chain through CCTP.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StrKey, scValToNative } from '@stellar/stellar-sdk';
import { burnCalls, contractBytes32, depositForBurnWithHookData, EVM_TESTNETS, fetchAttestation, grossUp, kyrosHookData, mintAndPayOp, STELLAR_CCTP, toCctpUnits } from '../cctp.js';

const vault = StrKey.encodeContract(Buffer.alloc(32, 0x11));
const receiver = StrKey.encodeContract(Buffer.alloc(32, 0xab));
const ref = new Uint8Array(32).fill(0x22);

test('the hook data is the layout the receiver contract reads', () => {
  const h = kyrosHookData(vault, ref);
  assert.equal(Buffer.from(h).toString('hex'), '00'.repeat(24) + '00000001' + '00000040' + '11'.repeat(32) + '22'.repeat(32));
  assert.throws(() => kyrosHookData('GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'));
});

test('depositForBurnWithHook is ABI-encoded like viem encodes it', () => {
  const base = EVM_TESTNETS.find((c) => c.id === 'base-sepolia')!;
  // Vectors from viem 2.21 encodeFunctionData.
  const a = depositForBurnWithHookData({
    amount: 121_000_000n,
    destinationDomain: 27,
    mintRecipient: contractBytes32(receiver),
    burnToken: base.usdc,
    destinationCaller: contractBytes32(receiver),
    maxFee: 12_100n,
    minFinalityThreshold: 1000,
    hookData: kyrosHookData(vault, ref),
  });
  assert.equal(
    a,
    '0x779b432d0000000000000000000000000000000000000000000000000000000007365040000000000000000000000000000000000000000000000000000000000000001babababababababababababababababababababababababababababababababab000000000000000000000000036cbd53842c5426634e7929541ec2318f3dcf7eabababababababababababababababababababababababababababababababab0000000000000000000000000000000000000000000000000000000000002f4400000000000000000000000000000000000000000000000000000000000003e800000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000060000000000000000000000000000000000000000000000000000000010000004011111111111111111111111111111111111111111111111111111111111111112222222222222222222222222222222222222222222222222222222222222222',
  );
  const b = depositForBurnWithHookData({
    amount: 5n,
    destinationDomain: 27,
    mintRecipient: contractBytes32(receiver),
    burnToken: base.usdc,
    destinationCaller: contractBytes32(receiver),
    maxFee: 0n,
    minFinalityThreshold: 2000,
    hookData: Uint8Array.from([1, 2, 3, 4, 5]),
  });
  assert.equal(
    b,
    '0x779b432d0000000000000000000000000000000000000000000000000000000000000005000000000000000000000000000000000000000000000000000000000000001babababababababababababababababababababababababababababababababab000000000000000000000000036cbd53842c5426634e7929541ec2318f3dcf7eabababababababababababababababababababababababababababababababab000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000007d0000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000000050102030405000000000000000000000000000000000000000000000000000000',
  );
});

test('amounts: 7 to 6 decimals rounding up, and the fast fee grossed up so the full amount arrives', () => {
  assert.equal(toCctpUnits(1_060n * 10_000_000n), 1_060_000_000n);
  assert.equal(toCctpUnits(11n), 2n);
  const { amount, maxFee } = grossUp(1_060_000_000n, 1.3);
  assert.equal(amount - maxFee, 1_060_000_000n);
  // Circle's fee on the gross fits in maxFee.
  assert.ok(BigInt(Math.ceil((Number(amount) * 1.3) / 10_000)) <= maxFee);
  assert.deepEqual(grossUp(5n, 0), { amount: 5n, maxFee: 0n });
});

test('the client signs an approve for exactly the burn, and the burn names the receiver twice', () => {
  const base = EVM_TESTNETS[0];
  const c = burnCalls(base, { receiver, vault, reference: ref, amount: 1_210n * 10_000_000n, feeBps: 1, fast: true });
  assert.equal(c.approve.to, base.usdc);
  assert.ok(c.approve.data.endsWith(c.amount.toString(16).padStart(64, '0')));
  assert.equal(c.burn.to, base.tokenMessenger);
  assert.equal(c.burn.data.split('ab'.repeat(32)).length, 3);
  assert.equal(c.amount - c.maxFee, 1_210_000_000n);
  const slow = burnCalls(base, { receiver, vault, amount: 10_000_000n, feeBps: 1, fast: false });
  assert.equal(slow.maxFee, 0n);
});

test('the attestation is polled until Circle marks it complete', async () => {
  let n = 0;
  const seen: string[] = [];
  const fake = (async () => {
    n++;
    if (n === 1) return new Response('{}', { status: 404 });
    if (n === 2) return Response.json({ messages: [{ status: 'pending_confirmations', attestation: 'PENDING', message: '0x' }] });
    return Response.json({ messages: [{ status: 'complete', attestation: '0xaa', message: '0xbb' }] });
  }) as typeof fetch;
  const a = await fetchAttestation('testnet', 6, '0x01', { fetch: fake, everyMs: 1, onWait: (s) => seen.push(s) });
  assert.deepEqual(a, { attestation: '0xaa', message: '0xbb' });
  assert.deepEqual(seen, ['not seen yet', 'pending_confirmations']);
  const op = mintAndPayOp(STELLAR_CCTP.testnet.forwarder, a);
  const args = op.body().invokeHostFunctionOp().hostFunction().invokeContract().args();
  assert.deepEqual(args.map((x) => Buffer.from(scValToNative(x)).toString('hex')), ['bb', 'aa']);
});

test('Circle addresses are well formed', () => {
  for (const n of ['mainnet', 'testnet'] as const) for (const a of Object.values(STELLAR_CCTP[n])) assert.ok(StrKey.isValidContract(a), a);
  for (const c of EVM_TESTNETS) assert.match(c.usdc, /^0x[0-9a-fA-F]{40}$/);
});
