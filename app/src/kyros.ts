/** What the app does with the Kyros contracts, on behalf of the connected wallet. */
import { Keypair, scValToNative } from '@stellar/stellar-sdk';
import { fmtNumber, t } from './i18n';
import { allowanceData, balanceOfData, burnCalls, fastFeeBps, fetchAttestation, mintAndPayOp, type EvmChain } from 'kyros-sdk';
import {
  abroadTerms,
  daysFromCivil,
  dayString,
  dueAt,
  dueOf,
  incomeTaxBuckets,
  payBy,
  periodEnd,
  periodOf,
  periodStart,
  requestRef,
  requestTerms,
  suggestSetup,
  taxYearStart,
  split,
  termsFromPack,
  transfersInto,
  upcomingDeadlines,
  vaultEvents,
  inboxMoves,
  guardAlerts,
  calendarOf,
  scheduleMove,
  shopInboxTermsOp,
  type ShopConfig,
  type CalendarPeriod,
  type MoveSchedule,
  type Expense,
  type GuardAlert,
  type Correction,
  type ActivityId,
  type ClientKind,
  type Deadline,
  type Dues,
  type HolidayData,
  type PaymentRequest,
  type PeriodFigures,
  type PeriodKind,
  type RulePack,
  type Rule,
  type ScheduledItem,
  type ScheduledPayment,
  type Setup,
  type Transfer,
  type VaultEventRow,
} from 'kyros-sdk';
import { loadHolidays, loadPack } from './packs';
import { Chain, localKey, store } from './chain';
import type { Wallet } from './wallet/types';
import type { EvmWallet } from './wallet/evm';

export interface Answers {
  packId: string;
  region?: string;
  resident: 'yes' | 'no' | 'unsure';
  activity: ActivityId;
  client: ClientKind;
  revenue: number;
}

export interface Plan {
  setup: Setup;
  rule: Rule;
  pack: RulePack;
}

export function makePlan(pack: RulePack, a: Answers): Plan {
  const setup = suggestSetup(pack, { activity: a.activity, client: a.client, revenue: a.revenue, region: a.region });
  return { setup, rule: setup.rule, pack };
}

export interface VaultInfo {
  vault: string;
  inbox: string;
  owner: string;
  answers: Answers;
  rule: Rule;
  /** The rule pack preset the vault was built from (its tax calendar). */
  presetId: string;
  createdAt: string;
  deployedAt: string;
  /** Tax office notices read into the vault: a due date (and amount) for a bucket over a tax year. */
  notices?: TaxNotice[];
  /** The payment address for clients abroad (an inbox the vault knows: no VAT), made on first use. */
  abroadInbox?: string;
  /** Wallets known to pay from abroad (seen paying the address for clients abroad, or confirmed by the user). */
  abroadPayers?: string[];
  /** Changes the owner proposed from this device (transaction hashes): the guardian does not flag them. */
  mine?: string[];
  /** Payments the user already settled (VAT taken back, or kept): their event ids. */
  settled?: string[];
  /** A change of country the owner planned or signed, until it takes effect. */
  move?: PendingMove;
  /** Vaults of earlier countries: they keep their reserves and pay those taxes on their dates. */
  previous?: VaultInfo[];
  /** Set while the app shows an earlier vault: the current one's address. */
  archivedOf?: string;
  /** Payment addresses for selling online (a shop or an x402 API): VAT bps → inbox. */
  shopInboxes?: Record<number, string>;
}

/**
 * A change of tax residence. Same calendar: the vault takes the new rule on the
 * day (`propose_rule_at`, signed ahead). Another calendar: a new vault, and the
 * same payment address moves to it after the notice (`propose_vault`), signed
 * from `signFrom` so the move lands on the day.
 */
export interface PendingMove {
  packId: string;
  region?: string;
  presetId: string;
  rule: Rule;
  /** The day the new residence starts, YYYY-MM-DD. */
  date: string;
  kind: 'rule' | 'vault';
  /** Unix seconds (as a string) from which the move can be signed (another calendar). */
  signFrom?: string;
  /** Unix seconds (as a string) when it takes effect, once signed. */
  readyAt?: string;
  newVault?: string;
  /** The vault followed the law's registry before (the move stops it). */
  wasFollowing?: boolean;
  hashes?: string[];
  signedAt?: string;
}

export interface TaxNotice {
  bucket: string;
  fromPeriod: number;
  toPeriod: number;
  /** The due day, YYYY-MM-DD. */
  date: string;
  /** Amount to pay, in token units, as a string. */
  amount?: string;
  /** The tax year it is for (its first day, YYYY-MM-DD). */
  taxYear: string;
  readAt: string;
}

const key = (owner: string) => `kyros.vault.${owner}`;

export function saveVault(v: VaultInfo): void {
  if (v.archivedOf) {
    // An earlier vault is kept inside the current one's record.
    const raw = store.get(key(v.owner));
    if (!raw) return;
    const cur = JSON.parse(raw) as VaultInfo;
    const { archivedOf: _, ...prev } = v;
    cur.previous = (cur.previous ?? []).map((p) => (p.vault === v.vault ? prev : p));
    store.set(key(v.owner), JSON.stringify(cur));
    return;
  }
  store.set(key(v.owner), JSON.stringify(v));
}

/** The latest stored record of this vault (other code may have saved it since `v` was read). */
export function freshVault(v: VaultInfo): VaultInfo {
  if (v.archivedOf) return v;
  const raw = store.get(key(v.owner));
  if (!raw) return v;
  const s = JSON.parse(raw) as VaultInfo;
  return s.vault === v.vault ? s : v;
}

/** The current vault's record (when the app shows an earlier one). */
export function currentVault(v: VaultInfo): VaultInfo | null {
  if (!v.archivedOf) return v;
  const raw = store.get(key(v.owner));
  return raw ? (JSON.parse(raw) as VaultInfo) : null;
}

