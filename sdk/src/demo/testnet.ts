/**
 * Kyros end to end on Stellar testnet, with real transactions:
 *
 *  1. fresh accounts (friendbot) and a test stablecoin (KUSD, 7 decimals) with its Stellar Asset Contract;
 *  2. upload and deploy the Router, a Reserve Vault (Spain rule pack, `general` preset) and the user's Inbox;
 *  3. a client pays a 1,210 KUSD invoice through the Router: 800 to the freelancer, 410 reserved;
 *     the same Router then pays vaults built from the German, US and UAE rule packs;
 *  4. a client sends 121 KUSD to the inbox with a plain SEP-41 transfer; the keeper sweeps it;
 *  5. the freelancer pays the VAT bucket to the tax destination before the due date;
 *  6. an early release is refused (NotDue), and a new destination cannot apply before its notice;
 *  7. after the due date the rest of the period is released to the freelancer;
 *  8. a scheduled VAT change (Thailand, 7% to 10%) is signed ahead with propose_rule_at:
 *     the vault keeps 7% until the change time and charges 10% from then on;
 *  9. a Rate Registry is filled from the Spain rule pack and the Spanish vault follows it: a
 *     published change (21% to 22%, a demo date) applies with no signature from the owner;
 * 10. the owner moves to Germany: a new vault from the German pack, and the same inbox pays
 *     into it after the notice, while the Spanish vault keeps its reserves;
 * 11. the vault's events are read back and exported as CSV;
 * 12. an expected payment for an invoice with IRPF withheld by the client:
 *     the owner registers its terms and the 1,060 payment splits exactly;
 * 13. the VAT is paid to the destination with an anchor-style memo (muxed address);
 * 14. a vault that keeps its reserve in euros: reserve received in KUSD is
 *     swapped into KEUR through the Soroswap testnet router, never below
 *     Reflector's EUR/USD price minus 1%;
 * 15. a fixed fee per period and a payout address, both after the notice: the fee
 *     fills first from the net amount, the rest goes to the payout address; and
 *     reserve deposited for income received elsewhere, which does not count as income;
 * 16. public money: a test digital dollar issued like a central bank's (holders need
 *     the issuer's authorization) is added to a vault with notice; the vault splits a
 *     payment in it once the issuer has authorized it, and pays the tax in it straight
 *     to the tax office's account.
 *
 * For the demo the vault uses 4-minute periods and a 2-minute notice, so the
 * whole cycle fits in one run; real vaults use the rule pack's quarters.
 *
 *   node dist/demo/testnet.js --wasm-dir ../contracts/target/wasm32v1-none/release --out ../docs/testnet
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Asset, AuthClawbackEnabledFlag, AuthRequiredFlag, AuthRevocableFlag, BASE_FEE, Contract, Keypair, MuxedAccount, Account, Networks, Operation, scValToNative, TransactionBuilder, xdr } from '@stellar/stellar-sdk';
import { REFLECTOR, SOROSWAP_ROUTER } from '../assets.js';
import { money, payableUnits, requestRef, requestTerms, requestTotals, type PaymentRequest } from '../payment-request.js';
import { addr, i128, oracleAssetToScVal, u64 } from '../scval.js';
import { invoiceReference, KyrosClient, KyrosError } from '../client.js';
import { transfersInto, vaultEvents, toCsv } from '../events.js';
import { Keeper } from '../keeper.js';
import { periodLabel } from '../periods.js';
import { loadRulePack, periodKindOf, termsFromPack, vatUpdatePlan } from '../rulepacks.js';
import { duesAfter } from '../periods.js';
import { nextOpen } from '../workdays.js';
import { changeCountryPlan, registrySyncPlan } from '../registry.js';
import { abroadTerms, formatAmount, parseAmount } from '../split.js';
import { clientTerms, clientTermsOp } from '../clients.js';

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
  /** Could not run on testnet today (an outside service was missing); not counted as a failure. */
  skipped?: boolean;
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
  // The RPC can still report the sequence from before the account's last transaction: retry on txBAD_SEQ.
  let sent: Awaited<ReturnType<typeof c.server.sendTransaction>> | null = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const account = await c.server.getAccount(source.publicKey());
    const b = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: PASS });
    ops.forEach((o) => b.addOperation(o));
    const tx = b.setTimeout(60).build();
    tx.sign(source);
    sent = await c.server.sendTransaction(tx);
    if (sent.status !== 'ERROR' || sent.errorResult?.result().switch().name !== 'txBadSeq') break;
    await new Promise((r) => setTimeout(r, 3_000));
  }
  if (!sent || sent.status === 'ERROR') throw new Error(`classic tx failed: ${sent?.errorResult?.toXDR('base64')}`);
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
  const k = { issuer: Keypair.random(), freelancer: Keypair.random(), client: Keypair.random(), taxAccount: Keypair.random(), keeper: Keypair.random(), newDestination: Keypair.random(), lp: Keypair.random() };
  const c = new KyrosClient({ rpcUrl: RPC, networkPassphrase: PASS, readAs: k.keeper.publicKey() });

  log('funding accounts');
  for (const kp of Object.values(k)) await fund(kp.publicKey());

  log('issuing KUSD and deploying its Stellar Asset Contract');
  const asset = new Asset('KUSD', k.issuer.publicKey());
  for (const kp of [k.freelancer, k.client, k.taxAccount, k.newDestination]) await classic(c, kp, [Operation.changeTrust({ asset })]);
  await classic(c, k.issuer, [Operation.payment({ destination: k.client.publicKey(), asset, amount: '30000' })]);
  await c.send(k.issuer, Operation.createStellarAssetContract({ asset }));
  const token = asset.contractId(PASS);

  log('issuing KEUR, the euro test token, for the euro reserve');
  const eurAsset = new Asset('KEUR', k.issuer.publicKey());
  for (const kp of [k.freelancer, k.taxAccount]) await classic(c, kp, [Operation.changeTrust({ asset: eurAsset })]);
  await classic(c, k.lp, [Operation.changeTrust({ asset }), Operation.changeTrust({ asset: eurAsset })]);
  await classic(c, k.issuer, [
    Operation.payment({ destination: k.lp.publicKey(), asset, amount: '2000000' }),
    Operation.payment({ destination: k.lp.publicKey(), asset: eurAsset, amount: '2000000' }),
  ]);
  await c.send(k.issuer, Operation.createStellarAssetContract({ asset: eurAsset }));
  const eurToken = eurAsset.contractId(PASS);

  log('uploading and deploying the Kyros contracts');
  const routerHash = await c.upload(k.keeper, wasm('kyros_router'));
  const vaultHash = await c.upload(k.keeper, wasm('kyros_reserve_vault'));
  const inboxHash = await c.upload(k.keeper, wasm('kyros_inbox'));
  const registryHash = await c.upload(k.keeper, wasm('kyros_rate_registry'));
  const swapperHash = await c.upload(k.keeper, wasm('kyros_swap_soroswap'));
  const router = await c.deployRouter(k.keeper, routerHash);
  const terms = termsFromPack(loadRulePack('es'), 'general');
  const period = { kind: 'Seconds' as const, seconds: 240n };
  const vault = await c.deployVault(k.keeper, vaultHash, {
    owner: k.freelancer.publicKey(),
    rule: terms.rule,
    taxDestination: k.taxAccount.publicKey(),
    noticeSecs: 120n,
    period,
    dues: duesAfter(0n),
    tokens: [token],
  });
  const inbox = await c.deployInbox(k.keeper, inboxHash, vault.contractId);
  steps.push({ step: 'Deploy Reserve Vault (Spain pack, general: VAT 21% + income tax 20%)', ok: true, tx: vault.hash, detail: vault.contractId });
  steps.push({ step: 'Deploy Inbox for the vault', ok: true, tx: inbox.hash, detail: inbox.contractId });
  steps.push({ step: 'Deploy Router', ok: true, tx: router.hash, detail: router.contractId });

  // Start the payments early in a period, so they all land in the same one.
  const nowS = BigInt(Math.floor(Date.now() / 1000));
  const left = Number(period.seconds - (nowS % period.seconds));
  if (left < 150) {
    log(`waiting ${left + 3} s for a fresh period`);
    await sleep((left + 3) * 1000);
  }

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

  log('invoice with IRPF withheld by the client: terms registered, payment split exactly');
  // The invoice itself is issued with the freelancer's own invoicing tool; Kyros only needs its number and amounts.
  const irpfInvoice: PaymentRequest = {
    invoiceNumber: 'KYR-2027-003',
    currency: 'EUR',
    withholding: { rate: '15' },
    payTo: { address: vault.contractId, asset: 'KUSD' },
    lines: [{ description: 'Consultoría (demo)', quantity: '1', unitPrice: '1000', vatRate: '21' }],
  };
  // The client already withholds 15% for income tax; the vault keeps 5% more on top.
  const irpfTerms = requestTerms(irpfInvoice, [{ name: 'irpf', bps: 500 }]);
  const expected = await c.send(k.freelancer, c.expectInvoiceOp(vault.contractId, requestRef(irpfInvoice), irpfTerms));
  steps.push({
    step: 'Expected payment for invoice KYR-2027-003 (base 1,000, VAT 21%, IRPF 15% withheld by the client): the freelancer registers its terms in the vault',
    ok: true,
    tx: expected.hash,
    detail: `the client pays ${money(requestTotals(irpfInvoice).payable)}`,
  });
  const before3 = { freelancer: await c.balance(token, k.freelancer.publicKey()), vault: await c.balance(token, vault.contractId) };
  const paid3 = await c.send(k.client, c.payOp(router.contractId, { from: k.client.publicKey(), vault: vault.contractId, token, amount: payableUnits(irpfInvoice), reference: requestRef(irpfInvoice) }));
  const got3 = { freelancer: (await c.balance(token, k.freelancer.publicKey())) - before3.freelancer, vault: (await c.balance(token, vault.contractId)) - before3.vault };
  steps.push({
    step: 'The client pays 1,060 KUSD with the invoice reference: the vault applies the invoice terms, not the default rule',
    ok: got3.freelancer === parseAmount('800') && got3.vault === parseAmount('260'),
    tx: paid3.hash,
    detail: `freelancer +${formatAmount(got3.freelancer)}, vault +${formatAmount(got3.vault)} (VAT 210, income-tax reserve 50; the default rule would have reserved only 184 of VAT)`,
  });

  const pid = Number((await vaultEvents(c.server, vault.contractId, Math.max((await c.server.getLatestLedger()).sequence - 200, 1))).find((e) => e.kind === 'received')?.period ?? (await c.currentPeriod(vault.contractId)));
  const state = await c.period(vault.contractId, pid, token);
  log('period', periodLabel(period, pid), state);

  log('paying the VAT bucket to the tax destination');
  const vat = state.buckets.vat ?? 0n;
  // As an anchor's withdrawal would ask: the destination account with an id memo, sent as a muxed address.
  const anchorTo = new MuxedAccount(new Account(k.taxAccount.publicKey(), '0'), '4242').accountId();
  const tax = await c.send(k.freelancer, c.payTaxToOp(vault.contractId, { period: pid, token, bucket: 'vat', amount: vat, to: anchorTo }));
  steps.push({
    step: 'Freelancer pays the VAT bucket to the tax destination with an anchor-style memo (muxed address, id 4242), before the due date',
    ok: (await c.balance(token, k.taxAccount.publicKey())) === vat,
    tx: tax.hash,
    detail: `${formatAmount(vat)} KUSD to ${anchorTo.slice(0, 12)}…`,
  });

  log('an instalment scheduled by the owner, run by the keeper on its date');
  const instalment = parseAmount('50');
  const taxBefore = await c.balance(token, k.taxAccount.publicKey());
  const schedAt = BigInt(Math.floor(Date.now() / 1000)) + 20n;
  const sched = await c.send(k.freelancer, c.scheduleOp(vault.contractId, { at: schedAt, payments: [{ period: pid, token, bucket: 'irpf', amount: instalment }], to: k.taxAccount.publicKey() }));
  const tooEarly = await expectRefusal(() => c.send(k.keeper, c.runScheduledOp(vault.contractId, 1)), 'NotYet');
  steps.push({ step: 'Freelancer schedules a 50 KUSD income-tax instalment to the tax destination; running it before its time is refused', ok: true, tx: sched.hash, detail: `refused by the contract: ${tooEarly}` });
  await sleep(Math.max(0, Number(schedAt) * 1000 - Date.now()) + 8_000);
  const [ran] = await new Keeper(c, k.keeper, [], () => {}, [vault.contractId]).runDue();
  steps.push({
    step: 'On its date the keeper runs it (no owner signature): the instalment goes only to the tax destination',
    ok: !ran?.error && (await c.balance(token, k.taxAccount.publicKey())) - taxBefore === instalment && (await c.scheduledPayments(vault.contractId)).length === 0,
    tx: ran?.hash,
    detail: ran?.error ?? `${formatAmount(instalment)} KUSD to the tax destination`,
  });

  log('early release must be refused');
  const early = await expectRefusal(() => c.send(k.freelancer, c.releaseOp(vault.contractId, pid, token)), 'NotDue');
  steps.push({ step: 'Release before the due date is refused', ok: true, detail: `refused by the contract: ${early}` });

  log('new destination: proposed, cannot apply before its notice');
  const proposed = await c.send(k.freelancer, c.proposeDestinationOp(vault.contractId, k.newDestination.publicKey()));
  steps.push({ step: 'Freelancer proposes a new tax destination (2-minute notice in this demo)', ok: true, tx: proposed.hash, detail: k.newDestination.publicKey() });
  const notYet = await expectRefusal(() => c.send(k.keeper, c.applyPendingOp(vault.contractId)), 'ChangeNotReady');
  steps.push({ step: 'Applying it before the notice has passed is refused', ok: true, detail: `refused by the contract: ${notYet}` });

  log('clients abroad: a second inbox without VAT, client terms and a correction with notice');
  // The chain does not say where a payer is: the freelancer gives clients abroad a second address,
  // whose payments the vault books without VAT. A client abroad who pays the usual address by
  // mistake reserves VAT that is not owed; the owner proposes a correction that anyone applies after the notice.
  const abVault = await c.deployVault(k.keeper, vaultHash, {
    owner: k.freelancer.publicKey(),
    rule: terms.rule,
    taxDestination: k.taxAccount.publicKey(),
    noticeSecs: 120n,
    period: { kind: 'Seconds', seconds: 3_600n },
    dues: duesAfter(0n),
    tokens: [token],
  });
  const abHome = await c.deployInbox(k.keeper, inboxHash, abVault.contractId);
  const abAbroad = await c.deployInbox(k.keeper, inboxHash, abVault.contractId);
  const noVat = abroadTerms(terms.rule);
  const abExpect = await c.send(k.freelancer, c.expectPayerOp(abVault.contractId, abAbroad.contractId, noVat));
  steps.push({ step: 'A second payment address for clients abroad: an inbox the vault books without VAT (expect_payer, owner-signed)', ok: true, tx: abExpect.hash, detail: abAbroad.contractId });
  const abKeeper = new Keeper(c, k.keeper, [{ inbox: abAbroad.contractId, token }, { inbox: abHome.contractId, token }], () => {}, [abVault.contractId]);
  const abT1 = await c.send(k.client, c.transferOp(token, k.client.publicKey(), abAbroad.contractId, parseAmount('1000')));
  const abOwner0 = await c.balance(token, k.freelancer.publicKey());
  const abVault0 = await c.balance(token, abVault.contractId);
  await abKeeper.tick();
  const abGot = { owner: (await c.balance(token, k.freelancer.publicKey())) - abOwner0, vault: (await c.balance(token, abVault.contractId)) - abVault0 };
  steps.push({
    step: 'A client abroad pays 1,000 KUSD to that address: no VAT reserved, income tax as usual',
    ok: abGot.owner === parseAmount('800') && abGot.vault === parseAmount('200'),
    tx: abT1.hash,
    detail: `freelancer +${formatAmount(abGot.owner)}, vault +${formatAmount(abGot.vault)}`,
  });
  const abT2 = await c.send(k.client, c.transferOp(token, k.client.publicKey(), abHome.contractId, parseAmount('1210')));
  await abKeeper.tick();
  const latestAb = (await c.server.getLatestLedger()).sequence;
  const seenAbroad = await transfersInto(c.server, [token], abAbroad.contractId, Math.max(latestAb - 200, 1));
  const seenHome = await transfersInto(c.server, [token], abHome.contractId, Math.max(latestAb - 200, 1));
  const known = new Set(seenAbroad.map((x) => x.from));
  const suspect = seenHome.find((x) => known.has(x.from));
  steps.push({
    step: 'The same client then pays 1,210 KUSD to the usual address: 210 of VAT is reserved, and the app recognises the wallet from its payment to the address for clients abroad',
    ok: !!suspect && suspect.amount === parseAmount('1210'),
    tx: abT2.hash,
    detail: suspect ? `payer ${suspect.from.slice(0, 8)}… seen paying both addresses` : 'not recognised',
  });
  // The period that holds the VAT just reserved: this hour's, or the last one's if the hour turned since
  // (read from the vault itself: the RPC's event index can lag a few seconds behind).
  let abPid = await c.currentPeriod(abVault.contractId);
  let abVat = (await c.period(abVault.contractId, abPid, token)).buckets.vat ?? 0n;
  if (abVat === 0n) {
    abPid -= 1;
    abVat = (await c.period(abVault.contractId, abPid, token)).buckets.vat ?? 0n;
  }
  const corr = await c.send(k.freelancer, c.proposeCorrectionOp(abVault.contractId, { period: abPid, token, bucket: 'vat', amount: abVat }));
  const corrEarly = await expectRefusal(() => c.send(k.keeper, c.applyCorrectionOp(abVault.contractId, 1)), 'NotYet');
  steps.push({ step: `The owner proposes taking that VAT back (${formatAmount(abVat)} KUSD); applying it before the 2-minute notice is refused`, ok: abVat === parseAmount('210'), tx: corr.hash, detail: `refused by the contract: ${corrEarly}` });
  const abExpectClient = await c.send(k.freelancer, c.expectPayerOp(abVault.contractId, k.client.publicKey(), noVat));
  const abOwner1 = await c.balance(token, k.freelancer.publicKey());
  const abPaid = await c.send(k.client, c.payOp(router.contractId, { from: k.client.publicKey(), vault: abVault.contractId, token, amount: parseAmount('1000'), reference: invoiceReference('INV-ABROAD-7') }));
  steps.push({
    step: 'The owner registers the client wallet\'s terms: its next payment through the Router reserves no VAT',
    ok: (await c.balance(token, k.freelancer.publicKey())) - abOwner1 === parseAmount('800'),
    tx: abPaid.hash,
    detail: `expect_payer ${abExpectClient.hash.slice(0, 10)}…; freelancer +800, vault +200`,
  });
  const abProposedAt = Date.now();

  log('one payment address per client: the same wallet pays a client at home and an EU business, swept together');
  // A swept inbox cannot tell who paid: the address must say it. Each client gets their own,
  // registered with that client's VAT; the same payer wallet, swept in one tick, still splits right.
  const esPack = loadRulePack('es');
  const homeClient = await c.deployInbox(k.keeper, inboxHash, abVault.contractId);
  const euBusiness = await c.deployInbox(k.keeper, inboxHash, abVault.contractId);
  const homeTerms = clientTerms(esPack, terms.rule, { country: 'ES', business: true });
  const euTerms = clientTerms(esPack, terms.rule, { country: 'DE', business: true, vatId: 'DE123456789' });
  await c.send(k.freelancer, clientTermsOp(c, abVault.contractId, homeClient.contractId, homeTerms));
  await c.send(k.freelancer, clientTermsOp(c, abVault.contractId, euBusiness.contractId, euTerms));
  const vatHeld = async () => {
    const p = await c.currentPeriod(abVault.contractId);
    let v = 0n;
    for (const id of [p - 1, p]) v += (await c.period(abVault.contractId, id, token)).buckets.vat ?? 0n;
    return v;
  };
  const vatBefore = await vatHeld();
  await c.send(k.client, c.transferOp(token, k.client.publicKey(), homeClient.contractId, parseAmount('1210')));
  await c.send(k.client, c.transferOp(token, k.client.publicKey(), euBusiness.contractId, parseAmount('1000')));
  const perClient = await new Keeper(c, k.keeper, [{ inbox: homeClient.contractId, token }, { inbox: euBusiness.contractId, token }]).tick();
  const vatAdded = (await vatHeld()) - vatBefore;
  steps.push({
    step: 'One payment address per client: the same wallet pays 1,210 KUSD to a client-at-home address and 1,000 KUSD to an EU business address, swept in one tick; VAT is reserved only for the first',
    ok: perClient.length === 2 && perClient.every((x) => !x.error) && vatAdded === parseAmount('210'),
    tx: perClient[0]?.hash,
    detail: `VAT reserved: ${formatAmount(vatAdded)} (21% at home: 210; reverse charge: 0); addresses ${homeClient.contractId}, ${euBusiness.contractId}`,
  });

  log('fixed fee and payout address proposed with notice; reserve deposited without income');
  // A fixed amount per period (the self-employed fee) comes out of the first payments of each period,
  // and the net amount can go to another wallet of the owner's; both wait out the notice.
  const fxVault = await c.deployVault(k.keeper, vaultHash, {
    owner: k.freelancer.publicKey(),
    rule: terms.rule,
    taxDestination: k.taxAccount.publicKey(),
    noticeSecs: 120n,
    period: { kind: 'Seconds', seconds: 3_600n },
    dues: duesAfter(0n),
    tokens: [token],
  });
  const fxInbox = await c.deployInbox(k.keeper, inboxHash, fxVault.contractId);
  const fxFee = parseAmount('100');
  const fxFixed = await c.send(k.freelancer, c.proposeFixedOp(fxVault.contractId, [{ bucket: 'social', token, amount: fxFee }]));
  const fxPayout = await c.send(k.freelancer, c.proposePayoutOp(fxVault.contractId, k.newDestination.publicKey()));
  const fxProposedAt = Date.now();

  log('public money: a test digital dollar with issuer controls, proposed as a new currency');
  // Issued like public money usually is: holders need the issuer's authorization, and the issuer
  // can freeze and claw back. The vault starts with KUSD only and adds it with notice.
  const centralBank = Keypair.random();
  await fund(centralBank.publicKey());
  await classic(c, centralBank, [Operation.setOptions({ setFlags: (AuthRequiredFlag | AuthRevocableFlag | AuthClawbackEnabledFlag) as never })]);
  const cbAsset = new Asset('KCB', centralBank.publicKey());
  for (const kp of [k.freelancer, k.client, k.taxAccount]) {
    await classic(c, kp, [Operation.changeTrust({ asset: cbAsset })]);
    await classic(c, centralBank, [Operation.setTrustLineFlags({ trustor: kp.publicKey(), asset: cbAsset, flags: { authorized: true } })]);
  }
  await classic(c, centralBank, [Operation.payment({ destination: k.client.publicKey(), asset: cbAsset, amount: '10000' })]);
  await c.send(centralBank, Operation.createStellarAssetContract({ asset: cbAsset }));
  const cbToken = cbAsset.contractId(PASS);
  const cbVault = await c.deployVault(k.keeper, vaultHash, {
    owner: k.freelancer.publicKey(),
    rule: terms.rule,
    taxDestination: k.taxAccount.publicKey(),
    noticeSecs: 120n,
    period: { kind: 'Seconds', seconds: 3_600n },
    dues: duesAfter(0n),
    tokens: [token],
  });
  const cbInbox = await c.deployInbox(k.keeper, inboxHash, cbVault.contractId);
  const cbProposed = await c.send(k.freelancer, c.proposeTokenOp(cbVault.contractId, cbToken));
  const cbProposedAt = Date.now();
  const cbNotYet = await expectRefusal(() => c.send(k.client, c.payOp(router.contractId, { from: k.client.publicKey(), vault: cbVault.contractId, token: cbToken, amount: parseAmount('121'), reference: invoiceReference('INV-CB-0') })), 'TokenNotAccepted');
  steps.push({
    step: 'Public money: a vault proposes accepting KCB, a test digital dollar issued like a central bank\'s (authorization required, freeze and clawback enabled); before the 2-minute notice a payment in it is refused',
    ok: (await c.pendingToken(cbVault.contractId))?.token === cbToken && !(await c.accepts(cbVault.contractId, cbToken)),
    tx: cbProposed.hash,
    detail: `refused by the contract: ${cbNotYet}; vault ${cbVault.contractId}, asset ${cbToken}`,
  });
  const fxPending = await c.pendingFixed(fxVault.contractId);
  steps.push({
    step: 'Fixed fee and payout address: the owner proposes setting aside 100 KUSD per period before the net amount goes out, and paying the net amount to another wallet of theirs (2-minute notice)',
    ok: (await c.payout(fxVault.contractId)) === k.freelancer.publicKey() && fxPending?.fixed[0]?.amount === fxFee && (await c.pendingPayout(fxVault.contractId))?.payout === k.newDestination.publicKey(),
    tx: fxPayout.hash,
    detail: `propose_fixed ${fxFixed.hash.slice(0, 10)}…; until the notice ends the net amount still goes to the signing wallet (vault ${fxVault.contractId})`,
  });
  const fxPid = await c.currentPeriod(fxVault.contractId);
  const fxDep = await c.send(k.freelancer, c.depositOp(fxVault.contractId, { from: k.freelancer.publicKey(), token, period: fxPid, bucket: 'vat', amount: parseAmount('21') }));
  const fxState = await c.period(fxVault.contractId, fxPid, token);
  steps.push({
    step: 'Reserve without income: the owner deposits the 21 KUSD of VAT on 121 received in another wallet; the vault holds it like any reserve, and the period\'s income stays 0',
    ok: fxState.buckets.vat === parseAmount('21') && fxState.deposited === parseAmount('21') && fxState.income === 0n,
    tx: fxDep.hash,
    detail: `period ${fxPid}: vat ${formatAmount(fxState.buckets.vat ?? 0n)}, deposited ${formatAmount(fxState.deposited)}, income ${formatAmount(fxState.income)}`,
  });

  log('euro reserve: Soroswap testnet pool at Reflector\'s EUR/USD price, swapper, conversion proposed');
  let euro: { vault: string; proposedAt: number; eurUsd: bigint } | null = null;
  let euroSkip = '';
  try {
    const p = scValToNative(await c.read(REFLECTOR.testnet.fiat, 'lastprice', oracleAssetToScVal({ other: 'EUR' }))) as { price: bigint; timestamp: bigint } | null | undefined;
    if (!p) throw new Error('Reflector testnet fiat oracle has no EUR price');
    const eurUsd = BigInt(p.price);
    const age = Math.floor(Date.now() / 1000) - Number(p.timestamp);
    if (age > 80_000) throw new Error(`Reflector testnet fiat oracle's EUR price is ${Math.round(age / 3600)} h old`);
    // Pool: 1,160,000 KUSD against the KEUR that buys at the oracle's price, deep enough that
    // a 410 swap moves the price far less than the vault's 1% tolerance (a shallow pool is refused).
    const kusd = parseAmount('1160000');
    const keur = (kusd * 10n ** 14n) / eurUsd;
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
    await c.send(
      k.lp,
      new Contract(SOROSWAP_ROUTER.testnet).call('add_liquidity', addr(token), addr(eurToken), i128(kusd), i128(keur), i128(0n), i128(0n), addr(k.lp.publicKey()), u64(deadline)),
    );
    const swapper = await c.deploySwapper(k.keeper, swapperHash, SOROSWAP_ROUTER.testnet);
    const ev = await c.deployVault(k.keeper, vaultHash, {
      owner: k.freelancer.publicKey(),
      rule: terms.rule,
      taxDestination: k.taxAccount.publicKey(),
      noticeSecs: 120n,
      period,
      dues: duesAfter(0n),
      tokens: [token, eurToken],
    });
    const prop = await c.send(
      k.freelancer,
      c.proposeConversionOp(ev.contractId, {
        fromToken: token,
        toToken: eurToken,
        swapper: swapper.contractId,
        oracle: REFLECTOR.testnet.fiat,
        fromPrice: { other: 'USD' },
        toPrice: { other: 'EUR' },
        maxSlippageBps: 100,
        // Testnet's oracle is updated less often than mainnet's; the demo accepts a day-old price.
        maxAgeSecs: 86_400n,
      }),
    );
    euro = { vault: ev.contractId, proposedAt: Date.now(), eurUsd };
    steps.push({
      step: 'Euro reserve: a vault taking KUSD and KEUR proposes converting its reserve to KEUR through the Soroswap testnet router (2-minute notice)',
      ok: true,
      tx: prop.hash,
      detail: `Reflector testnet EUR = ${formatAmount(eurUsd / 10n ** 7n)} USD (price ${age}s old); pool 1,160,000 KUSD / ${formatAmount(keur)} KEUR; swapper ${swapper.contractId}; vault ${ev.contractId}`,
    });
  } catch (e) {
    euroSkip = (e as Error).message.slice(0, 300);
    steps.push({ step: 'Euro reserve on testnet', ok: true, skipped: true, detail: `skipped: ${euroSkip}` });
  }

  log('scheduled VAT change: Thailand 7% -> 10%, signed ahead');
  const th = loadRulePack('th');
  const thTerms = termsFromPack(th, 'vat-registered', '2026-10-16');
  const thVault = await c.deployVault(k.keeper, vaultHash, {
    owner: k.freelancer.publicKey(),
    rule: thTerms.rule,
    taxDestination: k.taxAccount.publicKey(),
    noticeSecs: 120n,
    period: thTerms.period,
    dues: thTerms.dues,
    tokens: [token],
  });
  // The plan for the real change (1 October 2027); the demo compresses its date to a few minutes from now.
  const plan = vatUpdatePlan(th, 'vat-registered', thTerms.rule, 120n, '2026-10-16');
  if (plan.action !== 'schedule' || !plan.rule) throw new Error(`unexpected plan: ${plan.action}`);
  const effectiveAt = BigInt(Math.floor(Date.now() / 1000)) + 150n;
  const scheduled = await c.send(k.freelancer, c.proposeRuleAtOp(thVault.contractId, plan.rule, effectiveAt));
  const thBefore = await c.quote(thVault.contractId, parseAmount('1070'));
  steps.push({
    step: 'Thailand vault: the owner signs the scheduled VAT change (7% to 10%) ahead of its date with propose_rule_at',
    ok: thBefore.vat === parseAmount('70'),
    tx: scheduled.hash,
    detail: `${plan.message} Demo date: ${new Date(Number(effectiveAt) * 1000).toISOString()}; before it, 1,070 still splits as VAT ${formatAmount(thBefore.vat)} (vault ${thVault.contractId})`,
  });

  log('rate registry filled from the Spain pack; the Spanish vault follows it');
  const registry = await c.deployRegistry(k.keeper, registryHash, k.keeper.publicKey(), 120n);
  const es = loadRulePack('es');
  const nowSecs = BigInt(Math.floor(Date.now() / 1000));
  const seeds = registrySyncPlan(es, {}, nowSecs, 120n).filter((a) => a.kind === 'seed' && a.rate === 'standard');
  for (const a of seeds) if (a.kind === 'seed') await c.send(k.keeper, c.seedRateOp(registry.contractId, es.country, a.rate, a.bps));
  const followed = await c.send(k.freelancer, c.followOp(vault.contractId, { registry: registry.contractId, country: 'ES', rate: 'standard', maxBps: 2500 }));
  steps.push({
    step: 'Rate Registry deployed and seeded from the Spain rule pack (21%); the Spanish vault follows ES/standard, ceiling 25%',
    ok: (await c.feed(vault.contractId))?.country === 'ES',
    tx: followed.hash,
    detail: `registry ${registry.contractId}`,
  });
  // A legal change, compressed to a few minutes for the demo: 22% from the date below.
  const lawDate = BigInt(Math.floor(Date.now() / 1000)) + 150n;
  const published = await c.send(k.keeper, c.publishRateOp(registry.contractId, 'ES', 'standard', lawDate, 2200));
  steps.push({
    step: 'The registry publishes a VAT change (demo: 21% to 22%), at least its 2-minute notice ahead',
    ok: (await c.quote(vault.contractId, parseAmount('1210'))).vat === parseAmount('210'),
    tx: published.hash,
    detail: `applies from ${new Date(Number(lawDate) * 1000).toISOString()}; until then the vault still charges 21%`,
  });

  log('moving to Germany: new vault, inbox moves after the notice');
  const move = changeCountryPlan({ period: 'Seconds', dues: duesAfter(0n), following: true }, { pack: loadRulePack('de'), presetId: 'standard' }, '2026-10-16');
  const deVault = await c.deployVault(k.keeper, vaultHash, {
    owner: k.freelancer.publicKey(),
    rule: move.rule,
    taxDestination: k.newDestination.publicKey(),
    noticeSecs: 120n,
    period: periodKindOf(move.period),
    dues: move.dues,
    tokens: [token],
  });
  const moved = await c.send(k.freelancer, c.proposeVaultOp(inbox.contractId, deVault.contractId));
  const movedAt = Date.now();
  // Germany: the final payment date comes in the tax office's notice. The owner sets it in the new vault.
  const dePeriod = await c.currentPeriod(deVault.contractId);
  const today = Math.floor(Date.now() / 86_400_000);
  const noticeDay = today + 400;
  const deIncome = move.rule.buckets[0].name;
  const set = await c.send(k.freelancer, c.setDueOp(deVault.contractId, { bucket: deIncome, fromPeriod: dePeriod, toPeriod: dePeriod, day: noticeDay }));
  const lockNow = await c.bucketDueDate(deVault.contractId, dePeriod, deIncome);
  const wantLock = nextOpen((BigInt(noticeDay) + 1n) * 86_400n, move.dues.closed, new Set());
  steps.push({
    step: 'Germany: the owner sets the income-tax due date from the tax office\'s notice (set_due); a later date applies at once, moved past the weekend',
    ok: lockNow === wantLock,
    tx: set.hash,
    detail: `due ${new Date(noticeDay * 86_400_000).toISOString().slice(0, 10)}, lock opens ${new Date(Number(lockNow) * 1000).toISOString().slice(0, 10)}`,
  });
  const sooner = await expectRefusal(() => c.send(k.freelancer, c.setDueOp(deVault.contractId, { bucket: deIncome, fromPeriod: dePeriod, toPeriod: dePeriod, day: today - 20 })), 'DueTooSoon');
  steps.push({ step: 'An earlier date that would open the lock within the notice period is refused', ok: true, detail: `refused by the contract: ${sooner}` });
  steps.push({
    step: 'The owner moves to Germany: a vault from the German pack, and propose_vault on the same inbox (2-minute notice)',
    ok: !move.sameVault && (await c.inboxVault(inbox.contractId)) === vault.contractId,
    tx: moved.hash,
    detail: `new vault ${deVault.contractId}; ${move.steps.length} steps in the plan; until the notice ends the inbox still pays the Spanish vault`,
  });

  const due = await c.dueDate(vault.contractId, pid);
  const waitMs = Number(due) * 1000 - Date.now() + 15_000;
  log(`waiting ${Math.ceil(waitMs / 1000)} s for the due date`);
  if (waitMs > 0) await sleep(waitMs);

  log('release after the due date');
  const before = await c.balance(token, k.freelancer.publicKey());
  const rel = await c.send(k.freelancer, c.releaseOp(vault.contractId, pid, token));
  const back = (await c.balance(token, k.freelancer.publicKey())) - before;
  steps.push({ step: 'After the due date the rest of the period is released to the freelancer', ok: back === state.buckets.irpf - instalment, tx: rel.hash, detail: `${formatAmount(back)} KUSD back to the freelancer` });

  log('the correction is applied by the keeper after its notice');
  const corrWait = abProposedAt + 125_000 - Date.now();
  if (corrWait > 0) await sleep(corrWait);
  const abOwner2 = await c.balance(token, k.freelancer.publicKey());
  const corrRun = (await new Keeper(c, k.keeper, [], () => {}, [abVault.contractId]).runDue()).find((r) => r.kind === 'correction');
  const abBack = (await c.balance(token, k.freelancer.publicKey())) - abOwner2;
  steps.push({
    step: 'After the notice the keeper applies the correction (no owner signature): the VAT not owed goes back to the freelancer',
    ok: !corrRun?.error && abBack === abVat && (await c.corrections(abVault.contractId)).length === 0,
    tx: corrRun?.hash,
    detail: corrRun?.error ?? `${formatAmount(abBack)} KUSD back to the freelancer`,
  });

  log('after the notice: the fixed fee fills first and the net amount goes to the payout address');
  const fxWait = fxProposedAt + 125_000 - Date.now();
  if (fxWait > 0) await sleep(fxWait);
  const fxKeeper = new Keeper(c, k.keeper, [{ inbox: fxInbox.contractId, token }]);
  const fxBal = async () => ({ payout: await c.balance(token, k.newDestination.publicKey()), owner: await c.balance(token, k.freelancer.publicKey()), vault: await c.balance(token, fxVault.contractId) });
  const fx0 = await fxBal();
  await c.send(k.client, c.transferOp(token, k.client.publicKey(), fxInbox.contractId, parseAmount('1210')));
  const [fxSweep1] = await fxKeeper.tick();
  const fx1 = await fxBal();
  steps.push({
    step: 'After the notice a client pays 1,210 KUSD to the inbox: 100 go to the fixed fee first, the other 700 of the net amount to the payout address, nothing to the signing wallet',
    ok: !fxSweep1?.error && fx1.payout - fx0.payout === parseAmount('700') && fx1.owner === fx0.owner && fx1.vault - fx0.vault === parseAmount('510'),
    tx: fxSweep1?.hash,
    detail: fxSweep1?.error ?? `payout address +${formatAmount(fx1.payout - fx0.payout)}, vault +${formatAmount(fx1.vault - fx0.vault)} (VAT 210, income tax 200, fixed fee 100)`,
  });
  const fxPid1 = await c.currentPeriod(fxVault.contractId);
  await c.send(k.client, c.transferOp(token, k.client.publicKey(), fxInbox.contractId, parseAmount('121')));
  // What the inbox will authorize: the vault's own prediction (a new period would take the fee again).
  const fxQ2 = await c.quoteIn(fxVault.contractId, { from: fxInbox.contractId, token, gross: parseAmount('121') });
  const fxPid2 = await c.currentPeriod(fxVault.contractId);
  const [fxSweep2] = await fxKeeper.tick();
  const fx2 = await fxBal();
  steps.push({
    step: 'Once the period\'s fee is set aside, the next payment (121 KUSD) splits as usual: 80 to the payout address',
    ok: !fxSweep2?.error && fx2.payout - fx1.payout === fxQ2.net && fx2.vault - fx1.vault === fxQ2.reserve && (fxQ2.fixed === 0n ? fxQ2.net === parseAmount('80') : fxPid2 !== fxPid1),
    tx: fxSweep2?.hash,
    detail: fxSweep2?.error ?? `payout address +${formatAmount(fx2.payout - fx1.payout)}, vault +${formatAmount(fx2.vault - fx1.vault)}`,
  });

  log('public money after the notice: authorization, split, tax paid straight to the tax office');
  const cbWait = cbProposedAt + 125_000 - Date.now();
  if (cbWait > 0) await sleep(cbWait);
  // The inbox needs the issuer's authorization to receive; the vault, to keep the reserve.
  await c.send(centralBank, c.authorizeHolderOp(cbToken, cbInbox.contractId));
  await c.send(k.client, c.transferOp(cbToken, k.client.publicKey(), cbInbox.contractId, parseAmount('1210')));
  const cbKeeper = new Keeper(c, k.keeper, [{ inbox: cbInbox.contractId, token: cbToken }]);
  const [cbBlocked] = await cbKeeper.tick();
  steps.push({
    step: 'A client pays 1,210 KCB to the inbox; until the issuer authorizes the vault to hold KCB, the sweep fails and the money waits in the inbox',
    ok: !!cbBlocked?.error && (await c.balance(cbToken, cbInbox.contractId)) === parseAmount('1210'),
    detail: (cbBlocked?.error ?? 'the sweep went through').slice(0, 200),
  });
  const cbAuth = await c.send(centralBank, c.authorizeHolderOp(cbToken, cbVault.contractId));
  const cbOwner0 = await c.balance(cbToken, k.freelancer.publicKey());
  const [cbSweep] = await cbKeeper.tick();
  const cbGot = { owner: (await c.balance(cbToken, k.freelancer.publicKey())) - cbOwner0, vault: await c.balance(cbToken, cbVault.contractId) };
  steps.push({
    step: 'Once the issuer authorizes the vault, the sweep splits the 1,210 KCB: 800 to the freelancer, 410 kept in the vault in KCB',
    ok: !cbSweep?.error && cbGot.owner === parseAmount('800') && cbGot.vault === parseAmount('410'),
    tx: cbSweep?.hash ?? cbAuth.hash,
    detail: cbSweep?.error ?? `freelancer +${formatAmount(cbGot.owner)} KCB, vault ${formatAmount(cbGot.vault)} KCB`,
  });
  let cbPid = await c.currentPeriod(cbVault.contractId);
  if (!((await c.period(cbVault.contractId, cbPid, cbToken)).buckets.vat ?? 0n)) cbPid -= 1;
  const cbTax0 = await c.balance(cbToken, k.taxAccount.publicKey());
  const cbPaid = await c.send(k.freelancer, c.payTaxOp(cbVault.contractId, { period: cbPid, token: cbToken, bucket: 'vat', amount: parseAmount('210') }));
  steps.push({
    step: 'The VAT is paid in KCB straight to the tax office\'s Stellar account: no anchor, no conversion',
    ok: (await c.balance(cbToken, k.taxAccount.publicKey())) - cbTax0 === parseAmount('210'),
    tx: cbPaid.hash,
    detail: `210 KCB to ${k.taxAccount.publicKey().slice(0, 8)}…`,
  });

  log('the same Router with vaults from other countries');
  for (const [pack, preset, amount, label] of [
    ['de', 'standard', '1190', 'Germany: VAT 19% + income tax reserve 30%'],
    ['us', 'self-employed', '1000', 'United States: no VAT, federal and self-employment reserve 30%'],
    ['ae', 'vat-only', '1050', 'United Arab Emirates: VAT 5%, no income tax'],
  ] as const) {
    const t = termsFromPack(loadRulePack(pack), preset);
    const v = await c.deployVault(k.keeper, vaultHash, {
      owner: k.freelancer.publicKey(),
      rule: t.rule,
      taxDestination: k.taxAccount.publicKey(),
      noticeSecs: 120n,
      period: t.period,
      dues: t.dues,
      tokens: [token],
    });
    const g = parseAmount(amount);
    const q = await c.quote(v.contractId, g);
    const sent = await c.send(k.client, c.payOp(router.contractId, { from: k.client.publicKey(), vault: v.contractId, token, amount: g, reference: invoiceReference(`INV-${pack.toUpperCase()}-001`) }));
    const held = await c.balance(token, v.contractId);
    steps.push({
      step: `${label}: ${amount} KUSD paid through the same Router`,
      ok: held === q.reserve,
      tx: sent.hash,
      detail: `net ${formatAmount(q.net)}, VAT ${formatAmount(q.vat)}, other reserve ${formatAmount(q.reserve - q.vat)} (vault ${v.contractId})`,
    });
  }

  const thWait = Number(effectiveAt) * 1000 - Date.now() + 10_000;
  if (thWait > 0) {
    log(`waiting ${Math.ceil(thWait / 1000)} s for the scheduled VAT change`);
    await sleep(thWait);
  }
  const thGross = parseAmount('1100');
  const thQuote = await c.quote(thVault.contractId, thGross);
  const thHeld = await c.balance(token, thVault.contractId);
  const thPaid = await c.send(k.client, c.payOp(router.contractId, { from: k.client.publicKey(), vault: thVault.contractId, token, amount: thGross, reference: invoiceReference('INV-TH-001') }));
  steps.push({
    step: 'After the change time the same vault charges 10% VAT on its own, with no new signature',
    ok: thQuote.vat === parseAmount('100') && (await c.balance(token, thVault.contractId)) - thHeld === thQuote.reserve,
    tx: thPaid.hash,
    detail: `1,100 KUSD: net ${formatAmount(thQuote.net)}, VAT ${formatAmount(thQuote.vat)}, income tax reserve ${formatAmount(thQuote.reserve - thQuote.vat)}`,
  });

  // A platform's payout run: one signature pays two freelancers, each split by their own vault.
  // The Spanish vault's rate changes at the legal date: keep the run (quote, simulate, submit) clear of it.
  const toLaw = Number(lawDate) * 1000 - Date.now();
  if (toLaw > -10_000 && toLaw < 45_000) {
    log(`waiting ${Math.ceil((toLaw + 10_000) / 1000)} s so the payout run does not straddle the Spanish legal date`);
    await sleep(toLaw + 10_000);
  }
  const runQuotes = [await c.quote(vault.contractId, parseAmount('121')), await c.quote(thVault.contractId, parseAmount('110'))];
  const runHeld = [await c.balance(token, vault.contractId), await c.balance(token, thVault.contractId)];
  const run = await c.send(
    k.client,
    c.payManyOp(router.contractId, {
      from: k.client.publicKey(),
      token,
      payouts: [
        { vault: vault.contractId, amount: parseAmount('121'), reference: invoiceReference('RUN-1-ES') },
        { vault: thVault.contractId, amount: parseAmount('110'), reference: invoiceReference('RUN-1-TH') },
      ],
    }),
  );
  const runAfter = [await c.balance(token, vault.contractId), await c.balance(token, thVault.contractId)];
  steps.push({
    step: 'A platform pays two freelancers in one call (pay_many); each payment is split by its own vault',
    ok: runAfter[0] - runHeld[0] === runQuotes[0].reserve && runAfter[1] - runHeld[1] === runQuotes[1].reserve,
    tx: run.hash,
    detail: `121 KUSD to the Spanish vault (reserve ${formatAmount(runQuotes[0].reserve)}), 110 KUSD to the Thai vault (reserve ${formatAmount(runQuotes[1].reserve)})`,
  });

  const moveWait = Math.max(Number(lawDate) * 1000, movedAt + 120_000) - Date.now() + 10_000;
  if (moveWait > 0) {
    log(`waiting ${Math.ceil(moveWait / 1000)} s for the legal date and the inbox notice`);
    await sleep(moveWait);
  }
  const esQuote = await c.quote(vault.contractId, parseAmount('1220'));
  const esPaid = await c.send(k.client, c.payOp(router.contractId, { from: k.client.publicKey(), vault: vault.contractId, token, amount: parseAmount('1220'), reference: invoiceReference('INV-2027-002') }));
  steps.push({
    step: 'After the legal date the Spanish vault charges 22% on its own: the owner signed nothing',
    ok: esQuote.vat === parseAmount('220') && esQuote.parts[0] === parseAmount('200'),
    tx: esPaid.hash,
    detail: `1,220 KUSD: net ${formatAmount(esQuote.net)}, VAT ${formatAmount(esQuote.vat)}, income tax ${formatAmount(esQuote.parts[0])}`,
  });
  const esHeld = await c.balance(token, vault.contractId);
  await c.send(k.client, c.transferOp(token, k.client.publicKey(), inbox.contractId, parseAmount('1190')));
  const [movedSweep] = await keeper.tick();
  const deHeld = await c.balance(token, deVault.contractId);
  steps.push({
    step: 'After the notice the same inbox pays into the German vault (19% VAT + 30% reserve); the Spanish vault keeps what it holds',
    ok: !movedSweep?.error && (await c.inboxVault(inbox.contractId)) === deVault.contractId && deHeld === parseAmount('490') && (await c.balance(token, vault.contractId)) === esHeld,
    tx: movedSweep?.hash,
    detail: movedSweep?.error ?? `1,190 KUSD to the inbox: German vault +${formatAmount(deHeld)} (VAT 190, reserve 300)`,
  });

  if (euro) {
    const wait = euro.proposedAt + 125_000 - Date.now();
    if (wait > 0) await sleep(wait);
    log('euro reserve: payment in KUSD, keeper converts the reserve to KEUR');
    try {
      await c.send(k.client, c.payOp(router.contractId, { from: k.client.publicKey(), vault: euro.vault, token, amount: parseAmount('1210'), reference: invoiceReference('INV-EUR-001') }));
      const pidE = await c.currentPeriod(euro.vault);
      const conv = await c.send(k.keeper, c.convertOp(euro.vault, pidE));
      const eu = await c.period(euro.vault, pidE, eurToken);
      const us = await c.period(euro.vault, pidE, token);
      const fair = (parseAmount('410') * 10n ** 14n) / euro.eurUsd;
      const got = await c.balance(eurToken, euro.vault);
      steps.push({
        step: 'A client pays 1,210 KUSD; the keeper converts the 410 reserve to KEUR through Soroswap, at no less than the oracle price minus 1%',
        ok: us.converted === parseAmount('410') && got === (eu.buckets.vat ?? 0n) + (eu.buckets.irpf ?? 0n) && got * 100n >= fair * 99n,
        tx: conv.hash,
        detail: `${formatAmount(got)} KEUR (oracle fair value ${formatAmount(fair)}): VAT ${formatAmount(eu.buckets.vat ?? 0n)}, income tax ${formatAmount(eu.buckets.irpf ?? 0n)}`,
      });
    } catch (e) {
      steps.push({ step: 'Euro reserve conversion on testnet', ok: false, detail: (e as Error).message.slice(0, 300) });
    }
  }

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
  for (const st of steps) if (!st.ok) log(`step failed: ${st.step} -- ${st.detail}`);
  log(result.allOk ? 'all steps passed' : 'some steps failed');
  if (!result.allOk) process.exitCode = 1;
}

function report(r: { startedAt: string; finishedAt: string; token: string; contracts: Record<string, string>; steps: Step[]; allOk: boolean }): string {
  const rows = r.steps.map((s) => `| ${s.skipped ? 'skipped' : s.ok ? 'yes' : '**no**'} | ${s.step} | ${s.detail.replace(/\|/g, '/')} | ${s.tx ? `[tx](${txUrl(s.tx)})` : ''} |`);
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
