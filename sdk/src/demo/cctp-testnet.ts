/**
 * End-to-end cross-chain payment on testnet: USDC burned on Base Sepolia,
 * minted on Stellar testnet by Circle's CCTP V2 and paid into a Kyros vault
 * by the Kyros receiver, in one transaction.
 *
 *   1. Deploys a fresh vault (Spain, general: VAT 21% + income tax 20%) that
 *      accepts Circle's testnet USDC, over the contracts in app/public/testnet.json.
 *   2. Burns 1 USDC on Base Sepolia from the test wallet in CCTP_TEST_EVM_KEY,
 *      naming the receiver and the vault (fast transfer).
 *   3. Waits for Circle's attestation and submits `mint_and_pay` on Stellar.
 *   4. Checks the split: net to the owner, reserve held by the vault.
 *
 * The EVM wallet needs Base Sepolia ETH for gas and USDC from
 * faucet.circle.com. Without CCTP_TEST_EVM_KEY the script prints a new key
 * and its address, to fund and store as that secret.
 *
 * `--probe` needs no wallet: it reads the interfaces of Circle's Stellar
 * contracts and checks that the functions the Kyros receiver calls exist with
 * the arguments it passes.
 *
 *   node dist/demo/cctp-testnet.js --config ../app/public/testnet.json [--out report.md] [--probe]
 */
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { Asset, BASE_FEE, contract, Keypair, Networks, Operation, TransactionBuilder } from '@stellar/stellar-sdk';
import { createPublicClient, createWalletClient, http, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { KyrosClient } from '../client.js';
import { burnCalls, EVM_TESTNETS, fastFeeBps, fetchAttestation, mintAndPayOp, STELLAR_CCTP } from '../cctp.js';
import { duesAfter } from '../periods.js';
import { loadRulePack, termsFromPack } from '../rulepacks.js';

const args = process.argv.slice(2);
const flag = (n: string, d?: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : d;
};
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const stellarTx = (h: string) => `https://stellar.expert/explorer/testnet/tx/${h}`;
const stellarContract = (c: string) => `https://stellar.expert/explorer/testnet/contract/${c}`;

interface TestnetConfig {
  rpcUrl: string;
  wasm: { vault: string };
  cctp: { receiver: string; usdc: { code: string; issuer: string; contract: string } };
}

async function fund(pub: string): Promise<void> {
  for (let i = 0; i < 5; i++) {
    if ((await fetch(`https://friendbot.stellar.org?addr=${pub}`)).ok) return;
    await sleep(3000);
  }
  throw new Error(`friendbot could not fund ${pub}`);
}

async function classic(c: KyrosClient, source: Keypair, op: ReturnType<typeof Operation.changeTrust>): Promise<string> {
  const account = await c.server.getAccount(source.publicKey());
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET }).addOperation(op).setTimeout(120).build();
  tx.sign(source);
  const sent = await c.server.sendTransaction(tx);
  if (sent.status === 'ERROR') throw new Error(`classic tx refused: ${sent.errorResult?.result().switch().name}`);
  const done = await c.server.pollTransaction(sent.hash, { attempts: 130, sleepStrategy: () => 1000 });
  if (done.status !== 'SUCCESS') throw new Error(`classic tx ${sent.hash} ${done.status}`);
  return sent.hash;
}

const usdc6 = (x: bigint) => `${x / 1_000_000n}.${(x % 1_000_000n).toString().padStart(6, '0')}`;
const usdc7 = (x: bigint) => `${x / 10_000_000n}.${(x % 10_000_000n).toString().padStart(7, '0')}`;

/** What the Kyros receiver calls on Circle's contracts (contracts/cctp-pay/src/lib.rs). */
const EXPECTED: { contract: 'messageTransmitter' | 'tokenMessengerMinter'; fn: string; args: string[] }[] = [
  { contract: 'messageTransmitter', fn: 'receive_message', args: ['caller', 'message', 'attestation'] },
  { contract: 'tokenMessengerMinter', fn: 'get_local_token', args: ['remote_domain', 'remote_token'] },
];

