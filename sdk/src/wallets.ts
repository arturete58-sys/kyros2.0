/**
 * The business's other wallets. A freelancer or a shop often gets paid in
 * more than one wallet (one for clients, one at an exchange, an old one).
 * Tax is per person, not per wallet: what those wallets receive is income of
 * the same business, so it counts for the prepayments, the deductions and the
 * reserve, even though Kyros did not split it on arrival.
 *
 * Reading only: the wallets are watched, never signed for.
 */
import type { rpc } from '@stellar/stellar-sdk';
import { transfersInto } from './events.js';
import { split, type Rule } from './split.js';
import { toUnits } from './checkout.js';

/** A classic asset the business is paid in (USDC, EURC...). */
export interface PaidAsset {
  code: string;
  issuer: string;
  /** Its Stellar Asset Contract, to read wallets that are contracts (passkey wallets). */
  contract?: string;
}

/** A payment one of the business's wallets received. */
export interface WalletPayment {
  /** Stable id (Horizon's operation id, or the RPC event id). */
  id: string;
  wallet: string;
  from: string;
  amount: bigint;
  /** The asset's code (USDC, EURC...). */
  code: string;
  at: string;
  hash: string;
}

export interface HorizonRecord {
  id: string;
  type: string;
  created_at: string;
  transaction_hash: string;
  transaction_successful?: boolean;
  from?: string;
  to?: string;
  amount?: string;
  asset_code?: string;
  asset_issuer?: string;
  asset_balance_changes?: { type?: string; from?: string; to?: string; amount?: string; asset_code?: string; asset_issuer?: string; code?: string; issuer?: string }[];
}

/** The payments into `wallet` among Horizon's payment records, in the given assets. */
export function paymentsFromHorizon(wallet: string, records: HorizonRecord[], assets: PaidAsset[]): WalletPayment[] {
  const known = (code?: string, issuer?: string) => assets.find((a) => a.code === code && a.issuer === issuer);
  const out: WalletPayment[] = [];
  for (const r of records) {
    if (r.transaction_successful === false) continue;
    if ((r.type === 'payment' || r.type.startsWith('path_payment')) && r.to === wallet && r.from && r.amount) {
      const a = known(r.asset_code, r.asset_issuer);
      if (a) out.push({ id: r.id, wallet, from: r.from, amount: toUnits(r.amount), code: a.code, at: r.created_at, hash: r.transaction_hash });
    } else if (r.type === 'invoke_host_function') {
      (r.asset_balance_changes ?? []).forEach((c, i) => {
        const a = known(c.asset_code ?? c.code, c.asset_issuer ?? c.issuer);
        if (a && c.type === 'transfer' && c.to === wallet && c.from && c.amount) out.push({ id: `${r.id}-${i}`, wallet, from: c.from, amount: toUnits(c.amount), code: a.code, at: r.created_at, hash: r.transaction_hash });
      });
    }
  }
  return out;
}

/**
 * What an account (G...) received since `since` (ISO date), from Horizon:
 * payments, path payments and Stellar Asset Contract transfers.
 */
export async function walletPaymentsHorizon(horizon: string, wallet: string, assets: PaidAsset[], since: string, o: { fetch?: typeof fetch; maxPages?: number } = {}): Promise<WalletPayment[]> {
  const f = o.fetch ?? fetch;
  let url: string | null = `${horizon.replace(/\/$/, '')}/accounts/${wallet}/payments?order=desc&limit=200&include_failed=false`;
  const out: WalletPayment[] = [];
  for (let page = 0; url && page < (o.maxPages ?? 10); page++) {
    const res: Response = await f(url);
    if (res.status === 404) return out;
    if (!res.ok) throw new Error(`Horizon: HTTP ${res.status}`);
    const j = (await res.json()) as { _embedded?: { records?: HorizonRecord[] }; _links?: { next?: { href?: string } } };
    const records = j._embedded?.records ?? [];
    out.push(...paymentsFromHorizon(wallet, records.filter((r) => r.created_at >= since), assets));
    if (!records.length || records[records.length - 1].created_at < since) break;
    url = j._links?.next?.href ?? null;
  }
  return out;
}

/** What a contract wallet (C..., a passkey wallet) received lately, from the RPC's events (its retention window only). */
export async function walletPaymentsRpc(server: rpc.Server, wallet: string, assets: PaidAsset[], startLedger: number): Promise<WalletPayment[]> {
  const withContract = assets.filter((a): a is PaidAsset & { contract: string } => !!a.contract);
  const rows = await transfersInto(server, withContract.map((a) => a.contract), wallet, startLedger);
  return rows.map((r) => ({ id: r.id, wallet, from: r.from, amount: r.amount, code: withContract.find((a) => a.contract === r.token)?.code ?? '', at: r.closedAt, hash: r.txHash }));
}

/**
 * The payments that are the business's income: not between its own wallets,
 * not from its Kyros vaults and addresses (what Kyros already counted), not
 * ones the user said are not income, and inside [from, to).
 */
export function outsideIncome(payments: WalletPayment[], o: { own: Iterable<string>; notIncome?: Iterable<string>; from?: string; to?: string }): { payments: WalletPayment[]; total: bigint } {
  const own = new Set(o.own);
  const skip = new Set(o.notIncome ?? []);
  const seen = new Set<string>();
  const list = payments.filter((p) => {
    if (seen.has(p.id)) return false;
    seen.add(p.id);
    return !own.has(p.from) && !skip.has(p.id) && (!o.from || p.at >= o.from) && (!o.to || p.at < o.to);
  });
  return { payments: list, total: list.reduce((a, p) => a + p.amount, 0n) };
}

/** What Kyros would have set aside from those payments with the vault's rule: VAT and income-tax reserve. */
export function pendingReserve(rule: Rule, payments: WalletPayment[]): { vat: bigint; reserve: bigint; total: bigint } {
  let vat = 0n;
  let total = 0n;
  for (const p of payments) {
    const s = split(rule, p.amount);
    vat += s.vat;
    total += s.reserve;
  }
  return { vat, reserve: total - vat, total };
}

/** A deposit into the vault: reserve set aside after the fact, booked to a period and bucket (not income). */
export interface ReserveDeposit {
  period: number;
  token: string;
  bucket: string;
  amount: bigint;
}

/**
 * The deposits that set aside, for payments the vault did not split, what it
 * would have: each payment's VAT into `vat` and its income-tax parts into the
 * rule's buckets, in the period `periodFor` gives (the payment's own, or the
 * current one once that period's VAT is past due), in the payment's token.
 * Payments in a token `tokenOf` does not know are skipped.
 */
export function outsideDeposits(rule: Rule, payments: WalletPayment[], periodFor: (at: string) => number, tokenOf: (code: string) => string | undefined): ReserveDeposit[] {
  const out = new Map<string, ReserveDeposit>();
  const add = (period: number, token: string, bucket: string, amount: bigint) => {
    if (amount <= 0n) return;
    const k = `${period}|${token}|${bucket}`;
    const d = out.get(k) ?? { period, token, bucket, amount: 0n };
    d.amount += amount;
    out.set(k, d);
  };
  for (const p of payments) {
    const token = tokenOf(p.code);
    if (!token) continue;
    const period = periodFor(p.at);
    const s = split(rule, p.amount);
    add(period, token, 'vat', s.vat);
    rule.buckets.forEach((b, i) => add(period, token, b.name, s.parts[i]));
  }
  return [...out.values()].sort((a, b) => a.period - b.period || (a.bucket < b.bucket ? -1 : 1));
}
