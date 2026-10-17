// Publishes each country's public holidays to a Kyros Rate Registry, for the
// given years (default: this year and the next), from rule-packs/holidays.
// A year's list can be replaced until the year starts; after that only new
// future days are added (they can only make due dates later). Dry run unless --apply.
//
//   STELLAR_RPC_URL=... REGISTRY_ADMIN_SECRET=S... \
//   node scripts/sync-holidays.mjs --registry C... [--years 2027,2028] [--mainnet] [--apply]
import { Keypair, Networks } from '@stellar/stellar-sdk';
import { Contract, xdr } from '@stellar/stellar-sdk';
import { KyrosClient, listRulePacks, loadHolidays, registryHolidays } from '../dist/index.js';

const args = process.argv.slice(2);
const opt = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const registry = opt('--registry');
if (!registry) throw new Error('--registry C... is required');
const apply = args.includes('--apply');
const now = new Date();
const years = opt('--years')?.split(',').map(Number) ?? [now.getUTCFullYear(), now.getUTCFullYear() + 1];
const rpcUrl = process.env.STELLAR_RPC_URL ?? 'https://soroban-testnet.stellar.org';
const passphrase = args.includes('--mainnet') ? Networks.PUBLIC : Networks.TESTNET;
const secret = process.env.REGISTRY_ADMIN_SECRET;
const admin = secret ? Keypair.fromSecret(secret) : undefined;
if (apply && !admin) throw new Error('REGISTRY_ADMIN_SECRET is required with --apply');
const c = new KyrosClient({ rpcUrl, networkPassphrase: passphrase, readAs: admin?.publicKey() });
const today = Math.floor(Date.now() / 86_400_000);

const done = new Set();
for (const id of listRulePacks()) {
  const data = loadHolidays(id);
  if (!data || done.has(data.country)) continue;
  done.add(data.country);
  for (const y of years) {
    const want = registryHolidays(data, y);
    const have = await c.holidays(registry, data.country, y);
    const started = Date.UTC(y, 0, 1) / 86_400_000 <= today;
    if (!have.length || !started) {
      if (JSON.stringify([...have].sort()) === JSON.stringify(want)) continue;
      console.log(`SET      ${data.country} ${y}: ${want.length} days${apply ? '' : ' (dry run)'}`);
      if (apply) console.log(`         tx ${(await c.send(admin, c.setHolidaysOp(registry, data.country, y, want))).hash}`);
      continue;
    }
    for (const d of want.filter((d) => !have.includes(d) && d > today)) {
      console.log(`ADD      ${data.country} day ${new Date(d * 86_400_000).toISOString().slice(0, 10)}${apply ? '' : ' (dry run)'}`);
      if (apply) console.log(`         tx ${(await c.send(admin, new Contract(registry).call('add_holiday', xdr.ScVal.scvSymbol(data.country), xdr.ScVal.scvU32(d)))).hash}`);
    }
    const gone = have.filter((d) => !want.includes(d));
    if (gone.length) console.log(`KEPT     ${data.country} ${y}: ${gone.length} day(s) no longer in the data stay (the year has started)`);
  }
}