async function probe(rpcUrl: string, out?: string): Promise<void> {
  const lines = ['## Circle CCTP contracts on Stellar testnet: interfaces', ''];
  let ok = true;
  for (const [name, id] of Object.entries(STELLAR_CCTP.testnet)) {
    const client = await contract.Client.from({ contractId: id, rpcUrl, networkPassphrase: Networks.TESTNET });
    const fns = client.spec.funcs().map((f) => `${f.name().toString()}(${f.inputs().map((i) => i.name().toString()).join(', ')})`);
    lines.push(`- **${name}** \`${id}\`: ${fns.join(', ')}`);
    for (const want of EXPECTED.filter((x) => x.contract === name)) {
      const f = client.spec.funcs().find((x) => x.name().toString() === want.fn);
      const args = f?.inputs().map((i) => i.name().toString()) ?? [];
      const match = !!f && args.length === want.args.length;
      ok &&= match;
      lines.push(`  - ${match ? 'OK' : 'MISSING OR DIFFERENT'}: the receiver calls \`${want.fn}(${want.args.join(', ')})\`${f ? `; Circle's is \`${want.fn}(${args.join(', ')})\`` : ''}`);
    }
  }
  const report = lines.join('\n') + '\n';
  console.log(report);
  if (out) writeFileSync(out, report);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);
  if (!ok) process.exitCode = 1;
}