/** What the user typed for instalments: expenses so far, last year's tax, notified amounts (per tax year or deadline). */
export interface InstalmentInputsStore {
  expenses: Record<string, string>;
  previousYearTax: Record<string, string>;
  notice: Record<string, string>;
}
const inputsKey = (vault: string) => `kyros.instalments.${vault}`;
export function loadInputs(vault: string): InstalmentInputsStore {
  try {
    return { expenses: {}, previousYearTax: {}, notice: {}, ...JSON.parse(store.get(inputsKey(vault)) ?? '{}') };
  } catch {
    return { expenses: {}, previousYearTax: {}, notice: {} };
  }
}
export function saveInputs(vault: string, i: InstalmentInputsStore): void {
  store.set(inputsKey(vault), JSON.stringify(i));
}

/** Remembers a change the owner proposed from here, so the guardian knows it was theirs. */
export function rememberMine(v: VaultInfo, hash: string): string {
  v.mine = [...new Set([...(v.mine ?? []), hash])].slice(-50);
  saveVault(v);
  return hash;
}

const expensesKey = (vault: string) => `kyros.expenses.${vault}`;
/** Expenses the user recorded (expense agent), kept in this browser only. */
export function loadExpenses(vault: string): Expense[] {
  try {
    return JSON.parse(store.get(expensesKey(vault)) ?? '[]') as Expense[];
  } catch {
    return [];
  }
}
export function saveExpenses(vault: string, xs: Expense[]): void {
  store.set(expensesKey(vault), JSON.stringify(xs));
}

export function savedVault(owner: string, deployedAt: string): VaultInfo | null {
  const raw = store.get(key(owner));
  if (!raw) return null;
  const v = JSON.parse(raw) as VaultInfo;
  // A vault from an older testnet deployment (testnet resets) is not shown.
  return v.deployedAt === deployedAt ? v : null;
}

export async function createVault(chain: Chain, wallet: Wallet, plan: Plan, answers: Answers, onStep: (s: string) => void): Promise<VaultInfo> {
  const cfg = chain.cfg;
  const fp = chain.feePayer;
  onStep(t('stepFeePayer'));
  await chain.ensureAccount(fp.publicKey());
  // The vault moves due dates past weekends and the holidays the registry publishes for the country.
  const terms = termsFromPack(plan.pack, plan.setup.presetId, new Date(), { holidayRegistry: cfg.registry || undefined });
  onStep(t('stepVault'));
  const vault = await chain.client.deployVault(fp, Buffer.from(cfg.wasm.vault, 'hex'), {
    owner: wallet.address,
    rule: plan.rule,
    taxDestination: cfg.taxAccount,
    noticeSecs: BigInt(cfg.noticeSecs),
    period: terms.period,
    dues: terms.dues,
    tokens: [...chain.dollarTokens, cfg.tokens.eur.contract],
  });
  onStep(t('stepInbox'));
  const inbox = await chain.client.deployInbox(fp, Buffer.from(cfg.wasm.inbox, 'hex'), vault.contractId);
  const info: VaultInfo = {
    vault: vault.contractId,
    inbox: inbox.contractId,
    owner: wallet.address,
    answers,
    rule: plan.rule,
    presetId: plan.setup.presetId,
    createdAt: new Date().toISOString(),
    deployedAt: cfg.deployedAt,
  };
  store.set(key(wallet.address), JSON.stringify(info));
  return info;
}

const UNIT = 10_000_000n;

/** A client (a test account in this browser, with test money) pays `gross` through the Router. */
export async function simulateClientPayment(chain: Chain, vault: string, gross: bigint, reference?: Uint8Array): Promise<string> {
  const client = localKey('test-client');
  const usd = chain.cfg.tokens.usd.contract;
  await chain.ensureAccount(client.publicKey());
  let balance = 0n;
  try {
    balance = await chain.client.balance(usd, client.publicKey());
  } catch {
    balance = 0n;
  }
  if (balance < gross) await chain.faucet(client, '20000');
  const ref = reference ?? globalThis.crypto.getRandomValues(new Uint8Array(32));
  return chain.sendAs(client, chain.client.payOp(chain.cfg.router, { from: client.publicKey(), vault, token: usd, amount: gross, reference: ref }));
}

/** Registers an expected payment in the vault (owner-signed) and returns its reference. */
export async function expectPayment(chain: Chain, wallet: Wallet, vault: string, req: PaymentRequest, reserveBps: number, bucket: string): Promise<{ hash: string; reference: Uint8Array }> {
  const reserve = Math.max(0, reserveBps - (req.withholding ? Math.round(Number(req.withholding.rate) * 100) : 0));
  const terms = requestTerms(req, reserve > 0 ? [{ name: bucket, bps: reserve }] : []);
  const reference = requestRef(req);
  const hash = await wallet.signAndSend(chain.client.expectInvoiceOp(vault, reference, terms));
  return { hash, reference };
}

/** What one bucket of one period holds in one token, and when it falls due. */
export interface Held {
  period: number;
  bucket: string;
  token: string;
  /** `usd` (KUSD or Circle's USDC) or `eur`. */
  which: 'usd' | 'eur';
  amount: bigint;
  /** Unix seconds from which it is past its due day and what is left can be released (the vault's own date). */
  dueAt: bigint;
  /** The end of the day to pay by: the legal date (or the notice's) moved the country's way for weekends and holidays. */
  payBy: bigint;
}

