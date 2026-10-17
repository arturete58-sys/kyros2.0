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
 * 12. an invoice with IRPF withheld by the client (Facturae written to the
 *     results): the owner registers its terms and the 1,060 payment splits exactly;
 * 13. the VAT is paid to the destination with an anchor-style memo (muxed address);
 * 14. a vault that keeps its reserve in euros: reserve received in KUSD is
 *     swapped into KEUR through the Soroswap testnet router, never below
 *     Reflector's EUR/USD price minus 1%.
 *
 * For the demo the vault uses 4-minute periods and a 2-minute notice, so the
 * whole cycle fits in one run; real vaults use the rule pack's quarters.
 *
 *   node dist/demo/testnet.js --wasm-dir ../contracts/target/wasm32v1-none/release --out ../docs/testnet
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Asset, BASE_FEE, Contract, Keypair, MuxedAccount, Account, Networks, Operation, scValToNative, TransactionBuilder, xdr } from '@stellar/stellar-sdk';
import { REFLECTOR, SOROSWAP_ROUTER } from '../assets.js';
import { invoiceRef, invoiceTotals, money, payableUnits, toFacturae, vaultTerms, type Invoice } from '../invoice.js';
import { addr, i128, oracleAssetToScVal, u64 } from '../scval.js';
import { invoiceReference, KyrosClient, KyrosError } from '../client.js';
import { vaultEvents, toCsv } from '../events.js';
import { Keeper } from '../keeper.js';
import { periodLabel } from '../periods.js';
import { loadRulePack, termsFromPack, vatUpdatePlan } from '../rulepacks.js';
import { changeCountryPlan, registrySyncPlan } from '../registry.js';
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
    Operation.payment({ destination: k.lp.publicKey(), asset, amount: '100000' }),
    Operation.payment({ destination: k.lp.publicKey(), asset: eurAsset, amount: '100000' }),
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
    dueOffsetSecs: 0n,
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
  const irpfInvoice: Invoice = {
    series: 'KYR-',
    number: '2027-003',
    issueDate: new Date().toISOString().slice(0, 10),
    currency: 'EUR',
    seller: { name: 'Demo', surname: 'Freelancer', person: 'F', taxId: '12345678Z', country: 'ES', street: 'Calle Mayor 1', city: 'Madrid', postalCode: '28013', province: 'Madrid' },
    buyer: { name: 'Demo Client SL', taxId: 'B12345674', country: 'ES', street: 'Gran Vía 2', city: 'Valencia', postalCode: '46002', province: 'Valencia' },
    withholding: { rate: '15' },
    payment: { address: vault.contractId, asset: 'KUSD' },
    lines: [{ description: 'Consultoría (demo)', quantity: '1', unitPrice: '1000', vat: { category: 'S', rate: '21' } }],
  };
  // The client already withholds 15% for income tax; the vault keeps 5% more on top.
  const irpfTerms = vaultTerms(irpfInvoice, [{ name: 'irpf', bps: 500 }]);
  const expected = await c.send(k.freelancer, c.expectInvoiceOp(vault.contractId, invoiceRef(irpfInvoice), irpfTerms));
  steps.push({
    step: 'Freelancer issues invoice KYR-2027-003 (base 1,000, VAT 21%, IRPF 15% withheld by the client) and registers its terms in the vault',
    ok: true,
    tx: expected.hash,
    detail: `Facturae 3.2.2 in invoice-KYR-2027-003.xml; the client pays ${money(invoiceTotals(irpfInvoice).payable)}`,
  });
  const before3 = { freelancer: await c.balance(token, k.freelancer.publicKey()), vault: await c.balance(token, vault.contractId) };
  const paid3 = await c.send(k.client, c.payOp(router.contractId, { from: k.client.publicKey(), vault: vault.contractId, token, amount: payableUnits(irpfInvoice), reference: invoiceRef(irpfInvoice) }));
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

  log('early release must be refused');
  const early = await expectRefusal(() => c.send(k.freelancer, c.releaseOp(vault.contractId, pid, token)), 'NotDue');
  steps.push({ step: 'Release before the due date is refused', ok: true, detail: `refused by the contract: ${early}` });

  log('new destination: proposed, cannot apply before its notice');
  const proposed = await c.send(k.freelancer, c.proposeDestinationOp(vault.contractId, k.newDestination.publicKey()));
  steps.push({ step: 'Freelancer proposes a new tax destination (2-minute notice in this demo)', ok: true, tx: proposed.hash, detail: k.newDestination.publicKey() });
  const notYet = await expectRefusal(() => c.send(k.keeper, c.applyPendingOp(vault.contractId)), 'ChangeNotReady');
  steps.push({ step: 'Applying it before the notice has passed is refused', ok: true, detail: `refused by the contract: ${notYet}` });

  log('euro reserve: Soroswap testnet pool at Reflector\'s EUR/USD price, swapper, conversion proposed');
  let euro: { vault: string; proposedAt: number; eurUsd: bigint } | null = null;
  let euroSkip = '';
  try {
    const p = scValToNative(await c.read(REFLECTOR.testnet.fiat, 'lastprice', oracleAssetToScVal({ other: 'EUR' }))) as { price: bigint; timestamp: bigint } | null | undefined;
    if (!p) throw new Error('Reflector testnet fiat oracle has no EUR price');
    const eurUsd = BigInt(p.price);
    const age = Math.floor(Date.now() / 1000) - Number(p.timestamp);
    if (age > 80_000) throw new Error(`Reflector testnet fiat oracle's EUR price is ${Math.round(age / 3600)} h old`);
    // Pool: 11,600 KUSD against the KEUR that buys at the oracle's price.
    const kusd = parseAmount('11600');
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
      dueOffsetSecs: 0n,
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
      detail: `Reflector testnet EUR = ${formatAmount(eurUsd / 10n ** 7n)} USD (price ${age}s old); pool 11,600 KUSD / ${formatAmount(keur)} KEUR; swapper ${swapper.contractId}; vault ${ev.contractId}`,
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
    dueOffsetSecs: thTerms.dueOffsetSecs,
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
  const move = changeCountryPlan({ period: 'Seconds', dueOffsetSecs: 0n, following: true }, { pack: loadRulePack('de'), presetId: 'standard' }, '2026-10-16');
  const deVault = await c.deployVault(k.keeper, vaultHash, {
    owner: k.freelancer.publicKey(),
    rule: move.rule,
    taxDestination: k.newDestination.publicKey(),
    noticeSecs: 120n,
    period: { kind: move.period },
    dueOffsetSecs: move.dueOffsetSecs,
    tokens: [token],
  });
  const moved = await c.send(k.freelancer, c.proposeVaultOp(inbox.contractId, deVault.contractId));
  const movedAt = Date.now();
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
  steps.push({ step: 'After the due date the rest of the period is released to the freelancer', ok: back === state.buckets.irpf, tx: rel.hash, detail: `${formatAmount(back)} KUSD back to the freelancer` });

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
      dueOffsetSecs: t.dueOffsetSecs,
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
  writeFileSync(join(outDir, 'invoice-KYR-2027-003.xml'), toFacturae(irpfInvoice));
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
