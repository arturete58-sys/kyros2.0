// A public keeper for Stellar testnet: finds vaults with scheduled tax payments
// (from their events, plus the vaults it already knew) and runs every payment
// whose date has come. run_scheduled is permissionless and only pays a vault's
// own tax destination, so the keeper needs no user key: a throwaway account
// funded by friendbot pays the network fees.
//
//   node scripts/testnet-keeper.mjs [--state keeper-state.json] [--out keeper.md]
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { Keypair, Networks, rpc } from '@stellar/stellar-sdk';
import { Keeper, KyrosClient, vaultsWithScheduledPayments } from '../dist/index.js';

const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const stateFile = opt('--state', 'keeper-state.json');
const out = opt('--out');
const rpcUrl = process.env.STELLAR_RPC_URL ?? 'https://soroban-testnet.stellar.org';

const key = Keypair.random();
const fb = await fetch(`https://friendbot.stellar.org?addr=${key.publicKey()}`);
if (!fb.ok) throw new Error(`friendbot: HTTP ${fb.status}`);
const client = new KyrosClient({ rpcUrl, networkPassphrase: Networks.TESTNET, readAs: key.publicKey() });
const server = new rpc.Server(rpcUrl);

const known = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')).vaults ?? [] : [];
const health = await server.getHealth();
const latest = (await server.getLatestLedger()).sequence;
const start = Math.max(health.oldestLedger ?? latest - 100_000, latest - 120_000) + 10;
const seen = await vaultsWithScheduledPayments(server, start);
const vaults = [...new Set([...known, ...seen])];

const lines = [];
const keeper = new Keeper(client, key, [], () => {}, vaults, (r) => lines.push(r.error ? `| ${r.vault.slice(0, 8)}… | #${r.id} | failed: ${r.error.slice(0, 120).replace(/\|/g, '/')} |` : `| ${r.vault.slice(0, 8)}… | #${r.id} | [paid](https://stellar.expert/explorer/testnet/tx/${r.hash}) |`));
const results = await keeper.runDue();

// Keep the vaults that still have payments waiting.
const still = [];
for (const v of vaults) {
  try {
    if ((await client.scheduledPayments(v)).length) still.push(v);
  } catch {
    /* a vault from an earlier testnet reset */
  }
}
writeFileSync(stateFile, JSON.stringify({ vaults: still, at: new Date().toISOString() }, null, 1));

const report = [
  `## Testnet keeper, ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`,
  '',
  `Watched ${vaults.length} vault(s) with scheduled payments (${seen.length} from recent events); ran ${results.filter((r) => r.hash).length} due payment(s); ${still.length} vault(s) still have payments waiting.`,
  '',
  ...(lines.length ? ['| Vault | Payment | Result |', '| --- | --- | --- |', ...lines] : ['No payment was due.']),
].join('\n');
console.log(report);
if (out) writeFileSync(out, report + '\n');
if (results.some((r) => r.error && r.id)) process.exitCode = 1;
