/**
 * Paying tax through an anchor, end to end on testnet, against the SDF test
 * anchor (testanchor.stellar.org) and its test token SRT.
 *
 *   1. SEP-1, SEP-10: reads the anchor's stellar.toml and logs in as the owner.
 *   2. SEP-12, SEP-6: registers the owner's (test) bank details and opens a
 *      withdrawal; the anchor answers with its account and memo.
 *   3. Deploys a vault in SRT whose tax destination is that account, has a
 *      client pay 121 SRT into it, and pays the 21 SRT of VAT with
 *      `pay_tax_to` (the anchor's memo as muxed id).
 *   4. Polls the withdrawal: does the anchor see a payment made by a contract?
 *
 * Each step is reported; a step the anchor does not support is reported as a
 * finding, not hidden.
 *
 *   node dist/demo/anchor-testnet.js --config ../app/public/testnet.json [--out report.md]
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { Asset, BASE_FEE, Keypair, Networks, Operation, StellarToml, TransactionBuilder, type xdr } from '@stellar/stellar-sdk';
import { anchorAuth, anchorInfo, anchorPayout, startWithdrawal, withdrawalStatus, type WithdrawalTarget } from '../anchor.js';
import { invoiceReference, KyrosClient } from '../client.js';
import { duesAfter } from '../periods.js';
import { loadRulePack, termsFromPack } from '../rulepacks.js';
import { formatAmount, parseAmount } from '../split.js';

const args = process.argv.slice(2);
const flag = (n: string, d?: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : d;
};
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const HORIZON = 'https://horizon-testnet.stellar.org';
const DOMAIN = 'testanchor.stellar.org';
const txUrl = (h: string) => `https://stellar.expert/explorer/testnet/tx/${h}`;

interface Row {
  step: string;
  result: string;
  ok: boolean;
  tx?: string;
}

async function fund(pub: string): Promise<void> {
  for (let i = 0; i < 5; i++) {
    if ((await fetch(`https://friendbot.stellar.org?addr=${pub}`)).ok) return;
    await sleep(3000);
  }
  throw new Error(`friendbot could not fund ${pub}`);
}

async function classic(c: KyrosClient, source: Keypair, ops: xdr.Operation[]): Promise<string> {
  const account = await c.server.getAccount(source.publicKey());
  const b = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET });
  ops.forEach((o) => b.addOperation(o));
  const tx = b.setTimeout(120).build();
  tx.sign(source);
  const sent = await c.server.sendTransaction(tx);
  if (sent.status === 'ERROR') throw new Error(`classic tx refused: ${sent.errorResult?.result().switch().name}`);
  const done = await c.server.pollTransaction(sent.hash, { attempts: 130, sleepStrategy: () => 1000 });
  if (done.status !== 'SUCCESS') throw new Error(`classic tx ${sent.hash} ${done.status}`);
  return sent.hash;
}

async function main(): Promise<void> {
  const cfg = JSON.parse(readFileSync(flag('config', '../app/public/testnet.json')!, 'utf8')) as { rpcUrl: string; router: string };
  const out = flag('out');
  const rows: Row[] = [];
  const c = new KyrosClient({ rpcUrl: cfg.rpcUrl, networkPassphrase: Networks.TESTNET });
  const k = { owner: Keypair.random(), client: Keypair.random(), deployer: Keypair.random() };
  const report = () => {
    const ok = rows.every((r) => r.ok);
    const text = [
      `## Paying tax through an anchor on testnet (${DOMAIN})`,
      '',
      ok ? 'Every step passed.' : 'Some steps did not pass; each says why.',
      '',
      '| Step | Result | Transaction |',
      '| --- | --- | --- |',
      ...rows.map((r) => `| ${r.ok ? '' : '**'}${r.step}${r.ok ? '' : '**'} | ${r.result.replace(/\|/g, '/')} | ${r.tx ? `[tx](${txUrl(r.tx)})` : ''} |`),
      '',
    ].join('\n');
    console.log(text);
    if (out) writeFileSync(out, text);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
    if (!ok) process.exitCode = 1;
  };

  try {
    // ---- 1. SEP-1 and SEP-10 ----
    const info = await anchorInfo(DOMAIN);
    const srt = info.currencies.find((x) => x.code === 'SRT' && x.issuer);
    if (!srt?.issuer) throw new Error(`${DOMAIN} lists no SRT`);
    rows.push({ step: 'SEP-1: stellar.toml read', ok: true, result: `SEP-6 ${info.transferServer ?? 'none'}, SEP-24 ${info.transferServerSep24 ?? 'none'}, SRT issuer ${srt.issuer.slice(0, 8)}…` });
    log('funding test accounts');
    for (const kp of Object.values(k)) await fund(kp.publicKey());
    const token = await anchorAuth(info, k.owner, Networks.TESTNET);
    rows.push({ step: 'SEP-10: the owner logs in with their key', ok: true, result: 'session token received' });

    // ---- 2. SEP-12 (test bank details) and SEP-6 withdrawal ----
    const toml = (await StellarToml.Resolver.resolve(DOMAIN)) as Record<string, unknown>;
    const kyc = String(toml.KYC_SERVER ?? info.transferServer);
    const put = await fetch(`${kyc}/customer`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        account: k.owner.publicKey(),
        first_name: 'Kyros',
        last_name: 'Test',
        email_address: 'kyros-test@example.com',
        bank_account_number: '12345678',
        bank_number: '987654',
        bank_account_type: 'checking',
      }),
    });
    rows.push({ step: 'SEP-12: the owner registers test bank details', ok: put.ok, result: put.ok ? 'accepted' : `HTTP ${put.status}: ${(await put.text()).slice(0, 200)}` });

    // The VAT on a 121 SRT payment is 21; pay less if the anchor caps withdrawals lower.
    const limits = (((await (await fetch(`${info.transferServer}/info`)).json()) as { withdraw?: Record<string, { min_amount?: number; max_amount?: number }> }).withdraw ?? {}).SRT ?? {};
    const amount = Math.max(limits.min_amount ?? 0, Math.min(21, limits.max_amount ?? 21));
    let target: WithdrawalTarget | null = null;
    try {
      const w = await startWithdrawal(info, token, { assetCode: 'SRT', account: k.owner.publicKey(), amount: String(amount), sep: 6, type: 'bank_account', dest: '12345678' });
      if ('interactiveUrl' in w && !('account' in w)) throw new Error('the anchor answered with a form');
      target = w as WithdrawalTarget;
      rows.push({ step: `SEP-6: the owner opens a withdrawal of ${amount} SRT (anchor limits ${limits.min_amount ?? '-'} to ${limits.max_amount ?? '-'})`, ok: true, result: `pay ${target.account.slice(0, 8)}… with ${target.memoType ?? 'no'} memo ${target.memo ?? ''}; id ${target.id}` });
    } catch (e) {
      // Say what the anchor still wants: its customer record and the transaction as it stands.
      const auth = { authorization: `Bearer ${token}` };
      const cust = await (await fetch(`${kyc}/customer?account=${k.owner.publicKey()}&type=sep6-withdraw`, { headers: auth })).text().catch(() => '');
      const id = /withdrawal (\S+) /.exec((e as Error).message)?.[1];
      const txn = id ? await (await fetch(`${info.transferServer}/transaction?id=${id}`, { headers: auth })).text().catch(() => '') : '';
      console.log('customer:', cust, '\ntransaction:', txn);
      rows.push({ step: `SEP-6: the owner opens a withdrawal of ${amount} SRT (anchor limits ${limits.min_amount ?? '-'} to ${limits.max_amount ?? '-'})`, ok: false, result: `${(e as Error).message.slice(0, 200)}; customer: ${cust.slice(0, 300)}` });
    }
    if (!target) return report();

    let to: string;
    try {
      to = anchorPayout(target, target.account);
      rows.push({ step: "The anchor's account and memo as the vault's payment address", ok: true, result: to.startsWith('M') ? `muxed ${to.slice(0, 10)}… (memo as id)` : 'no memo needed' });
    } catch (e) {
      rows.push({ step: "The anchor's account and memo as the vault's payment address", ok: false, result: (e as Error).message });
      return report();
    }

    // ---- 3. A vault in SRT pays the VAT to the anchor ----
    log('buying SRT on the testnet DEX');
    const asset = new Asset('SRT', srt.issuer);
    await classic(c, k.client, [Operation.changeTrust({ asset })]);
    await classic(c, k.owner, [Operation.changeTrust({ asset })]);
    const paths = (await (await fetch(`${HORIZON}/paths/strict-receive?source_assets=native&destination_asset_type=credit_alphanum4&destination_asset_code=SRT&destination_asset_issuer=${srt.issuer}&destination_amount=121`)).json()) as {
      _embedded?: { records?: { source_amount: string; path: { asset_type: string; asset_code?: string; asset_issuer?: string }[] }[] };
    };
    const best = paths._embedded?.records?.[0];
    if (!best) {
      rows.push({ step: 'Buy 121 SRT on the testnet DEX for the client', ok: false, result: 'no path from XLM to SRT on the testnet DEX today' });
      return report();
    }
    const bought = await classic(c, k.client, [
      Operation.pathPaymentStrictReceive({
        sendAsset: Asset.native(),
        sendMax: (Number(best.source_amount) * 1.05).toFixed(7),
        destination: k.client.publicKey(),
        destAsset: asset,
        destAmount: '121',
        path: best.path.map((p) => (p.asset_type === 'native' ? Asset.native() : new Asset(p.asset_code!, p.asset_issuer!))),
      }),
    ]);
    rows.push({ step: 'The client buys 121 SRT on the testnet DEX', ok: true, result: `for ${best.source_amount} XLM`, tx: bought });

    const srtContract = asset.contractId(Networks.TESTNET);
    try {
      await c.send(k.deployer, Operation.createStellarAssetContract({ asset }));
    } catch {
      /* already deployed */
    }
    const terms = termsFromPack(loadRulePack('es'), 'general');
    const vault = await c.deployVault(k.deployer, Buffer.from(JSON.parse(readFileSync(flag('config', '../app/public/testnet.json')!, 'utf8')).wasm.vault, 'hex'), {
      owner: k.owner.publicKey(),
      rule: terms.rule,
      taxDestination: target.account,
      noticeSecs: 120n,
      period: { kind: 'Seconds', seconds: 400n * 86_400n },
      dues: duesAfter(0n),
      tokens: [srtContract],
    });
    rows.push({ step: "A vault in SRT whose tax destination is the anchor's account", ok: true, result: vault.contractId, tx: vault.hash });
    const paid = await c.send(k.client, c.payOp(cfg.router, { from: k.client.publicKey(), vault: vault.contractId, token: srtContract, amount: parseAmount('121'), reference: invoiceReference('INV-SRT-001') }));
    const period = await c.currentPeriod(vault.contractId);
    const book = await c.period(vault.contractId, period, srtContract);
    rows.push({ step: 'The client pays 121 SRT: VAT 21 and income tax 20 stay in the vault', ok: (book.buckets.vat ?? 0n) === parseAmount('21'), result: `VAT ${formatAmount(book.buckets.vat ?? 0n)}, income tax ${formatAmount(book.buckets.irpf ?? 0n)}`, tx: paid.hash });
    const tax = await c.send(k.owner, c.payTaxToOp(vault.contractId, { period, token: srtContract, bucket: 'vat', amount: parseAmount(String(amount)), to }));
    rows.push({ step: `The owner pays ${amount} SRT of the VAT to the anchor with its memo (pay_tax_to)`, ok: true, result: `to ${to.slice(0, 10)}…`, tx: tax.hash });

    // ---- 4. Does the anchor see it? ----
    let status = '';
    for (let i = 0; i < 36; i++) {
      try {
        status = (await withdrawalStatus(info, token, target.id, {}, 6)).status ?? '';
      } catch (e) {
        status = `error: ${(e as Error).message.slice(0, 120)}`;
      }
      if (['completed', 'pending_external', 'pending_anchor', 'error', 'refunded'].includes(status)) break;
      await sleep(5000);
    }
    rows.push({
      step: 'The anchor recognises the payment made by the vault (a contract) and processes the withdrawal',
      ok: ['completed', 'pending_external', 'pending_anchor'].includes(status),
      result: `status after up to 3 minutes: ${status || 'unknown'}`,
    });
  } catch (e) {
    rows.push({ step: 'Run', ok: false, result: (e as Error).message.slice(0, 300) });
  }
  report();
}

void main();