export interface Snapshot {
  spendable: { usd: bigint; eur: bigint };
  reserved: { usd: bigint; eur: bigint };
  /** Totals per bucket over every open period. */
  buckets: Record<string, { usd: bigint; eur: bigint }>;
  /** Every non-empty bucket of every period, oldest due first. */
  held: Held[];
  period: number;
  periodKind: PeriodKind | null;
  /** The next tax deadlines from the country's calendar (and the notices read). */
  deadlines: Deadline[];
  /** What each period recorded (income, withholding, income-tax reserve held and paid), dollars and euros together. */
  figures: PeriodFigures[];
  /** Open scheduled payments. */
  scheduled: ScheduledPayment[];
  pack: RulePack | null;
  holidays?: HolidayData;
  conversion: Awaited<ReturnType<Chain['client']['conversion']>>;
  pendingConversionAt: bigint | null;
  feed: Awaited<ReturnType<Chain['client']['feed']>>;
  events: VaultEventRow[];
  /** Tax being taken back, applied by itself once the notice has passed. */
  corrections: Correction[];
  /** Who paid each payment address lately (the address for clients abroad, if any). */
  transfers: { general: Transfer[]; abroad: Transfer[] };
  /** Pending changes the guardian flags (a new destination, rule, adapter, correction, inbox move). */
  guard: GuardAlert[];
  /** The rule the vault applies now (read from the chain). */
  rule: Rule | null;
  /** When each tax of a period falls due, as the vault has it. */
  dues: Dues | null;
}

const configs = new Map<string, { period: PeriodKind; dues: Dues }>();

export async function snapshot(chain: Chain, v: VaultInfo): Promise<Snapshot> {
  const c = chain.client;
  const { eur } = chain.cfg.tokens;
  const safe = async <T,>(f: () => Promise<T>, d: T): Promise<T> => {
    try {
      return await f();
    } catch {
      return d;
    }
  };
  // Dollars can be the test KUSD or Circle's USDC from another chain; the app shows them together.
  const dollars = chain.dollarTokens;
  const none = { held: 0n, liquid: 0n, invested: 0n, surplus: 0n };
  const sum = (xs: bigint[]) => xs.reduce((a, b) => a + b, 0n);
  // Read every time: the rule changes when a proposal takes effect.
  const live = await safe(() => c.config(v.vault), null);
  if (live) configs.set(v.vault, { period: live.period, dues: live.dues });
  const conf = configs.get(v.vault) ?? null;
  const [sUsds, sEur, pUsds, pEur, period] = await Promise.all([
    Promise.all(dollars.map((d) => safe(() => c.balance(d, v.owner), 0n))),
    safe(() => c.balance(eur.contract, v.owner), 0n),
    Promise.all(dollars.map((d) => safe(() => c.position(v.vault, d), none))),
    safe(() => c.position(v.vault, eur.contract), none),
    safe(() => c.currentPeriod(v.vault), 0),
  ]);
  // Every period since the vault was created can still hold reserve (the income tax is due long after).
  const first = conf ? periodOf(conf.period, BigInt(Math.floor(new Date(v.createdAt).getTime() / 1000))) : period;
  const ids: number[] = [];
  for (let id = Math.max(first, period - 40); id <= period; id++) ids.push(id);
  const tokens: [string, 'usd' | 'eur'][] = [...dollars.map((d): [string, 'usd'] => [d, 'usd']), [eur.contract, 'eur']];
  const states = await Promise.all(ids.flatMap((id) => tokens.map(([tk, which]) => safe(async () => ({ id, tk, which, p: await c.period(v.vault, id, tk) }), null))));
  const pack = await safe(() => loadPack(v.answers.packId), null);
  const holidays = await safe(() => loadHolidays(v.answers.packId), undefined);
  const workdays = pack?.calendar.workdays;
  const incomeBuckets = pack && v.presetId ? incomeTaxBuckets(pack, v.presetId) : [];
  const notice = (bucket: string, id: number) => (v.notices ?? []).find((n) => n.bucket === bucket && n.fromPeriod <= id && id <= n.toPeriod);
  const held: Held[] = [];
  const buckets: Snapshot['buckets'] = {};
  const figs = new Map<number, PeriodFigures>();
  for (const st of states) {
    if (!st) continue;
    const f = figs.get(st.id) ?? { id: st.id, income: 0n, withheld: 0n, incomeHeld: 0n, incomePaid: 0n };
    f.income += st.p.income;
    f.withheld += st.p.withheld;
    for (const [b, x] of Object.entries(st.p.paidBuckets)) if (b !== 'vat' && (incomeBuckets.length === 0 || incomeBuckets.includes(b))) f.incomePaid += x;
    figs.set(st.id, f);
    for (const [bucket, amount] of Object.entries(st.p.buckets)) {
      if (amount <= 0n) continue;
      if (bucket !== 'vat' && (incomeBuckets.length === 0 || incomeBuckets.includes(bucket))) f.incomeHeld += amount;
      const n = notice(bucket, st.id);
      const legal = n ? (daysFromCivil(BigInt(n.date.slice(0, 4)), Number(n.date.slice(5, 7)), Number(n.date.slice(8))) + 1n) * 86_400n : conf ? dueAt(conf.period, st.id, dueOf(conf.dues, bucket)) : 0n;
      held.push({ period: st.id, bucket, token: st.tk, which: st.which, amount, dueAt: legal, payBy: legal ? payBy(legal, workdays, holidays) : 0n });
      (buckets[bucket] ??= { usd: 0n, eur: 0n })[st.which] += amount;
    }
  }
  // The vault's own date for each bucket (weekends, the registry's holidays and any notice applied on-chain).
  const locks = new Map<string, bigint>();
  await Promise.all(
    [...new Set(held.map((h) => `${h.period}|${h.bucket}`))].map(async (k) => {
      const [id, b] = k.split('|');
      const at = await safe(() => c.bucketDueDate(v.vault, Number(id), b), 0n);
      if (at) locks.set(k, at);
    }),
  );
  for (const h of held) h.dueAt = locks.get(`${h.period}|${h.bucket}`) ?? h.dueAt;
  held.sort((a, b) => (a.payBy < b.payBy ? -1 : a.payBy > b.payBy ? 1 : a.period - b.period));
  const fromNotices: Deadline[] = (v.notices ?? [])
    .filter((n) => n.date >= new Date().toISOString().slice(0, 10))
    .map((n) => {
      const legal = (daysFromCivil(BigInt(n.date.slice(0, 4)), Number(n.date.slice(5, 7)), Number(n.date.slice(8))) + 1n) * 86_400n;
      return { date: dayString(payBy(legal, workdays, holidays)), legal: n.date, lock: n.date, kind: 'income' as const, bucket: n.bucket, amount: { kind: 'notice' as const }, what: t('noticeDeadline', { year: n.taxYear.slice(0, 4) }) };
    });
  const deadlines = pack && v.presetId
    ? safe(async () => [...upcomingDeadlines(pack, v.presetId, new Date(), 400, holidays), ...fromNotices].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)), [] as Deadline[])
    : Promise.resolve([] as Deadline[]);
  const scheduled = safe(() => c.scheduledPayments(v.vault), [] as ScheduledPayment[]);
  const [conversion, pending, feed, dl, sch] = await Promise.all([
    safe(() => c.conversion(v.vault), null),
    safe(async () => {
      const n = scValToNative(await c.read(v.vault, 'pending_conversion')) as { ready_at: bigint } | null | undefined;
      return n ? BigInt(n.ready_at) : null;
    }, null),
    safe(() => c.feed(v.vault), null),
    deadlines,
    scheduled,
  ]);
  const latest = await safe(() => chain.server.getLatestLedger(), { sequence: 0 } as { sequence: number });
  const since = Math.max(latest.sequence - 17_000, 1);
  const allTokens = [...dollars, eur.contract];
  const [events, corrections, general, abroad, moves] = await Promise.all([
    safe(() => vaultEvents(chain.server, v.vault, since), []),
    safe(() => c.corrections(v.vault), [] as Correction[]),
    safe(() => transfersInto(chain.server, allTokens, v.inbox, since), [] as Transfer[]),
    v.abroadInbox ? safe(() => transfersInto(chain.server, allTokens, v.abroadInbox!, since), [] as Transfer[]) : Promise.resolve([] as Transfer[]),
    safe(() => inboxMoves(chain.server, v.inbox, since), []),
  ]);
  // The guardian: anything pending that the owner did not propose from here, or that goes somewhere unknown.
  const known = new Set([chain.cfg.taxAccount, ...(chain.cfg.conversion ? [chain.cfg.conversion.swapper] : [])]);
  const guard = guardAlerts(events, moves, {
    now: BigInt(Math.floor(Date.now() / 1000)),
    mine: new Set(v.mine ?? []),
    known,
    currentReserveBps: v.rule.buckets.reduce((a, b) => a + b.bps, 0),
    openCorrections: new Set(corrections.map((x) => x.id)),
  });
  return {
    spendable: { usd: sum(sUsds), eur: sEur },
    reserved: { usd: sum(pUsds.map((p) => p.held)), eur: pEur.held },
    buckets,
    held,
    period,
    periodKind: conf?.period ?? null,
    deadlines: dl,
    figures: [...figs.values()].sort((a, b) => a.id - b.id),
    scheduled: sch,
    pack,
    holidays,
    conversion,
    pendingConversionAt: pending,
    feed,
    events: events.reverse(),
    corrections,
    transfers: { general, abroad },
    guard,
    rule: live?.rule ?? null,
    dues: conf?.dues ?? null,
  };
}

