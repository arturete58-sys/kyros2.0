#!/usr/bin/env node
/**
 * kyros-keeper: sweep Kyros inboxes as payments arrive.
 *
 *   KEEPER_SECRET=S... kyros-keeper --rpc https://soroban-testnet.stellar.org \
 *     --network testnet --watch <inbox>:<token>[:<min>] [--watch ...] [--vault <vault> ...] [--interval 5000]
 *
 * An inbox is swept when it holds at least <min> (in whole token units,
 * default: anything), every --interval milliseconds: thousands of small
 * payments (x402 micropayments, for example) become one split.
 * With --vault it also runs that vault's scheduled tax payments and ready
 * corrections on their date.
 *
 * Finish a payment made from another chain (if the payer's page closed
 * before Circle's attestation arrived):
 *
 *   KEEPER_SECRET=S... kyros-keeper --network testnet --relay-cctp <receiver> \
 *     --source-domain 6 --tx 0x<burn transaction hash>
 *
 * Guard vaults: flag every pending change (a new tax destination, a rule
 * that stops setting tax aside, a yield adapter or swapper, a correction, the
 * inbox moving to another vault) while it waits out the vault's notice, and
 * send it to the owner's Telegram bot or a webhook (needs no secret):
 *
 *   TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=... kyros-keeper --network testnet \
 *     --guard <vault>[:<inbox>] [--notify-webhook <url>] [--app <url>] [--interval 60000]
 *
 * The secret only pays network fees; it never controls user funds.
 */
import { Keypair, Networks } from '@stellar/stellar-sdk';
import { KyrosClient } from './client.js';
import { Keeper } from './keeper.js';
import { parseAmount } from './split.js';
import { fetchAttestation, mintAndPayOp } from './cctp.js';
import { inboxMoves, vaultEvents } from './events.js';
import { guardAlerts, guardMessage, notifyTelegram, notifyWebhook } from './agents/watchdog.js';

const args = process.argv.slice(2);
const all = (n: string) => args.flatMap((a, i) => (a === `--${n}` ? [args[i + 1]] : []));
const one = (n: string, d?: string) => all(n)[0] ?? d;

const guards = all('guard').map((g) => {
  const [vault, inbox] = g.split(':');
  return { vault, inbox };
});
const secret = process.env.KEEPER_SECRET;
// Guarding only reads: it needs no secret.
const guardOnly = !secret && guards.length > 0 && all('watch').length === 0 && all('vault').length === 0 && !one('relay-cctp');
if (!secret && !guardOnly) {
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
if (guardOnly) {
  await guardLoop();
  process.exit(0);
}
const relay = one('relay-cctp');
if (relay) {
  const tx = one('tx');
  const domain = Number(one('source-domain'));
  if (!tx || !Number.isInteger(domain)) {
    console.error('--relay-cctp needs --source-domain <n> and --tx <hash>');
    process.exit(2);
  }
  const key = Keypair.fromSecret(secret!);
  const client = new KyrosClient({ rpcUrl, networkPassphrase: passphrase, readAs: key.publicKey() });
  const a = await fetchAttestation(network === 'testnet' ? 'testnet' : 'mainnet', domain, tx, { onWait: (s) => console.log(`waiting for Circle: ${s}`) });
  const r = await client.send(key, mintAndPayOp(relay, a));
  console.log(`paid into the vault: tx ${r.hash}`);
  process.exit(0);
}
const watched = all('watch').map((w) => {
  const [inbox, token, min] = w.split(':');
  if (!inbox || !token) throw new Error(`--watch takes <inbox>:<token>[:<min>], got ${w}`);
  return min ? { inbox, token, min: parseAmount(min) } : { inbox, token };
});
const vaults = all('vault');
if (watched.length === 0 && vaults.length === 0) {
  console.error('nothing to watch: add --watch <inbox>:<token> or --vault <vault>');
  process.exit(2);
}
const key = Keypair.fromSecret(secret!);
const client = new KyrosClient({ rpcUrl, networkPassphrase: passphrase, readAs: key.publicKey() });
const keeper = new Keeper(client, key, watched, (r) =>
  console.log(new Date().toISOString(), r.error ? `error ${r.inbox}: ${r.error}` : `swept ${r.gross} from ${r.inbox} tx ${r.hash}`),
  vaults,
  (r) => console.log(new Date().toISOString(), r.error ? `error ${r.vault} #${r.id}: ${r.error}` : `paid scheduled #${r.id} of ${r.vault} tx ${r.hash}`),
);
if (guards.length) void guardLoop();
process.on('SIGINT', () => keeper.stop());
process.on('SIGTERM', () => keeper.stop());
console.log(`kyros-keeper watching ${watched.length} inbox(es) and ${vaults.length} vault(s) on ${network}`);
await keeper.run(Number(one('interval', '5000')));

/** Reads the guarded vaults' events every --interval and sends each new pending change once. */
async function guardLoop(): Promise<void> {
  const reader = new KyrosClient({ rpcUrl: rpcUrl!, networkPassphrase: passphrase });
  const tg = process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID ? { token: process.env.TELEGRAM_BOT_TOKEN, chat: process.env.TELEGRAM_CHAT_ID } : undefined;
  const hook = one('notify-webhook');
  const app = one('app');
  const sent = new Set<string>();
  const known = new Map<string, Set<string>>();
  const interval = Number(one('interval', '60000'));
  console.log(`kyros-keeper guarding ${guards.length} vault(s)${tg ? ', alerts to Telegram' : ''}${hook ? ', alerts to the webhook' : ''}`);
  for (;;) {
    try {
      const latest = await reader.server.getLatestLedger();
      const since = Math.max(latest.sequence - 17_000, 1);
      const now = BigInt(Math.floor(Date.now() / 1000));
      for (const g of guards) {
        if (!known.has(g.vault)) {
          const cfg = await reader.config(g.vault).catch(() => null);
          known.set(g.vault, new Set(cfg ? [cfg.taxDestination] : []));
        }
        const [rows, moves] = await Promise.all([vaultEvents(reader.server, g.vault, since), g.inbox ? inboxMoves(reader.server, g.inbox, since) : Promise.resolve([])]);
        for (const a of guardAlerts(rows, moves, { now, known: known.get(g.vault) })) {
          if (sent.has(a.tx)) continue;
          sent.add(a.tx);
          const text = guardMessage(a, g.vault, app);
          console.log(new Date().toISOString(), `${a.severity.toUpperCase()} ${text}`);
          if (tg) await notifyTelegram(tg.token, tg.chat, text).catch((e) => console.error('telegram', (e as Error).message));
          if (hook) await notifyWebhook(hook, { vault: g.vault, ...a, text }).catch((e) => console.error('webhook', (e as Error).message));
        }
      }
    } catch (e) {
      console.error('guard', (e as Error).message);
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}
