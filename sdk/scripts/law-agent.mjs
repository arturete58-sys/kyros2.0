// The law agent: turns the law watch's findings into a reviewable change, and
// prepares what the Rate Registry's publisher signs. It never merges and never
// signs: a person reviews the pull request, and the publisher signs the
// prepared transactions with their own key, offline.
//
//   Pack edits from the official VAT findings (check-vat-official.mjs --json):
//     node scripts/law-agent.mjs --findings tedb.json [--apply] [--out pr.md]
//
//   Registry transactions for the merged packs and holidays:
//     STELLAR_RPC_URL=... node scripts/law-agent.mjs --registry C... --publisher G... \
//       [--mainnet] [--packs es,de] [--years 2026,2027] --out registry-txs.json
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Networks } from '@stellar/stellar-sdk';
import { KyrosClient, listRulePacks, loadHolidays, loadRulePack, prepareRegistrySteps, registryLawPlan, vatEdits } from '../dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const packDir = join(here, '..', '..', 'rule-packs');
const args = process.argv.slice(2);
const opt = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const today = new Date().toISOString().slice(0, 10);

const findingsFile = opt('--findings');
const registry = opt('--registry');
const out = opt('--out');

if (findingsFile) {
  const findings = existsSync(findingsFile) ? JSON.parse(readFileSync(findingsFile, 'utf8')) : [];
  const packs = listRulePacks().map((id) => loadRulePack(id));
  const { edits, left } = vatEdits(packs, findings, today);
  const lines = [`# Law agent: rule pack changes, ${today}`, ''];
  if (edits.length) {
    lines.push('The European Commission\'s official database (TEDB) lists a different standard VAT rate in force today. Each change below adds a VAT table from today; before merging, check the date the change really applied from and the reduced rates, and link the official text in the pack\'s sources.', '');
    for (const e of edits) lines.push(`- ${e.summary}`);
  } else lines.push('No pack edits: nothing in the findings has an unambiguous fix.');
  if (left.length) {
    lines.push('', '## For a person to review', '');
    for (const f of left) lines.push(`- \`${f.pack}\` ${f.rate}: pack ${f.packBps !== undefined ? f.packBps / 100 + '%' : '—'}, ${f.source} ${f.officialBps.map((x) => x / 100 + '%').join(', ')}`);
  }
  lines.push('', 'Holiday files, when they changed, were regenerated from the newest `holidays` release. After merging, publish to the registry: `node sdk/scripts/law-agent.mjs --registry <id> --publisher <account> --out registry-txs.json`, then sign each transaction with the publisher\'s key.');
  if (args.includes('--apply')) {
    for (const e of edits) writeFileSync(join(packDir, `${e.pack}.json`), JSON.stringify(e.after, null, 2) + '\n');
  }
  const body = lines.join('\n') + '\n';
  console.log(body);
  if (out) writeFileSync(out, body);
} else if (registry) {
  const publisher = opt('--publisher');
  if (!publisher) throw new Error('--publisher G... (the registry admin account) is required');
  const mainnet = args.includes('--mainnet');
  const rpcUrl = process.env.STELLAR_RPC_URL ?? (mainnet ? undefined : 'https://soroban-testnet.stellar.org');
  if (!rpcUrl) throw new Error('STELLAR_RPC_URL is required on mainnet');
  const c = new KyrosClient({ rpcUrl, networkPassphrase: mainnet ? Networks.PUBLIC : Networks.TESTNET, readAs: publisher });
  const ids = opt('--packs')?.split(',') ?? listRulePacks();
  const years = opt('--years')?.split(',').map(Number);
  const plan = await registryLawPlan(c, registry, ids.map((id) => ({ pack: loadRulePack(id), holidays: loadHolidays(id) })), undefined, years);
  for (const s of plan.steps) console.log(`SIGN   ${s.what}`);
  for (const l of plan.late) console.log(`LATE   ${l.rate} ${l.bps / 100}% from ${l.day}: inside the registry's notice; vault owners apply it with propose_rule_at`);
  for (const k of plan.kept) console.log(`KEPT   ${k.country} ${k.year}: ${k.days.length} day(s) no longer in the data stay (the year has started)`);
  const prepared = plan.steps.length ? await prepareRegistrySteps(c, publisher, plan.steps) : [];
  if (out) writeFileSync(out, JSON.stringify({ network: mainnet ? 'mainnet' : 'testnet', registry, publisher, prepared }, null, 2) + '\n');
  console.log(`${prepared.length} transaction(s) prepared for ${publisher}${out ? ` in ${out}` : ''}; nothing was signed or sent.`);
  if (plan.late.length) process.exitCode = 1;
} else {
  console.error('usage: law-agent.mjs --findings tedb.json [--apply] [--out pr.md] | --registry C... --publisher G... [--out registry-txs.json]');
  process.exitCode = 2;
}