/** Owner: pays `amount` of one bucket of one period to the tax destination. */
export function payBucket(chain: Chain, wallet: Wallet, v: VaultInfo, h: Pick<Held, 'period' | 'token' | 'bucket'>, amount: bigint): Promise<string> {
  return wallet.signAndSend(chain.client.payTaxOp(v.vault, { period: h.period, token: h.token, bucket: h.bucket, amount }));
}

/** The periods of the tax year that starts on `start` (Unix seconds) for a vault's period kind. */
export function taxYearPeriods(kind: PeriodKind, pack: RulePack, start: bigint): { from: number; to: number } {
  const end = taxYearStart(pack.calendar.fiscalYearStart, start + 86_400n, 1);
  const from = periodOf(kind, start);
  let to = from;
  while (periodEnd(kind, to + 1) <= end && to - from < 23) to++;
  // A period that starts before the year (fiscal years not aligned with periods) is left out.
  return { from: periodStart(kind, from) < start ? from + 1 : from, to };
}

/**
 * Owner: sets the due date of the income-tax buckets for a tax year from the
 * tax office's notice (`set_due`), and remembers the notice in this browser.
 */
export async function applyNotice(chain: Chain, wallet: Wallet, v: VaultInfo, kind: PeriodKind, pack: RulePack, n: { date: string; amount?: bigint; taxYearStart: bigint }, onStep: (s: string) => void): Promise<string[]> {
  const { from, to } = taxYearPeriods(kind, pack, n.taxYearStart);
  const day = Number(daysFromCivil(BigInt(n.date.slice(0, 4)), Number(n.date.slice(5, 7)), Number(n.date.slice(8))));
  const hashes: string[] = [];
  const names = incomeTaxBuckets(pack, v.presetId);
  for (const bucket of names) {
    onStep(t('settingDue', { what: bucket }));
    hashes.push(await wallet.signAndSend(chain.client.setDueOp(v.vault, { bucket, fromPeriod: from, toPeriod: to, day })));
  }
  const taxYear = dayString(n.taxYearStart + 86_400n);
  const kept = (v.notices ?? []).filter((x) => x.taxYear !== taxYear);
  v.notices = [...kept, ...names.map((bucket) => ({ bucket, fromPeriod: from, toPeriod: to, date: n.date, amount: n.amount?.toString(), taxYear, readAt: new Date().toISOString() }))];
  saveVault(v);
  return hashes;
}

/** Owner: schedules a payment to the tax destination that runs by itself on `at`. */
export function schedulePayment(chain: Chain, wallet: Wallet, v: VaultInfo, at: bigint, items: ScheduledItem[]): Promise<string> {
  return wallet.signAndSend(chain.client.scheduleOp(v.vault, { at, payments: items, to: chain.cfg.taxAccount }));
}

