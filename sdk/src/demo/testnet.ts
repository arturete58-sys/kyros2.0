/**
 * Kyros end to end on Stellar testnet, with real transactions:
 *
 *  1. fresh accounts (friendbot) and a test stablecoin (KUSD, 7 decimals) with its Stellar Asset Contract;
 *  2. upload and deploy the Router, a Reserve Vault (Spain rule pack, `general` preset) and the user's Inbox;
 *  3. a client pays a 1,210 KUSD invoice through the Router: 800 to the freelancer, 410 reserved;
 *  4. a client sends 121 KUSD to the inbox with a plain SEP-41 transfer; the keeper sweeps it;
 *  5. the freelancer pays the VAT bucket to the tax destination before the due date;
 *  6. an early release is refused (NotDue), and a new destination cannot apply before its notice;
 *  7. after the due date the rest of the period is released to the freelancer;
 *  8. the vault's events are read back and exported as CSV.
 *
 * For the demo the vault uses 3-minute periods and a 2-minute notice, so the
 * whole cycle fits in one run; real vaults use the rule pack's quarters.
 *
 *   node dist/demo/testnet.js --wasm-dir ../contracts/target/wasm32v1-none/release --out ../docs/testnet
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Asset, BASE_FEE, Keypair, Networks, Operation, TransactionBuilder, xdr } from '@stellar/stellar-sdk';
import { invoiceReference, KyrosClient, KyrosError } from '../client.js';
import { vaultEvents, toCsv } from '../events.js';
import { Keeper } from '../keeper.js';
import { periodLabel } from '../periods.js';
import { loadRulePack, termsFromPack } from '../rulepacks.js';
import { formatAmount, parseAmount } from '../split.js';

const args = process.argv.slice(2);
const flag = (n: string, d?: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : d;
};
const RPC = process.env.STELLAR_RPC_URL ?? 'https://soroban-testnet.stellar.org';
const PASS = Networks.TESTNET;
const txUrl = (h: string) => `https://stellar.expert/explorer/testnet/tx/${h}`;
const contractUrl = (c: string) => `https://stellar.expert/explorer/testnet/contract/${c}`;
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Step {
  step: string;
  ok: boolean;
  tx?: string;
  detail: string;
}

async function fund(pub: string): Promise<void> {
  for (let i = 0; i < 5; i++) {
    const r = await fetch(`https://friendbot.stellar.org?addr=${pub}`);
    if (r.ok) return;
    await sleep(3000);
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

/** Runs `f` expecting the contract to refuse; returns the refusal text. */
async function expectRefusal(f: () => Promise<unknown>, contains: string): Promise<string> {
  try {
    await f();
  } catch (e) {
    const m = (e as Error).message;
    const code = /Error\(Contract, #(\d+)\)/.exec(m);
    if (e instanceof KyrosError && code) return `${contains} (contract error #${code[1]})`;
    throw e;
  }
  throw new Error(`expected a refusal (${contains}) but the call succeeded`);
}

async function main(): Promise<void> {
  const wasmDir = flag('wasm-dir', '../contracts/target/wasm32v1-none/release')!;
  const outDir = flag('out', '../docs/testnet')!;
  const wasm = (n: string) => readFileSync(join(wasmDir, `${n}.wasm`));
  const started = new Date().toISOString();
  const steps: Step[] = [];
  const k = { issuer: Keypair.random(), freelancer: Keypair.random(), client: Keypair.random(), taxAccount: Keypair.random(), keeper: Keypair.random(), newDestination: Keypair.random() };
  const c = new KyrosClient({ rpcUrl: RPC, networkPassphrase: PASS, readAs: k.keeper.publicKey() });

  log('funding accounts');
  for (const kp of Object.values(k)) await fund(kp.publicKey());

  log('issuing KUSD and deploying its Stellar Asset Contract');
  const asset = new Asset('KUSD', k.issuer.publicKey());
  for (const kp of [k.freelancer, k.client, k.taxAccount, k.newDestination]) await classic(c, kp, [Operation.changeTrust({ asset })]);
  await classic(c, k.issuer, [Operation.payment({ destination: k.client.publicKey(), asset, amount: '10000' })]);
  await c.send(k.issuer, Operation.createStellarAssetContract({ asset }));
  const token = asset.contractId(PASS);

  log('uploading and deploying the Kyros contracts');
  const routerHash = await c.upload(k.keeper, wasm('kyros_router'));
  const vaultHash = await c.upload(k.keeper, wasm('kyros_reserve_vault'));
  const inboxHash = await c.upload(k.keeper, wasm('kyros_inbox'));
  const router = await c.deployRouter(k.keeper, routerHash);
  const terms = termsFromPack(loadRulePack('es'), 'general');
  const period = { kind: 'Seconds' as const, seconds: 180n };
  const vault = await c.deployVault(k.keeper, vaultHash, {
    owner: k.freelancer.publicKey(),
    rule: terms.rule,
    taxDestination: k.taxAccount.publicKey(),
    noticeSecs: 120n,
    period,
    dueOffsetSecs: 0n,
    tokens: [token],
  });
  const inbox = await c.deployInbox(k.keeper, inboxHash, vault.contractId);
  steps.push({ step: 'Deploy Reserve Vault (Spain pack, general: VAT 21% + income tax 20%)', ok: true, tx: vault.hash, detail: vault.contractId });
  steps.push({ step: 'Deploy Inbox for the vault', ok: true, tx: inbox.hash, detail: inbox.contractId });
  steps.push({ step: 'Deploy Router', ok: true, tx: router.hash, detail: router.contractId });

  log('invoice paid through the Router');
  const gross = parseAmount('1210');
  const quote = await c.quote(vault.contractId, gross);
  const paid = await c.send(k.client, c.payOp(router.contractId, { from: k.client.publicKey(), vault: vault.contractId, token, amount: gross, reference: invoiceReference('INV-2027-001') }));
  const afterPay = { freelancer: await c.balance(token, k.freelancer.publicKey()), vault: await c.balance(token, vault.contractId) };
  steps.push({
    step: 'Client pays invoice INV-2027-001 (1,210 KUSD) through the Router',
    ok: afterPay.freelancer === quote.net && afterPay.vault === quote.reserve,
    tx: paid.hash,
    detail: `freelancer +${formatAmount(afterPay.freelancer)}, vault +${formatAmount(afterPay.vault)} (VAT ${formatAmount(quote.vat)}, income tax ${formatAmount(quote.parts[0])})`,
  });

  log('plain transfer into the inbox, swept by the keeper');
  const t = await c.send(k.client, c.transferOp(token, k.client.publicKey(), inbox.contractId, parseAmount('121')));
  steps.push({ step: 'Client sends 121 KUSD to the inbox with a plain SEP-41 transfer', ok: true, tx: t.hash, detail: inbox.contractId });
  const keeper = new Keeper(c, k.keeper, [{ inbox: inbox.contractId, token }]);
  const [swept] = await keeper.tick();
  const afterSweep = { freelancer: await c.balance(token, k.freelancer.publicKey()), vault: await c.balance(token, vault.contractId), inbox: await c.balance(token, inbox.contractId) };
  steps.push({
    step: 'Keeper sweeps the inbox (permissionless)',
    ok: !swept?.error && afterSweep.inbox === 0n && afterSweep.freelancer - afterPay.freelancer === parseAmount('80'),
    tx: swept?.hash,
    detail: swept?.error ?? `freelancer +${formatAmount(afterSweep.freelancer - afterPay.freelancer)}, vault +${formatAmount(afterSweep.vault - afterPay.vault)}`,
  });

  const pid = await c.currentPeriod(vault.contractId);
  const state = await c.period(vault.contractId, pid, token);
  log('period', periodLabel(period, pid), state);

  log('paying the VAT bucket to the tax destination');
  const vat = state.buckets.vat ?? 0n;
  const tax = await c.send(k.freelancer, c.payTaxOp(vault.contractId, { period: pid, token, bucket: 'vat', amount: vat }));
  steps.push({ step: 'Freelancer pays the VAT bucket to the tax destination (before the due date)', ok: (await c.balance(token, k.taxAccount.publicKey())) === vat, tx: tax.hash, detail: `${formatAmount(vat)} KUSD to the tax account` });

  log('early release must be refused');
  const early = await expectRefusal(() => c.send(k.freelancer, c.releaseOp(vault.contractId, pid, token)), 'NotDue');
  steps.push({ step: 'Release before the due date is refused', ok: true, detail: `refused by the contract: ${early}` });

  log('new destination: proposed, cannot apply before its notice');
  const proposed = await c.send(k.freelancer, c.proposeDestinationOp(vault.contractId, k.newDestination.publicKey()));
  steps.push({ step: 'Freelancer proposes a new tax destination (2-minute notice in this demo)', ok: true, tx: proposed.hash, detail: k.newDestination.publicKey() });
  const notYet = await expectRefusal(() => c.send(k.keeper, c.applyPendingOp(vault.contractId)), 'ChangeNotReady');
  steps.push({ step: 'Applying it before the notice has passed is refused', ok: true, detail: `refused by the contract: ${notYet}` });

  const due = await c.dueDate(vault.contractId, pid);
  const waitMs = Number(due) * 1000 - Date.now() + 15_000;
  log(`waiting ${Math.ceil(waitMs / 1000)} s for the due date`);
  if (waitMs > 0) await sleep(waitMs);

  log('release after the due date');
  const before = await c.balance(token, k.freelancer.publicKey());
  const rel = await c.send(k.freelancer, c.releaseOp(vault.contractId, pid, token));
  const back = (await c.balance(token, k.freelancer.publicKey())) - before;
  steps.push({ step: 'After the due date the rest of the period is released to the freelancer', ok: back === state.buckets.irpf, tx: rel.hash, detail: `${formatAmount(back)} KUSD back to the freelancer` });

  log('reading events');
  const startLedger = (await c.server.getLatestLedger()).sequence - 400;
  const events = await vaultEvents(c.server, vault.contractId, Math.max(startLedger, 1));
  const csv = toCsv(events, txUrl);
  steps.push({ step: 'Vault history read back from contract events and exported as CSV', ok: events.some((e) => e.kind === 'received'), detail: `${events.length} events` });

  const result = {
    network: 'testnet',
    startedAt: started,
    finishedAt: new Date().toISOString(),
    token,
    contracts: { router: router.contractId, vault: vault.contractId, inbox: inbox.contractId },
    accounts: Object.fromEntries(Object.entries(k).map(([n, kp]) => [n, kp.publicKey()])),
    steps,
    allOk: steps.every((s) => s.ok),
  };
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'latest.json'), JSON.stringify(result, null, 2) + '\n');
  writeFileSync(join(outDir, 'latest.csv'), csv);
  writeFileSync(join(outDir, 'README.md'), report(result));
  log(result.allOk ? 'all steps passed' : 'some steps failed');
  if (!result.allOk) process.exitCode = 1;
}

