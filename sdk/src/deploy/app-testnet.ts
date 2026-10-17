/**
 * Sets up what the Kyros web app uses on Stellar testnet, and writes it to
 * app/public/testnet.json:
 *   - the uploaded contract code (vault, inbox) and a shared Router;
 *   - a Rate Registry seeded with every rule pack's standard VAT rate;
 *   - two test tokens, KUSD and KEUR, whose issuer secret is published on
 *     purpose (testnet only, no value) so the app can give test money to a
 *     simulated client;
 *   - a deep Soroswap testnet pool KUSD/KEUR at Reflector's EUR/USD price,
 *     and the Kyros swapper over the Soroswap router;
 *   - a test "tax authority" account that tax payments go to.
 *
 *   node dist/deploy/app-testnet.js --wasm-dir ../contracts/target/wasm32v1-none/release --out ../app/public/testnet.json
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Asset, BASE_FEE, Contract, Keypair, Networks, Operation, scValToNative, TransactionBuilder, xdr } from '@stellar/stellar-sdk';
import { KyrosClient } from '../client.js';
import { REFLECTOR, SOROSWAP_ROUTER } from '../assets.js';
import { listRulePacks, loadRulePack } from '../rulepacks.js';
import { registrySyncPlan } from '../registry.js';
import { addr, i128, oracleAssetToScVal, u64 } from '../scval.js';
import { parseAmount } from '../split.js';

const args = process.argv.slice(2);
const flag = (n: string, d?: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : d;
};
const RPC = process.env.STELLAR_RPC_URL ?? 'https://soroban-testnet.stellar.org';
const PASS = Networks.TESTNET;
const NOTICE = 120n;
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fund(pub: string): Promise<void> {
  for (let i = 0; i < 6; i++) {
    const r = await fetch(`https://friendbot.stellar.org?addr=${pub}`).catch(() => null);
    if (r?.ok) return;
    await sleep(4000);
  }
  throw new Error(`friendbot could not fund ${pub}`);
}

async function classic(c: KyrosClient, source: Keypair, ops: xdr.Operation[]): Promise<string> {
  const account = await c.server.getAccount(source.publicKey());
  const b = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: PASS });
  ops.forEach((o) => b.addOperation(o));
  const tx = b.setTimeout(60).build();
  tx.sign(source);
  const sent = await c.server.sendTransaction(tx);
  if (sent.status === 'ERROR') throw new Error(`classic tx failed: ${sent.errorResult?.toXDR('base64')}`);
  const done = await c.server.pollTransaction(sent.hash, { attempts: 30 });
  if (done.status !== 'SUCCESS') throw new Error(`classic tx ${sent.hash} ${done.status}`);
  return sent.hash;
}

async function main(): Promise<void> {
  const wasmDir = flag('wasm-dir', '../contracts/target/wasm32v1-none/release')!;
  const out = flag('out', '../app/public/testnet.json')!;
  const wasm = (n: string) => readFileSync(join(wasmDir, `${n}.wasm`));
  const k = { deployer: Keypair.random(), issuer: Keypair.random(), lp: Keypair.random(), tax: Keypair.random() };
  const c = new KyrosClient({ rpcUrl: RPC, networkPassphrase: PASS, readAs: k.deployer.publicKey() });

  log('funding accounts');
  for (const kp of Object.values(k)) await fund(kp.publicKey());

  log('test tokens KUSD and KEUR');
  const usd = new Asset('KUSD', k.issuer.publicKey());
  const eur = new Asset('KEUR', k.issuer.publicKey());
  await classic(c, k.lp, [Operation.changeTrust({ asset: usd }), Operation.changeTrust({ asset: eur })]);
  await classic(c, k.tax, [Operation.changeTrust({ asset: usd }), Operation.changeTrust({ asset: eur })]);
  await classic(c, k.issuer, [
    Operation.payment({ destination: k.lp.publicKey(), asset: usd, amount: '2000000' }),
    Operation.payment({ destination: k.lp.publicKey(), asset: eur, amount: '2000000' }),
  ]);
  await c.send(k.issuer, Operation.createStellarAssetContract({ asset: usd }));
  await c.send(k.issuer, Operation.createStellarAssetContract({ asset: eur }));
  const usdToken = usd.contractId(PASS);
  const eurToken = eur.contractId(PASS);

  log('uploading the contracts');
  const vaultHash = await c.upload(k.deployer, wasm('kyros_reserve_vault'));
  const inboxHash = await c.upload(k.deployer, wasm('kyros_inbox'));
  const routerHash = await c.upload(k.deployer, wasm('kyros_router'));
  const registryHash = await c.upload(k.deployer, wasm('kyros_rate_registry'));
  const swapperHash = await c.upload(k.deployer, wasm('kyros_swap_soroswap'));
  const router = await c.deployRouter(k.deployer, routerHash);

  log('rate registry, seeded with every pack\'s standard VAT');
  const registry = await c.deployRegistry(k.deployer, registryHash, k.deployer.publicKey(), NOTICE);
  const now = BigInt(Math.floor(Date.now() / 1000));
  let seeded = 0;
  for (const id of listRulePacks()) {
    const pack = loadRulePack(id);
    for (const a of registrySyncPlan(pack, {}, now, NOTICE)) {
      if (a.rate !== 'standard') continue;
      if (a.kind === 'seed') await c.send(k.deployer, c.seedRateOp(registry.contractId, pack.country, a.rate, a.bps));
      else if (a.kind === 'publish') await c.send(k.deployer, c.publishRateOp(registry.contractId, pack.country, a.rate, a.from, a.bps));
      else continue;
      seeded++;
    }
  }
  log(`registry: ${seeded} entries`);

  log('Soroswap pool at Reflector\'s EUR/USD price, and the swapper');
  let swapper: string | null = null;
  let eurUsd: string | null = null;
  try {
    const p = scValToNative(await c.read(REFLECTOR.testnet.fiat, 'lastprice', oracleAssetToScVal({ other: 'EUR' }))) as { price: bigint } | null;
    if (!p) throw new Error('no EUR price on the Reflector testnet oracle');
    const kusd = parseAmount('1160000');
    const keur = (kusd * 10n ** 14n) / BigInt(p.price);
    await c.send(
      k.lp,
      new Contract(SOROSWAP_ROUTER.testnet).call('add_liquidity', addr(usdToken), addr(eurToken), i128(kusd), i128(keur), i128(0n), i128(0n), addr(k.lp.publicKey()), u64(BigInt(Math.floor(Date.now() / 1000) + 600))),
    );
    swapper = (await c.deploySwapper(k.deployer, swapperHash, SOROSWAP_ROUTER.testnet)).contractId;
    eurUsd = (Number(p.price) / 1e14).toFixed(4);
  } catch (e) {
    log(`euro conversion not available: ${(e as Error).message}`);
  }

  const config = {
    network: 'testnet',
    rpcUrl: RPC,
    networkPassphrase: PASS,
    deployedAt: new Date().toISOString(),
    noticeSecs: Number(NOTICE),
    wasm: { vault: vaultHash.toString('hex'), inbox: inboxHash.toString('hex') },
    router: router.contractId,
    registry: registry.contractId,
    tokens: {
      usd: { code: 'KUSD', issuer: k.issuer.publicKey(), contract: usdToken },
      eur: { code: 'KEUR', issuer: k.issuer.publicKey(), contract: eurToken },
    },
    // Test tokens with no value: the app uses this key to give test money to a simulated client.
    faucetSecret: k.issuer.secret(),
    taxAccount: k.tax.publicKey(),
    conversion: swapper ? { swapper, oracle: REFLECTOR.testnet.fiat, eurUsdAtDeploy: eurUsd } : null,
    // passkey-kit's canonical smart-wallet code on testnet (stellar/passkey-kit, docs/deployments-2026-09-01.md).
    passkeyWalletWasmHash: '97ce047884106b1c6c3bb40b8973cc48db1c4dad95c9e20462bf2c701daa764e',
  };
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(config, null, 2) + '\n');
  log(`wrote ${out}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
