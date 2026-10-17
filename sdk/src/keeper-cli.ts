#!/usr/bin/env node
/**
 * kyros-keeper: sweep Kyros inboxes as payments arrive.
 *
 *   KEEPER_SECRET=S... kyros-keeper --rpc https://soroban-testnet.stellar.org \
 *     --network testnet --watch <inbox>:<token> [--watch ...] [--vault <vault> ...] [--interval 5000]
 *
 * With --vault it also runs that vault's scheduled tax payments on their date.
 *
 * Finish a payment made from another chain (if the payer's page closed
 * before Circle's attestation arrived):
 *
 *   KEEPER_SECRET=S... kyros-keeper --network testnet --relay-cctp <receiver> \
 *     --source-domain 6 --tx 0x<burn transaction hash>
 *
 * The secret only pays network fees; it never controls user funds.
 */
import { Keypair, Networks } from '@stellar/stellar-sdk';
import { KyrosClient } from './client.js';
import { Keeper } from './keeper.js';
import { fetchAttestation, mintAndPayOp } from './cctp.js';

const args = process.argv.slice(2);
const all = (n: string) => args.flatMap((a, i) => (a === `--${n}` ? [args[i + 1]] : []));
const one = (n: string, d?: string) => all(n)[0] ?? d;

const secret = process.env.KEEPER_SECRET;
if (!secret) {
  console.error('KEEPER_SECRET is required (an account that pays the sweep fees)');
  process.exit(2);
}
const network = one('network', 'testnet');
const passphrase = network === 'public' ? Networks.PUBLIC : network === 'testnet' ? Networks.TESTNET : network!;
const rpcUrl = one('rpc', network === 'public' ? undefined : 'https://soroban-testnet.stellar.org');
if (!rpcUrl) {
  console.error('--rpc is required on mainnet');
  process.exit(2);
}
const relay = one('relay-cctp');
if (relay) {
  const tx = one('tx');
  const domain = Number(one('source-domain'));
  if (!tx || !Number.isInteger(domain)) {
    console.error('--relay-cctp needs --source-domain <n> and --tx <hash>');
    process.exit(2);
  }
  const key = Keypair.fromSecret(secret);
  const client = new KyrosClient({ rpcUrl, networkPassphrase: passphrase, readAs: key.publicKey() });
  const a = await fetchAttestation(network === 'testnet' ? 'testnet' : 'mainnet', domain, tx, { onWait: (s) => console.log(`waiting for Circle: ${s}`) });
  const r = await client.send(key, mintAndPayOp(relay, a));
  console.log(`paid into the vault: tx ${r.hash}`);
  process.exit(0);
}
const watched = all('watch').map((w) => {
  const [inbox, token] = w.split(':');
  if (!inbox || !token) throw new Error(`--watch takes <inbox>:<token>, got ${w}`);
  return { inbox, token };
});
const vaults = all('vault');
if (watched.length === 0 && vaults.length === 0) {
  console.error('nothing to watch: add --watch <inbox>:<token> or --vault <vault>');
  process.exit(2);
}
const key = Keypair.fromSecret(secret);
const client = new KyrosClient({ rpcUrl, networkPassphrase: passphrase, readAs: key.publicKey() });
const keeper = new Keeper(client, key, watched, (r) =>
  console.log(new Date().toISOString(), r.error ? `error ${r.inbox}: ${r.error}` : `swept ${r.gross} from ${r.inbox} tx ${r.hash}`),
  vaults,
  (r) => console.log(new Date().toISOString(), r.error ? `error ${r.vault} #${r.id}: ${r.error}` : `paid scheduled #${r.id} of ${r.vault} tx ${r.hash}`),
);
process.on('SIGINT', () => keeper.stop());
process.on('SIGTERM', () => keeper.stop());
console.log(`kyros-keeper watching ${watched.length} inbox(es) and ${vaults.length} vault(s) on ${network}`);
await keeper.run(Number(one('interval', '5000')));