function report(r: { startedAt: string; finishedAt: string; token: string; contracts: Record<string, string>; steps: Step[]; allOk: boolean }): string {
  const rows = r.steps.map((s) => `| ${s.ok ? 'yes' : '**no**'} | ${s.step} | ${s.detail.replace(/\|/g, '/')} | ${s.tx ? `[tx](${txUrl(s.tx)})` : ''} |`);
  return [
    '# Kyros on Stellar testnet: latest run',
    '',
    `Run from ${r.startedAt} to ${r.finishedAt}. Result: **${r.allOk ? 'all steps passed' : 'some steps failed'}**.`,
    '',
    'Generated by `sdk/src/demo/testnet.ts` in the public workflow `.github/workflows/testnet-demo.yml`. Every transaction below is real and can be opened on the explorer.',
    '',
    '| Contract | ID |',
    '| --- | --- |',
    `| Reserve Vault | [${r.contracts.vault}](${contractUrl(r.contracts.vault)}) |`,
    `| Inbox | [${r.contracts.inbox}](${contractUrl(r.contracts.inbox)}) |`,
    `| Router | [${r.contracts.router}](${contractUrl(r.contracts.router)}) |`,
    `| KUSD test token | [${r.token}](${contractUrl(r.token)}) |`,
    '',
    '| OK | Step | Detail | Transaction |',
    '| --- | --- | --- | --- |',
    ...rows,
    '',
    'The vault history of this run is in [latest.csv](latest.csv): one line per event, as an accountant would import it.',
    '',
  ].join('\n');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
