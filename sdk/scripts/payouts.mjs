// The payout agent from the command line, for a company, a DAO or a grants
// programme paying many Kyros vaults at once. It reads the list, checks every
// line, asks each vault (by simulation) whether it takes the token and what it
// sets aside, and prepares one `pay_many` transaction per run of payments for
// the payer to sign. Nothing is signed or sent.
//
//   STELLAR_RPC_URL=... node scripts/payouts.mjs --csv payroll.csv --router C... \
//     --from G... --token C... [--mainnet] [--out payouts-txs.json]
import { readFileSync, writeFileSync } from 'node:fs';
import { Networks } from '@stellar/stellar-sdk';
import { KyrosClient, checkPayouts, formatAmount, parsePayouts, payoutsOf, prepareSequence, verifyPayoutVaults } from '../dist/index.js';

const args = process.argv.slice(2);
const opt = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const [csv, router, from, token] = ['--csv', '--router', '--from', '--token'].map(opt);
if (!csv || !router || !from || !token) {
  console.error('usage: payouts.mjs --csv file --router C... --from G... --token C... [--mainnet] [--out file]');
  process.exit(2);
}
const mainnet = args.includes('--mainnet');
const rpcUrl = process.env.STELLAR_RPC_URL ?? (mainnet ? undefined : 'https://soroban-testnet.stellar.org');
if (!rpcUrl) throw new Error('STELLAR_RPC_URL is required on mainnet');
const c = new KyrosClient({ rpcUrl, networkPassphrase: mainnet ? Networks.PUBLIC : Networks.TESTNET, readAs: from });

const check = checkPayouts(parsePayouts(readFileSync(csv, 'utf8')));
const { problems, quotes } = await verifyPayoutVaults(c, check, token);
const all = [...check.problems, ...problems].sort((a, b) => a.line - b.line);
for (const p of all) console.log(`LINE ${p.line}: ${p.problem}${p.detail ? ` (${p.detail})` : ''}`);
if (all.length) {
  console.log(`${all.length} line(s) to fix before paying; nothing prepared.`);
  process.exit(1);
}
for (const run of check.runs)
  for (const l of run) {
    const q = quotes.get(l.line);
    console.log(`OK   line ${l.line}: ${formatAmount(l.amount)} to ${l.vault.slice(0, 6)}…${q ? ` (sets aside ${formatAmount(q.reserve)}, ${formatAmount(q.net)} to the person)` : ''}`);
  }
const prepared = await prepareSequence(
  c,
  from,
  check.runs.map((run, i) => ({ what: `run ${i + 1}: ${run.length} payments`, op: c.payManyOp(router, { from, token, payouts: payoutsOf(run) }) })),
);
const out = opt('--out');
if (out) writeFileSync(out, JSON.stringify({ network: mainnet ? 'mainnet' : 'testnet', from, token, total: formatAmount(check.total), prepared }, null, 2) + '\n');
console.log(`${check.runs.flat().length} payments, ${formatAmount(check.total)} in total, in ${prepared.length} transaction(s) for ${from} to sign${out ? ` (${out})` : ''}.`);
