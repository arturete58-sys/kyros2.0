#!/usr/bin/env node
/**
 * kyros-keeper: sweep Kyros inboxes as payments arrive.
 *
 *   KEEPER_SECRET=S... kyros-keeper --rpc https://soroban-testnet.stellar.org \
 *     --network testnet --watch <inbox>:<token> [--watch ...] [--interval 5000]
 *
 * The secret only pays network fees; it never controls user funds.
 */
import { Keypair, Networks } from '@stellar/stellar-sdk';
import { KyrosClient } from './client.js';
import { Keeper } from './keeper.js';

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
const watched = all('watch').map((w) => {
  const [inbox, token] = w.split(':');
  if (!inbox || !token) throw new Error(`--watch takes <inbox>:<token>, got ${w}`);
  return { inbox, token };
});
if (watched.length === 0) {
  console.error('nothing to watch: add --watch <inbox>:<token>');
  process.exit(2);
}
const key = Keypair.fromSecret(secret);
const client = new KyrosClient({ rpcUrl, networkPassphrase: passphrase, readAs: key.publicKey() });
const keeper = new Keeper(client, key, watched, (r) =>
  console.log(new Date().toISOString(), r.error ? `error ${r.inbox}: ${r.error}` : `swept ${r.gross} from ${r.inbox} tx ${r.hash}`),
);
process.on('SIGINT', () => keeper.stop());
process.on('SIGTERM', () => keeper.stop());
console.log(`kyros-keeper watching ${watched.length} inbox(es) on ${network}`);
await keeper.run(Number(one('interval', '5000')));
