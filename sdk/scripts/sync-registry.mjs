// Brings an on-chain Kyros Rate Registry in step with the rule packs: seeds rates
// the registry does not list, publishes enacted future changes (at least the
// registry's notice ahead), withdraws future entries a pack no longer has, and
// reports changes that are already too close to publish in time. Proposals
// (not yet law) are never published. Dry run unless --apply.
//
//   STELLAR_RPC_URL=... REGISTRY_ADMIN_SECRET=S... \
//   node scripts/sync-registry.mjs --registry C... [--packs es,de] [--testnet] [--apply]
import { Keypair, Networks } from '@stellar/stellar-sdk';
import { KyrosClient, listRulePacks, loadRulePack, registryEntries, registrySyncPlan } from '../dist/index.js';

const args = process.argv.slice(2);
const opt = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const registry = opt('--registry');
if (!registry) throw new Error('--registry C... is required');
const apply = args.includes('--apply');
const ids = opt('--packs')?.split(',') ?? listRulePacks();
const rpcUrl = process.env.STELLAR_RPC_URL ?? 'https://soroban-testnet.stellar.org';
const passphrase = args.includes('--mainnet') ? Networks.PUBLIC : Networks.TESTNET;
const secret = process.env.REGISTRY_ADMIN_SECRET;
const admin = secret ? Keypair.fromSecret(secret) : undefined;
if (apply && !admin) throw new Error('REGISTRY_ADMIN_SECRET is required with --apply');
const c = new KyrosClient({ rpcUrl, networkPassphrase: passphrase, readAs: admin?.publicKey() });

const now = BigInt(Math.floor(Date.now() / 1000));
const minNotice = await c.registryMinNotice(registry);
let late = 0;
for (const id of ids) {
  const pack = loadRulePack(id);
  const onChain = {};
  for (const rate of Object.keys(registryEntries(pack))) onChain[rate] = await c.rateSchedule(registry, pack.country, rate);
  for (const a of registrySyncPlan(pack, onChain, now, minNotice)) {
    const what = a.kind === 'seed' ? `${pack.country}/${a.rate} = ${a.bps / 100}% (today)` : a.kind === 'withdraw' ? `${pack.country}/${a.rate} entry of ${a.day}` : `${pack.country}/${a.rate} = ${a.bps / 100}% from ${a.day}`;
    if (a.kind === 'late') {
      late++;
      console.log(`LATE     ${what}: inside the registry's notice; vault owners must apply it with propose_rule_at`);
      continue;
    }
    console.log(`${a.kind.toUpperCase().padEnd(8)} ${what}${apply ? '' : ' (dry run)'}`);
    if (!apply) continue;
    const op =
      a.kind === 'seed' ? c.seedRateOp(registry, pack.country, a.rate, a.bps)
      : a.kind === 'publish' ? c.publishRateOp(registry, pack.country, a.rate, a.from, a.bps)
      : c.withdrawRateOp(registry, pack.country, a.rate, a.from);
    const sent = await c.send(admin, op);
    console.log(`         tx ${sent.hash}`);
  }
}
if (late) process.exitCode = 1;
