// Public testnet counter for kyrosfinance.com: how many vaults people have
// opened with the Kyros app and how many payments those vaults have split.
//
// It reads the vaults' own events from Stellar RPC, so anyone can check the
// figures on chain. A vault is counted only when:
//   - its code is the app's vault (same wasm hash as app/public/testnet.json),
//   - it pays the app's testnet tax account (the daily demo uses its own), and
//   - its notice is the app's (end-to-end tests add one second to theirs).
// Counting starts the first time this script runs on a deployment, so test
// vaults from before the counter existed are left out. A testnet reset (a new
// deployment) starts the count again.
//
//   node scripts/site-stats.mjs --config ../app/public/testnet.json --state ../site/stats.json
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { Networks, rpc, scValToNative, xdr } from '@stellar/stellar-sdk';
import { KyrosClient } from '../dist/index.js';

const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const cfg = JSON.parse(readFileSync(opt('--config', '../app/public/testnet.json'), 'utf8'));
const stateFile = opt('--state', '../site/stats.json');
const rpcUrl = process.env.STELLAR_RPC_URL ?? cfg.rpcUrl;
const server = new rpc.Server(rpcUrl);
const client = new KyrosClient({ rpcUrl, networkPassphrase: Networks.TESTNET });

const latest = (await server.getLatestLedger()).sequence;
const health = await server.getHealth();
const oldest = (health.oldestLedger ?? latest - 100_000) + 10;

let s = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : null;
if (!s || s.deployedAt !== cfg.deployedAt) {
  s = { network: 'testnet', deployedAt: cfg.deployedAt, since: new Date().toISOString(), sinceLedger: latest, nextLedger: latest, vaults: 0, payments: 0, taxesPaid: 0, counted: [], excluded: [] };
}
// RPC keeps about a week of events: if the counter stopped for longer, what fell out is lost.
const start = Math.max(s.nextLedger, oldest);

const sym = (x) => xdr.ScVal.scvSymbol(x).toXDR('base64');
const kinds = { received: 2, tax_paid: 2, deposited: 2, rule_proposed: 0, payout_proposed: 0 };
const topics = Object.entries(kinds).map(([k, n]) => [sym('kyros_vault'), sym(k), ...Array(n).fill('*')]);
const filters = [{ type: 'contract', topics }];

const events = [];
let cursor;
let reachedEnd = false;
for (let page = 0; page < 200; page++) {
  const req = cursor ? { filters, cursor, limit: 200 } : { filters, startLedger: start, limit: 200 };
  const res = await server.getEvents(req);
  for (const ev of res.events) {
    const t = ev.topic.map((x) => scValToNative(x));
    if (t[0] === 'kyros_vault' && t[1] in kinds) events.push({ vault: String(ev.contractId), kind: String(t[1]) });
  }
  cursor = res.cursor;
  if (res.events.length < 200) {
    reachedEnd = true;
    break;
  }
}
if (!reachedEnd) throw new Error('too many events for one run; run the counter more often');

const counted = new Set(s.counted);
const excluded = new Set(s.excluded);
const wasm = String(cfg.wasm.vault).toLowerCase();

async function isAppVault(id) {
  try {
    const inst = await server.getContractData(id, xdr.ScVal.scvLedgerKeyContractInstance());
    const hash = inst.val.contractData().val().instance().executable().wasmHash().toString('hex');
    if (hash !== wasm) return false;
    const c = await client.config(id);
    return c.taxDestination === cfg.taxAccount && c.noticeSecs === BigInt(cfg.noticeSecs);
  } catch {
    return false;
  }
}

for (const id of new Set(events.map((e) => e.vault))) {
  if (counted.has(id) || excluded.has(id)) continue;
  (await isAppVault(id)) ? counted.add(id) : excluded.add(id);
}

for (const e of events) {
  if (!counted.has(e.vault)) continue;
  if (e.kind === 'received') s.payments++;
  if (e.kind === 'tax_paid') s.taxesPaid++;
}
s.counted = [...counted].sort();
s.excluded = [...excluded].sort();
s.vaults = s.counted.length;
s.nextLedger = latest + 1;
s.updatedAt = new Date().toISOString();
writeFileSync(stateFile, JSON.stringify(s, null, 2) + '\n');
console.log(`vaults ${s.vaults} · payments split ${s.payments} · taxes paid ${s.taxesPaid} · excluded ${s.excluded.length} · ledgers ${start}-${latest}`);
