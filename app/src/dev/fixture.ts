/**
 * Development only (`npm run dev`, then `#fixture-home`, `#fixture-pay`...):
 * every screen with sample data and no network, for looking at the design.
 * Not part of the production build.
 */
import { calendarOf, duesOfCalendar, periodOf, upcomingDeadlines, type HolidayData, type PeriodKind, type RulePack } from 'kyros-sdk';
import type { Snapshot, VaultInfo } from '../kyros';
import type { Wallet } from '../wallet/types';

const U = 10_000_000n;
const kind: PeriodKind = { kind: 'Quarter' };

export const fixtureWallet: Wallet = {
  kind: 'passkey',
  address: 'CDQ7XUQ3FIXTUREFIXTUREFIXTUREFIXTUREFIXTUREFIXTUREFIXT',
  label: 'Lucía Marín',
  signAndSend: async () => {
    throw new Error('vista previa: no firma');
  },
  disconnect: async () => {},
};

export function fixtureVault(): VaultInfo {
  return {
    vault: 'CBVAULTFIXTUREAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    inbox: 'CBINBOXFIXTUREAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    owner: fixtureWallet.address,
    answers: { packId: 'es', resident: 'yes', activity: 'software', client: 'business-local', revenue: 42000 },
    rule: { vatBps: 2100, buckets: [{ name: 'irpf', bps: 2000 }] },
    presetId: 'general',
    createdAt: '2026-07-02T09:00:00Z',
    deployedAt: 'fixture',
    abroadInbox: 'CBABROADFIXTUREAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    wallets: [{ address: 'GBEXCHANGEFIXTUREAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', label: 'Exchange' }],
  };
}

export function fixtureSnapshot(pack: RulePack, holidays?: HolidayData): Snapshot {
  const now = BigInt(Math.floor(Date.now() / 1000));
  const q = periodOf(kind, now);
  const usd = 'CUSDFIXTURE';
  const day = (d: string) => new Date(d).toISOString();
  return {
    spendable: { usd: 6_482_35n * (U / 100n), eur: 0n },
    reserved: { usd: 2_918_40n * (U / 100n), eur: 0n },
    buckets: { vat: { usd: 1_386_00n * (U / 100n), eur: 0n }, irpf: { usd: 1_532_40n * (U / 100n), eur: 0n } },
    held: [
      { period: q - 1, bucket: 'vat', token: usd, which: 'usd', amount: 798_00n * (U / 100n), dueAt: 1_792_540_800n, payBy: 1_792_540_800n },
      { period: q, bucket: 'vat', token: usd, which: 'usd', amount: 588_00n * (U / 100n), dueAt: 1_801_526_400n, payBy: 1_801_526_400n },
      { period: q - 1, bucket: 'irpf', token: usd, which: 'usd', amount: 760_00n * (U / 100n), dueAt: 1_814_486_400n, payBy: 1_814_486_400n },
      { period: q, bucket: 'irpf', token: usd, which: 'usd', amount: 772_40n * (U / 100n), dueAt: 1_814_486_400n, payBy: 1_814_486_400n },
    ],
    period: q,
    periodKind: kind,
    deadlines: upcomingDeadlines(pack, 'general', new Date(), 400, holidays),
    figures: [
      { id: q - 1, income: 3_800n * U, withheld: 0n, incomeHeld: 760n * U, incomePaid: 0n },
      { id: q, income: 3_862n * U, withheld: 150n * U, incomeHeld: 772n * U, incomePaid: 0n },
    ],
    scheduled: [{ id: 3, at: now + 9n * 86_400n, payments: [{ period: q - 1, token: usd, bucket: 'irpf', amount: 412n * U }], to: 'GTAX' }],
    pack,
    holidays,
    conversion: null,
    pendingConversionAt: null,
    feed: { registry: 'CREG', country: 'ES', rate: 'standard', maxBps: 3000 },
    rule: { vatBps: 2100, buckets: [{ name: 'irpf', bps: 2000 }] },
    payout: null,
    pendingPayout: null,
    fixed: [],
    pendingFixed: null,
    fixedFilled: {},
    dues: duesOfCalendar(calendarOf(pack, 'general'), { registry: 'CREG', country: 'ES' }),
    corrections: [{ id: 1, period: q, token: usd, bucket: 'vat', amount: 105n * U, readyAt: now + 5n * 86_400n }],
    // The guardian: a new tax destination nobody proposed from this device, waiting out the notice.
    guard: [{ kind: 'destination', tx: 'b'.repeat(64), at: day('2026-10-21T22:10:00Z'), readyAt: now + 20n * 3_600n, detail: 'GATTACKERFIXTUREAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', severity: 'critical', mine: false }],
    transfers: {
      // A client in Germany paid the address for clients abroad, then the usual one.
      abroad: [{ id: 't1', ledger: 5, closedAt: day('2026-09-21T10:00:00Z'), txHash: 'a1', token: usd, from: 'GCLIENTDEFIXTUREAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB', amount: 1_500n * U }],
      general: [{ id: 't2', ledger: 9, closedAt: day('2026-10-16T16:40:00Z'), txHash: 'f1', token: usd, from: 'GCLIENTDEFIXTUREAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB', amount: 1_210n * U }],
      byInbox: {},
    },
    events: [
      { ledger: 9, closedAt: day('2026-10-16T16:42:00Z'), txHash: 'f1', kind: 'received', gross: 1_210n * U, net: 800n * U, vat: 210n * U, reserve: 410n * U },
      { ledger: 8, closedAt: day('2026-10-14T09:15:00Z'), txHash: 'f2', kind: 'received', gross: 1_060n * U, net: 800n * U, vat: 210n * U, reserve: 260n * U },
      { ledger: 7, closedAt: day('2026-10-09T11:03:00Z'), txHash: 'f3', kind: 'tax_paid', amount: 798n * U, bucket: 'vat' },
      { ledger: 6, closedAt: day('2026-10-02T18:27:00Z'), txHash: 'f4', kind: 'received', gross: 2_420n * U, net: 1_600n * U, vat: 420n * U, reserve: 820n * U },
    ],
  } as unknown as Snapshot;
}

/** A vault just created: no payments yet. */
export function emptySnapshot(s: Snapshot): Snapshot {
  return { ...s, spendable: { usd: 0n, eur: 0n }, reserved: { usd: 0n, eur: 0n }, buckets: {}, held: [], figures: [], scheduled: [], events: [], feed: null, corrections: [], transfers: { general: [], abroad: [], byInbox: {} }, guard: [] };
}