async function main(): Promise<void> {
  if (args.includes('--probe')) {
    const cfg = JSON.parse(readFileSync(flag('config', '../app/public/testnet.json')!, 'utf8')) as TestnetConfig;
    return probe(cfg.rpcUrl, flag('out'));
  }
  const key = process.env.CCTP_TEST_EVM_KEY as Hex | undefined;
  if (!key) {
    const fresh = generatePrivateKey();
    console.log(`No CCTP_TEST_EVM_KEY. A new test-only key:\n  key:     ${fresh}\n  address: ${privateKeyToAccount(fresh).address}`);
    return;
  }
  const cfg = JSON.parse(readFileSync(flag('config', '../app/public/testnet.json')!, 'utf8')) as TestnetConfig;
  const out = flag('out');
  const chain = EVM_TESTNETS.find((x) => x.id === 'base-sepolia')!;
  const account = privateKeyToAccount(key);
  const pub = createPublicClient({ chain: baseSepolia, transport: http(chain.rpcUrl) });
  const wallet = createWalletClient({ account, chain: baseSepolia, transport: http(chain.rpcUrl) });
  const erc20 = [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] }] as const;

  // ---- The payer's wallet on Base Sepolia ----
  const eth = await pub.getBalance({ address: account.address });
  const usdc = await pub.readContract({ address: chain.usdc as Hex, abi: erc20, functionName: 'balanceOf', args: [account.address] });
  log(`Base Sepolia wallet ${account.address}: ${Number(eth) / 1e18} ETH, ${usdc6(usdc)} USDC`);
  const pay = 10_000_000n; // 1 USDC, 7 decimals
  if (eth < 200_000_000_000_000n || usdc < 1_100_000n) {
    const msg = `The test wallet ${account.address} needs Base Sepolia ETH (at least 0.0002) and 1.1 USDC from faucet.circle.com. Has ${Number(eth) / 1e18} ETH and ${usdc6(usdc)} USDC.`;
    console.log(msg);
    if (out) writeFileSync(out, `## Cross-chain payment on testnet\n\nNot run: ${msg}\n`);
    process.exitCode = 2;
    return;
  }

  // ---- A fresh vault on Stellar testnet that accepts Circle's USDC ----
  const c = new KyrosClient({ rpcUrl: cfg.rpcUrl, networkPassphrase: Networks.TESTNET });
  const k = { owner: Keypair.random(), tax: Keypair.random(), relayer: Keypair.random() };
  log('funding Stellar test accounts');
  for (const kp of Object.values(k)) await fund(kp.publicKey());
  const asset = new Asset(cfg.cctp.usdc.code, cfg.cctp.usdc.issuer);
  for (const kp of [k.owner, k.tax]) await classic(c, kp, Operation.changeTrust({ asset }));
  const terms = termsFromPack(loadRulePack('es'), 'general');
  log('deploying the vault');
  const vault = await c.deployVault(k.relayer, Buffer.from(cfg.wasm.vault, 'hex'), {
    owner: k.owner.publicKey(),
    rule: terms.rule,
    taxDestination: k.tax.publicKey(),
    noticeSecs: 120n,
    period: { kind: 'Seconds', seconds: 86_400n },
    dues: duesAfter(0n),
    tokens: [cfg.cctp.usdc.contract],
  });
  const quote = await c.quote(vault.contractId, pay);

  // ---- Burn on Base Sepolia ----
  const feeBps = await fastFeeBps('testnet', chain.domain);
  const calls = burnCalls(chain, { receiver: cfg.cctp.receiver, vault: vault.contractId, amount: pay, feeBps, fast: true });
  log(`burning ${usdc6(calls.amount)} USDC (max fee ${usdc6(calls.maxFee)}) on Base Sepolia`);
  const approveHash = await wallet.sendTransaction({ to: calls.approve.to as Hex, data: calls.approve.data });
  await pub.waitForTransactionReceipt({ hash: approveHash });
  const burnHash = await wallet.sendTransaction({ to: calls.burn.to as Hex, data: calls.burn.data });
  const burnReceipt = await pub.waitForTransactionReceipt({ hash: burnHash });
  if (burnReceipt.status !== 'success') throw new Error(`burn ${burnHash} reverted`);

  // ---- Circle's attestation, then mint and pay on Stellar ----
  log('waiting for Circle\'s attestation');
  const started = Date.now();
  const attested = await fetchAttestation('testnet', chain.domain, burnHash, { everyMs: 4000, timeoutMs: 30 * 60_000, onWait: (s) => log(`  ${s}`) });
  const waited = Math.round((Date.now() - started) / 1000);
  log('submitting mint_and_pay on Stellar');
  const minted = await c.send(k.relayer, mintAndPayOp(cfg.cctp.receiver, attested));

  // ---- What arrived where ----
  const owner = await c.balance(cfg.cctp.usdc.contract, k.owner.publicKey());
  const held = await c.balance(cfg.cctp.usdc.contract, vault.contractId);
  const ok = owner === quote.net && held === quote.reserve;
  const report = [
    '## Cross-chain payment on testnet (Circle CCTP V2, Base Sepolia to Stellar)',
    '',
    `${ok ? 'Passed' : 'FAILED'}: ${usdc7(pay)} USDC paid from Base Sepolia into a Kyros vault, split as the vault quoted.`,
    '',
    '| Step | Result |',
    '| --- | --- |',
    `| Vault (Spain, general: VAT 21% + income tax 20%) | [${vault.contractId.slice(0, 8)}…](${stellarContract(vault.contractId)}) |`,
    `| Approve on Base Sepolia | [${approveHash.slice(0, 10)}…](${chain.explorer}/tx/${approveHash}) |`,
    `| Burn ${usdc6(calls.amount)} USDC on Base Sepolia (fast transfer) | [${burnHash.slice(0, 10)}…](${chain.explorer}/tx/${burnHash}) |`,
    `| Circle's attestation | after ${waited} s |`,
    `| \`mint_and_pay\` on Stellar | [${minted.hash.slice(0, 8)}…](${stellarTx(minted.hash)}) |`,
    `| Net to the owner | ${usdc7(owner)} USDC (quoted ${usdc7(quote.net)}) |`,
    `| Reserve held by the vault | ${usdc7(held)} USDC (quoted ${usdc7(quote.reserve)}) |`,
    '',
  ].join('\n');
  console.log(report);
  if (out) writeFileSync(out, report);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);
  if (!ok) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