export function cancelScheduled(chain: Chain, wallet: Wallet, v: VaultInfo, id: number): Promise<string> {
  return wallet.signAndSend(chain.client.cancelScheduledOp(v.vault, id));
}

/** Anyone (here, this browser's fee payer): runs the scheduled payments whose date has come. */
export async function runDueScheduled(chain: Chain, s: Snapshot, v: VaultInfo): Promise<number> {
  const now = BigInt(Math.floor(Date.now() / 1000));
  let n = 0;
  for (const p of s.scheduled.filter((x) => x.at <= now)) {
    await chain.sendAs(chain.feePayer, chain.client.runScheduledOp(v.vault, p.id));
    n++;
  }
  return n;
}

/** The text of a notice the user picked: a PDF (its text layer) or a text/email file. */
export async function noticeText(file: File): Promise<string> {
  if (!/pdf/i.test(file.type) && !file.name.toLowerCase().endsWith('.pdf')) return file.text();
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const parts: string[] = [];
  for (let i = 1; i <= Math.min(doc.numPages, 12); i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    parts.push(content.items.map((it) => ('str' in it ? it.str : '')).join(' '));
  }
  return parts.join('\n');
}

/** Owner: returns to the wallet what is left in the buckets of a period that are past their due date. */
export function releaseDue(chain: Chain, wallet: Wallet, v: VaultInfo, h: Pick<Held, 'period' | 'token'>): Promise<string> {
  return wallet.signAndSend(chain.client.releaseOp(v.vault, h.period, h.token));
}

/** Owner: keep the reserve in euros, through the deployment's swapper and Reflector's fiat oracle. */
export async function proposeEuroReserve(chain: Chain, wallet: Wallet, v: VaultInfo): Promise<string> {
  const conv = chain.cfg.conversion;
  if (!conv) throw new Error(t('errNoConversion'));
  const hash = await wallet.signAndSend(
    chain.client.proposeConversionOp(v.vault, {
      fromToken: chain.cfg.tokens.usd.contract,
      toToken: chain.cfg.tokens.eur.contract,
      swapper: conv.swapper,
      oracle: conv.oracle,
      fromPrice: { other: 'USD' },
      toPrice: { other: 'EUR' },
      maxSlippageBps: 100,
      // Testnet's oracle updates less often than mainnet's.
      maxAgeSecs: 86_400n,
    }),
  );
  return rememberMine(v, hash);
}

/** Anyone (here, the fee payer): swap the period's dollar reserve into euros. */
export function convertNow(chain: Chain, v: VaultInfo, period: number): Promise<string> {
  return chain.sendAs(chain.feePayer, chain.client.convertOp(v.vault, period));
}

/** Owner: follow the on-chain registry for the country's standard VAT. */
export function followLaw(chain: Chain, wallet: Wallet, v: VaultInfo, country: string): Promise<string> {
  return wallet.signAndSend(chain.client.followOp(v.vault, { registry: chain.cfg.registry, country, rate: 'standard', maxBps: 3000 }));
}

export function units(x: bigint): number {
  return Number(x) / Number(UNIT);
}

export const money = (x: bigint, cur: '€' | 'USDC' | 'EURC' | '' = '') =>
  `${fmtNumber(units(x), { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${cur ? ` ${cur}` : ''}`;

export { Keypair };

// ---- Paying from another chain (Circle's CCTP) ----

/** A burn sent on another chain whose payment into the vault has not been made yet. */
export interface PendingCrossChain {
  vault: string;
  sourceDomain: number;
  chainName: string;
  burnTx: string;
  explorer: string;
}

const PENDING = 'kyros.cctp.pending';

export function pendingCrossChain(): PendingCrossChain | null {
  const raw = store.get(PENDING);
  try {
    return raw ? (JSON.parse(raw) as PendingCrossChain) : null;
  } catch {
    return null;
  }
}

/**
 * The client pays `amount` (Stellar units) into `vault` from an EVM chain:
 * their wallet approves and burns USDC there; once Circle attests the burn,
 * this browser's fee payer submits the mint-and-pay on Stellar.
 */
export async function payFromOtherChain(
  chain: Chain,
  evm: EvmWallet,
  from: EvmChain,
  p: { vault: string; reference?: Uint8Array; amount: bigint },
  onStep: (s: string) => void,
): Promise<{ burnTx: string; stellarTx: string }> {
  const cctp = chain.cfg.cctp;
  if (!cctp) throw new Error(t('noCrossChain'));
  onStep(t('xcSwitching', { chain: from.name }));
  await evm.useChain(from);
  const feeBps = await fastFeeBps('testnet', from.domain);
  const calls = burnCalls(from, { receiver: cctp.receiver, vault: p.vault, reference: p.reference, amount: p.amount, feeBps, fast: true });
  const balance = await evm.read(from.usdc, balanceOfData(evm.address));
  if (balance < calls.amount) throw new Error(t('xcNoUsdc', { need: formatUnits6(calls.amount), have: formatUnits6(balance), chain: from.name }));
  if ((await evm.read(from.usdc, allowanceData(evm.address, from.tokenMessenger))) < calls.amount) {
    onStep(t('xcApprove'));
    await evm.send(calls.approve.to, calls.approve.data);
  }
  onStep(t('xcBurn'));
  const burnTx = await evm.send(calls.burn.to, calls.burn.data);
  const pending: PendingCrossChain = { vault: p.vault, sourceDomain: from.domain, chainName: from.name, burnTx, explorer: `${from.explorer}/tx/${burnTx}` };
  store.set(PENDING, JSON.stringify(pending));
  const stellarTx = await finishCrossChain(chain, pending, onStep);
  return { burnTx, stellarTx };
}

