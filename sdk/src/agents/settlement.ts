/**
 * Settlement agent: getting the tax from the vault to the tax office's bank
 * collection in time, through a regulated Stellar anchor (SEP-24 / SEP-6).
 * Ahead of each deadline it checks what can be checked before money moves:
 *
 *   - the bank account (IBAN) the tax office collects from is well formed
 *     (country length and check digits);
 *   - the anchor offers withdrawals of the reserve's currency, and at what fee;
 *   - the anchor's account is the vault's tax destination (otherwise the
 *     vault refuses to pay it; changing it takes the notice, so it must be
 *     done early), and its memo is one a vault payment can carry;
 *   - the day to start, a few working days before the deadline, so a bank
 *     transfer lands before the tax office collects.
 *
 * Then it prepares `pay_tax_to` for each bucket due, with the anchor's
 * account and memo as a muxed address: the owner signs once and the anchor
 * pays out euros. The memo always comes from the anchor (it identifies the
 * withdrawal); the agent never makes one up.
 */
import type { xdr } from '@stellar/stellar-sdk';
import type { KyrosClient } from '../client.js';
import { anchorPayout, type AnchorInfo, type AnchorOptions, type WithdrawalTarget } from '../anchor.js';

/** IBAN lengths of the SEPA countries (and a few more), from the ISO 13616 registry. */
const IBAN_LENGTH: Record<string, number> = {
  AD: 24, AT: 20, BE: 16, BG: 22, CH: 21, CY: 28, CZ: 24, DE: 22, DK: 18, EE: 20, ES: 24, FI: 18, FR: 27, GB: 22, GI: 23, GR: 27, HR: 21, HU: 28, IE: 22, IS: 26,
  IT: 27, LI: 21, LT: 20, LU: 20, LV: 21, MC: 27, MT: 31, NL: 18, NO: 15, PL: 28, PT: 25, RO: 24, SE: 24, SI: 19, SK: 24, SM: 27, VA: 22, AE: 23, BH: 22, TR: 26, GE: 22, UA: 29, PK: 24,
};

export type IbanCheck = { ok: true; iban: string; country: string } | { ok: false; reason: 'format' | 'country' | 'length' | 'checksum' };

/** Checks an IBAN's form, its country's length and its check digits (ISO 7064 mod 97-10). */
export function checkIban(input: string): IbanCheck {
  const iban = input.replace(/[\s-]/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{8,30}$/.test(iban)) return { ok: false, reason: 'format' };
  const country = iban.slice(0, 2);
  const len = IBAN_LENGTH[country];
  if (!len) return { ok: false, reason: 'country' };
  if (iban.length !== len) return { ok: false, reason: 'length' };
  const moved = iban.slice(4) + iban.slice(0, 4);
  let rem = 0;
  for (const ch of moved) {
    const v = ch >= 'A' && ch <= 'Z' ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of v) rem = (rem * 10 + Number(d)) % 97;
  }
  return rem === 1 ? { ok: true, iban, country } : { ok: false, reason: 'checksum' };
}

export interface AnchorWithdrawInfo {
  enabled: boolean;
  feeFixed?: number;
  feePercent?: number;
  minAmount?: number;
  maxAmount?: number;
}

/** What the anchor says about withdrawing `assetCode` (its SEP-24 or SEP-6 `/info`). */
export async function anchorWithdrawInfo(a: AnchorInfo, assetCode: string, o: AnchorOptions = {}): Promise<AnchorWithdrawInfo> {
  const f = o.fetch ?? fetch;
  const server = a.transferServerSep24 ?? a.transferServer;
  if (!server) return { enabled: false };
  const r = await f(`${server}/info`);
  if (!r.ok) throw new Error(`${a.homeDomain} /info: HTTP ${r.status}`);
  const j = (await r.json()) as { withdraw?: Record<string, { enabled?: boolean; fee_fixed?: number; fee_percent?: number; min_amount?: number; max_amount?: number }> };
  const w = j.withdraw?.[assetCode];
  return w ? { enabled: !!w.enabled, feeFixed: w.fee_fixed, feePercent: w.fee_percent, minAmount: w.min_amount, maxAmount: w.max_amount } : { enabled: false };
}

/** The working day `n` working days before `date` (Saturdays and Sundays skipped; holidays as given). */
export function workingDaysBefore(date: string, n: number, holidays: string[] = []): string {
  let t = Date.parse(`${date}T00:00:00Z`);
  let left = n;
  while (left > 0) {
    t -= 86_400_000;
    const d = new Date(t);
    const iso = d.toISOString().slice(0, 10);
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6 && !holidays.includes(iso)) left--;
  }
  return new Date(t).toISOString().slice(0, 10);
}

export type SettlementIssue =
  | { kind: 'iban'; reason: Exclude<IbanCheck, { ok: true }>['reason'] }
  | { kind: 'withdrawals-off' }
  | { kind: 'below-minimum'; min: number }
  | { kind: 'destination-differs'; anchor: string; destination: string }
  | { kind: 'memo-type'; memoType: string }
  | { kind: 'late'; startBy: string };

export interface SettlementCheck {
  /** The day to start the withdrawal by. */
  startBy: string;
  issues: SettlementIssue[];
  /** Fee the anchor charges on `amount`, if it says. */
  fee?: number;
}

/**
 * Pre-flight check for paying `amount` (in the reserve's currency) due on
 * `deadline` through the anchor. `leadDays`: working days the bank transfer
 * needs before the deadline (default 3).
 */
export function checkSettlement(i: {
  iban: string;
  amount: number;
  deadline: string;
  today: string;
  info: AnchorWithdrawInfo;
  taxDestination: string;
  target?: Pick<WithdrawalTarget, 'account' | 'memo' | 'memoType'>;
  leadDays?: number;
  holidays?: string[];
}): SettlementCheck {
  const issues: SettlementIssue[] = [];
  const ib = checkIban(i.iban);
  if (!ib.ok) issues.push({ kind: 'iban', reason: ib.reason });
  if (!i.info.enabled) issues.push({ kind: 'withdrawals-off' });
  if (i.info.minAmount !== undefined && i.amount < i.info.minAmount) issues.push({ kind: 'below-minimum', min: i.info.minAmount });
  if (i.target) {
    if (i.target.account !== i.taxDestination) issues.push({ kind: 'destination-differs', anchor: i.target.account, destination: i.taxDestination });
    if (i.target.memo && i.target.memoType && i.target.memoType !== 'id') issues.push({ kind: 'memo-type', memoType: i.target.memoType });
  }
  const startBy = workingDaysBefore(i.deadline, i.leadDays ?? 3, i.holidays);
  if (startBy < i.today) issues.push({ kind: 'late', startBy });
  const fee = i.info.feeFixed !== undefined || i.info.feePercent !== undefined ? (i.info.feeFixed ?? 0) + (i.amount * (i.info.feePercent ?? 0)) / 100 : undefined;
  return { startBy, issues, fee };
}

/**
 * The owner's `pay_tax_to` operations for the buckets due, to the anchor's
 * account with its memo (as a muxed address). Throws when the anchor's
 * account is not the vault's tax destination, or its memo cannot be carried.
 */
export function settlementOps(
  client: KyrosClient,
  vault: string,
  taxDestination: string,
  target: WithdrawalTarget,
  items: { period: number; token: string; bucket: string; amount: bigint }[],
): xdr.Operation[] {
  const to = anchorPayout(target, taxDestination);
  return items.map((x) => client.payTaxToOp(vault, { ...x, to }));
}