/** Waits for Circle's attestation of a burn and pays it into the vault. Safe to repeat. */
export async function finishCrossChain(chain: Chain, p: PendingCrossChain, onStep: (s: string) => void): Promise<string> {
  const cctp = chain.cfg.cctp;
  if (!cctp) throw new Error(t('noCrossChain'));
  onStep(t('xcAttest'));
  const a = await fetchAttestation('testnet', p.sourceDomain, p.burnTx, { timeoutMs: 20 * 60_000, onWait: () => onStep(t('xcAttest')) });
  onStep(t('xcMint'));
  await chain.ensureAccount(chain.feePayer.publicKey());
  const hash = await chain.sendAs(chain.feePayer, mintAndPayOp(cctp.receiver, a));
  store.set(PENDING, '');
  return hash;
}

export const formatUnits6 = (x: bigint) => fmtNumber(Number(x) / 1e6, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * Splits whatever has arrived at the user's payment address (the inbox):
 * anyone may call `sweep`, so this browser's fee payer does it as soon as
 * the app sees a balance there. Returns how many tokens were swept.
 */
export async function sweepInbox(chain: Chain, v: VaultInfo): Promise<number> {
  let n = 0;
  for (const inbox of [v.inbox, v.abroadInbox, ...Object.values(v.shopInboxes ?? {})].filter((x): x is string => !!x))
    for (const token of [...chain.dollarTokens, chain.cfg.tokens.eur.contract]) {
      let bal = 0n;
      try {
        bal = await chain.client.balance(token, inbox);
      } catch {
        continue;
      }
      if (bal <= 0n) continue;
      await chain.sendAs(chain.feePayer, chain.client.sweepOp(inbox, token));
      n++;
    }
  return n;
}

// ---- Clients abroad ----
//
// The chain does not say where a payer is. So the user has two payment
// addresses: the usual one (VAT reserved, the safe side) and one for clients
// abroad (no VAT), made the first time it is needed. Wallets that pay the
// second one are remembered; if one of them later pays the usual address, the
// app offers to take that VAT back (a correction that applies by itself after
// the vault's notice) and registers the wallet's terms in the vault, so its
// payments through a link or from another chain split right from then on.

/** Makes the address for clients abroad: a second inbox (fee payer) whose payments the vault books without VAT (owner signs). */
export async function ensureAbroadInbox(chain: Chain, wallet: Wallet, v: VaultInfo, onStep: (s: string) => void): Promise<VaultInfo> {
  if (v.abroadInbox) return v;
  const cfg = chain.cfg;
  onStep(t('stepInbox'));
  await chain.ensureAccount(chain.feePayer.publicKey());
  const inbox = await chain.client.deployInbox(chain.feePayer, Buffer.from(cfg.wasm.inbox, 'hex'), v.vault);
  onStep(t('abroadSigning'));
  await wallet.signAndSend(chain.client.expectPayerOp(v.vault, inbox.contractId, abroadTerms(v.rule)));
  const next = { ...v, abroadInbox: inbox.contractId };
  saveVault(next);
  return next;
}

/** A payment from a wallet known to be abroad that came in with VAT reserved. */
export interface AbroadSuspect {
  id: string;
  from: string;
  token: string;
  period: number;
  gross: bigint;
  /** The VAT reserved for it that can still be taken back (at most what the bucket holds). */
  vat: bigint;
  at: string;
}

/** Remembers the wallets that paid the address for clients abroad. Returns whether anything changed. */
export function learnAbroadPayers(v: VaultInfo, s: Snapshot): boolean {
  const known = new Set(v.abroadPayers ?? []);
  const before = known.size;
  for (const x of s.transfers.abroad) known.add(x.from);
  if (known.size === before) return false;
  v.abroadPayers = [...known];
  saveVault(v);
  return true;
}

/** Payments from wallets known to be abroad that reserved VAT, not yet settled. */
export function abroadSuspects(v: VaultInfo, s: Snapshot): AbroadSuspect[] {
  const abroad = new Set([...(v.abroadPayers ?? []), ...s.transfers.abroad.map((x) => x.from)]);
  const settled = new Set(v.settled ?? []);
  if (!abroad.size || !s.periodKind || v.rule.vatBps === 0) return [];
  const kind = s.periodKind;
  const out: AbroadSuspect[] = [];
  // Held VAT left per period and token, so two suspects never ask for more than there is.
  const left = new Map<string, bigint>();
  for (const h of s.held) if (h.bucket === 'vat') left.set(`${h.period}|${h.token}`, (left.get(`${h.period}|${h.token}`) ?? 0n) + h.amount);
  for (const c of s.corrections) if (c.bucket === 'vat') left.set(`${c.period}|${c.token}`, (left.get(`${c.period}|${c.token}`) ?? 0n) - c.amount);
  const take = (id: string, from: string, token: string, period: number, gross: bigint, vat: bigint, at: string) => {
    if (settled.has(id) || vat <= 0n) return;
    const k = `${period}|${token}`;
    const avail = left.get(k) ?? 0n;
    const amount = vat < avail ? vat : avail;
    if (amount <= 0n) return;
    left.set(k, avail - amount);
    out.push({ id, from, token, period, gross, vat: amount, at });
  };
  // Sent straight to the usual address (the inbox splits it by the vault's rule).
  for (const x of s.transfers.general)
    if (abroad.has(x.from)) take(x.id, x.from, x.token, periodOf(kind, BigInt(Math.floor(new Date(x.closedAt).getTime() / 1000))), x.amount, split(v.rule, x.amount).vat, x.closedAt);
  // Paid through a link or the Router from that wallet.
  for (const e of s.events)
    if (e.kind === 'received' && e.from && abroad.has(e.from) && e.token && e.period !== undefined)
      take(`${e.txHash}:${e.from}`, e.from, e.token, e.period, e.gross ?? 0n, e.vat ?? 0n, e.closedAt);
  return out;
}

function settle(v: VaultInfo, id: string): void {
  v.settled = [...new Set([...(v.settled ?? []), id])].slice(-200);
  saveVault(v);
}

/** Owner: takes a suspect's VAT back (after the notice) and books that wallet's next payments without VAT. */
export async function reclaimAbroadVat(chain: Chain, wallet: Wallet, v: VaultInfo, x: AbroadSuspect, onStep: (s: string) => void): Promise<void> {
  onStep(t('reclaiming'));
  rememberMine(v, await wallet.signAndSend(chain.client.proposeCorrectionOp(v.vault, { period: x.period, token: x.token, bucket: 'vat', amount: x.vat })));
  settle(v, x.id);
  let known = null;
  try {
    known = await chain.client.payerTerms(v.vault, x.from);
  } catch {
    known = null;
  }
  if (!known) {
    onStep(t('rememberClient'));
    await wallet.signAndSend(chain.client.expectPayerOp(v.vault, x.from, abroadTerms(v.rule)));
  }
  v.abroadPayers = [...new Set([...(v.abroadPayers ?? []), x.from])];
  saveVault(v);
}

/** The user says this payment did owe VAT: keep it, and stop treating that wallet as abroad. */
export function keepVat(v: VaultInfo, x: AbroadSuspect): void {
  v.abroadPayers = (v.abroadPayers ?? []).filter((a) => a !== x.from);
  settle(v, x.id);
}

/** Anyone (here, this browser's fee payer): applies the corrections whose notice has passed. */
export async function applyReadyCorrections(chain: Chain, s: Snapshot, v: VaultInfo): Promise<number> {
  const now = BigInt(Math.floor(Date.now() / 1000));
  let n = 0;
  for (const c of s.corrections.filter((x) => x.readyAt <= now)) {
    await chain.sendAs(chain.feePayer, chain.client.applyCorrectionOp(v.vault, c.id));
    n++;
  }
  return n;
}

export function cancelCorrection(chain: Chain, wallet: Wallet, v: VaultInfo, id: number): Promise<string> {
  return wallet.signAndSend(chain.client.cancelCorrectionOp(v.vault, id));
}

// ---- Changing country ----

const sameRule = (a: Rule, b: Rule) => a.vatBps === b.vatBps && JSON.stringify(a.buckets.map((x) => [x.name, x.bps])) === JSON.stringify(b.buckets.map((x) => [x.name, x.bps]));
const nowSecs = () => BigInt(Math.floor(Date.now() / 1000));
const dayStart = (d: string) => BigInt(Math.floor(Date.parse(`${d}T00:00:00Z`) / 1000));

/** The vault's calendar as `scheduleMove` takes it. */
function calendarPeriod(k: PeriodKind): CalendarPeriod | 'Seconds' {
  return k.kind === 'Months' ? (`Months${k.months}` as CalendarPeriod) : k.kind;
}

/** What a move to `pack` on `date` means for this vault: the new rule and preset, and how it is done. */
export async function planMove(chain: Chain, v: VaultInfo, s: Snapshot, pack: RulePack, region: string | undefined, date: string): Promise<{ move: PendingMove; schedule: MoveSchedule; plan: Plan }> {
  const answers = { ...v.answers, packId: pack.id, region };
  const plan = makePlan(pack, answers);
  const conf = s.periodKind && s.dues ? { period: s.periodKind, dues: s.dues } : await chain.client.config(v.vault);
  const schedule = scheduleMove(
    { period: calendarPeriod(conf.period), dues: conf.dues, following: !!s.feed, noticeSecs: BigInt(chain.cfg.noticeSecs) },
    { pack, presetId: plan.setup.presetId, reserves: plan.rule.buckets },
    date,
  );
  const rule = schedule.plan.rule;
  const move: PendingMove = {
    packId: pack.id,
    region,
    presetId: plan.setup.presetId,
    rule,
    date,
    kind: schedule.plan.sameVault ? 'rule' : 'vault',
    // Another calendar: the payment address moves a notice after it is signed, so it is signed a notice before the day.
    ...(schedule.plan.sameVault ? {} : { signFrom: String(dayStart(date) - BigInt(chain.cfg.noticeSecs)) }),
    wasFollowing: !!s.feed,
  };
  return { move, schedule, plan: { ...plan, rule } };
}

/** Whether the move can be signed now (another calendar: only from the notice before the day). */
export function canSignMove(m: PendingMove): boolean {
  return m.kind === 'rule' || BigInt(m.signFrom ?? '0') <= nowSecs();
}

/** Owner: signs the move. Same calendar: the rule for the day. Another calendar: a new vault and the payment address moving to it. */
export async function signMove(chain: Chain, wallet: Wallet, v: VaultInfo, m: PendingMove, onStep: (s: string) => void): Promise<VaultInfo> {
  const hashes: string[] = [];
  const c = chain.client;
  const next: VaultInfo = { ...v, move: { ...m } };
  if (m.kind === 'rule') {
    if (m.wasFollowing) {
      onStep(t('moveStepUnfollow'));
      hashes.push(await wallet.signAndSend(c.unfollowOp(v.vault)));
    }
    onStep(t('moveStepRule'));
    hashes.push(rememberMine(next, await wallet.signAndSend(c.proposeRuleAtOp(v.vault, m.rule, dayStart(m.date)))));
    const at = dayStart(m.date);
    const earliest = nowSecs() + BigInt(chain.cfg.noticeSecs);
    next.move = { ...m, readyAt: String(at > earliest ? at : earliest), hashes, signedAt: new Date().toISOString() };
  } else {
    const pack = await loadPack(m.packId);
    const cfg = chain.cfg;
    const fp = chain.feePayer;
    onStep(t('stepFeePayer'));
    await chain.ensureAccount(fp.publicKey());
    onStep(t('moveStepVault'));
    const terms = termsFromPack(pack, m.presetId, new Date(`${m.date}T00:00:00Z`), { holidayRegistry: cfg.registry || undefined });
    const nv = await c.deployVault(fp, Buffer.from(cfg.wasm.vault, 'hex'), {
      owner: wallet.address,
      rule: m.rule,
      taxDestination: cfg.taxAccount,
      noticeSecs: BigInt(cfg.noticeSecs),
      period: terms.period,
      dues: terms.dues,
      tokens: [...chain.dollarTokens, cfg.tokens.eur.contract],
    });
    if (v.abroadInbox) {
      // The address for clients abroad keeps booking without VAT in the new vault.
      onStep(t('abroadSigning'));
      hashes.push(await wallet.signAndSend(c.expectPayerOp(nv.contractId, v.abroadInbox, abroadTerms(m.rule))));
    }
    // The addresses for selling online keep their VAT rate in the new vault.
    for (const [bps, inbox] of Object.entries(v.shopInboxes ?? {})) hashes.push(await wallet.signAndSend(shopInboxTermsOp(c, nv.contractId, inbox, Number(bps), m.rule)));
    onStep(t('moveStepInbox'));
    hashes.push(rememberMine(next, await wallet.signAndSend(c.proposeVaultOp(v.inbox, nv.contractId))));
    if (v.abroadInbox) hashes.push(rememberMine(next, await wallet.signAndSend(c.proposeVaultOp(v.abroadInbox, nv.contractId))));
    for (const inbox of Object.values(v.shopInboxes ?? {})) hashes.push(rememberMine(next, await wallet.signAndSend(c.proposeVaultOp(inbox, nv.contractId))));
    next.move = { ...m, newVault: nv.contractId, readyAt: String(nowSecs() + BigInt(cfg.noticeSecs)), hashes, signedAt: new Date().toISOString() };
  }
  saveVault(next);
  return next;
}

/** Saves a move that cannot be signed yet (another calendar, before the notice). */
export function keepMove(v: VaultInfo, m: PendingMove): VaultInfo {
  const next = { ...v, move: m };
  saveVault(next);
  return next;
}

/** Owner: withdraws a move before it takes effect (or forgets one not signed yet). */
export async function cancelMove(chain: Chain, wallet: Wallet, v: VaultInfo): Promise<VaultInfo> {
  const m = v.move;
  if (m?.signedAt) {
    if (m.kind === 'rule') await wallet.signAndSend(chain.client.cancelChangeOp(v.vault));
    else {
      await wallet.signAndSend(chain.client.cancelMoveOp(v.inbox));
      if (v.abroadInbox) await wallet.signAndSend(chain.client.cancelMoveOp(v.abroadInbox));
      for (const inbox of Object.values(v.shopInboxes ?? {})) await wallet.signAndSend(chain.client.cancelMoveOp(inbox));
    }
  }
  const next = { ...v };
  delete next.move;
  saveVault(next);
  return next;
}

/**
 * Once a signed move has taken effect on chain, the app switches to it:
 * the new rule and country, or the new vault (the earlier one is kept, with
 * its reserves, under `previous`). Returns null while it has not.
 */
export async function finishMove(chain: Chain, v: VaultInfo, s: Snapshot): Promise<VaultInfo | null> {
  const m = v.move;
  if (!m?.signedAt || v.archivedOf || BigInt(m.readyAt ?? '0') > nowSecs()) return null;
  const answers = { ...v.answers, packId: m.packId, region: m.region };
  if (m.kind === 'rule') {
    if (!s.rule || !sameRule(s.rule, m.rule)) {
      console.info('[move] the vault does not apply the new rule yet');
      return null;
    }
    const next: VaultInfo = { ...v, answers, presetId: m.presetId, rule: m.rule };
    delete next.move;
    saveVault(next);
    return next;
  }
  const now = m.newVault ? await chain.client.inboxVault(v.inbox) : '';
  if (!m.newVault || now !== m.newVault) {
    console.info('[move] the payment address still pays into', now, 'not yet', m.newVault);
    return null;
  }
  const { previous = [], move: _m, ...old } = v;
  const next: VaultInfo = {
    vault: m.newVault,
    inbox: v.inbox,
    abroadInbox: v.abroadInbox,
    abroadPayers: v.abroadPayers,
    shopInboxes: v.shopInboxes,
    owner: v.owner,
    answers,
    rule: m.rule,
    presetId: m.presetId,
    createdAt: new Date().toISOString(),
    deployedAt: v.deployedAt,
    mine: v.mine,
    previous: [{ ...old }, ...previous],
  };
  saveVault(next);
  return next;
}

/** The app shows an earlier vault (to pay its taxes and release what is left). */
export function viewPrevious(current: VaultInfo, prev: VaultInfo): VaultInfo {
  return { ...prev, archivedOf: current.vault };
}

// ---- Selling online (a shop or an x402 API) ----

/**
 * Makes the seller's payment addresses for selling online, one per VAT rate:
 * each an inbox (made by the fee payer) whose payments the vault splits with
 * that VAT and the vault's income-tax reserve (the owner signs once per rate).
 */
export async function addShopInboxes(chain: Chain, wallet: Wallet, v: VaultInfo, rates: number[], onStep: (s: string) => void): Promise<VaultInfo> {
  const next: VaultInfo = { ...v, shopInboxes: { ...(v.shopInboxes ?? {}) } };
  await chain.ensureAccount(chain.feePayer.publicKey());
  for (const [i, bps] of rates.filter((r) => !next.shopInboxes![r]).entries()) {
    onStep(t('shopStep', { pct: fmtNumber(bps / 100), i: i + 1 }));
    const inbox = await chain.client.deployInbox(chain.feePayer, Buffer.from(chain.cfg.wasm.inbox, 'hex'), v.vault);
    await wallet.signAndSend(shopInboxTermsOp(chain.client, v.vault, inbox.contractId, bps, v.rule));
    next.shopInboxes![bps] = inbox.contractId;
    saveVault(next);
  }
  return next;
}

/** What the seller pastes into the WooCommerce plugin or an x402 server. */
export function shopConfig(chain: Chain, v: VaultInfo): ShopConfig {
  const usd = chain.cfg.tokens.usd;
  return {
    network: chain.cfg.network,
    asset: { code: usd.code, issuer: usd.issuer, contract: usd.contract },
    inboxes: v.shopInboxes ?? {},
    vault: v.vault,
  };
}
