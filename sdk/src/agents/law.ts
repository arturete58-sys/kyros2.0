/**
 * Law agent: turns what the weekly law watch finds into reviewable changes,
 * and prepares (never signs) what the Rate Registry's publisher signs.
 *
 *   1. Findings with an unambiguous fix — the European Commission's TEDB
 *      lists a different standard VAT rate in force today — become an edit
 *      to the rule pack: a new dated VAT table. A person reviews the pull
 *      request (the date the change applied from, the reduced rates) before
 *      it is merged; nothing reaches a vault from here.
 *   2. Public holidays: the holiday files are regenerated from the newest
 *      `holidays` release (the workflow runs the generator).
 *   3. The registry: what the publisher must sign so the on-chain registry
 *      matches the merged packs — rates to seed or publish (at least the
 *      registry's notice ahead), entries to withdraw, holidays to set or add —
 *      as transactions prepared for the publisher's key, which stays offline.
 */
import { Contract, xdr } from '@stellar/stellar-sdk';
import { prepareSequence } from './prepare.js';
import type { KyrosClient } from '../client.js';
import { registryEntries, registrySyncPlan, type RegistryEntry, type SyncAction } from '../registry.js';
import type { RulePack, VatTable } from '../rulepacks.js';
import { registryHolidays, type HolidayData } from '../workdays.js';

/** A rate the official source lists differently from the pack, today. */
export interface VatFinding {
  pack: string;
  country: string;
  /** The rate name in the pack (`standard`...). */
  rate: string;
  /** The pack's rate in force, bps. */
  packBps?: number;
  /** The official rate(s) of that kind, bps. */
  officialBps: number[];
  source: string;
}

export interface PackEdit {
  pack: string;
  /** What changed, in one line, for the pull request. */
  summary: string;
  /** The pack after the change. */
  after: RulePack;
}

const inForce = (pack: RulePack, day: string): VatTable | undefined =>
  (pack.vatRates ?? []).filter((t) => !t.proposed && t.from <= day).sort((a, b) => (a.from < b.from ? 1 : -1))[0];

/**
 * The pack edits the findings justify. Only a standard rate with exactly one
 * official value is changed (a new table from `day`, the other rates kept);
 * anything else is left to the person reviewing the report.
 */
export function vatEdits(packs: RulePack[], findings: VatFinding[], day: string): { edits: PackEdit[]; left: VatFinding[] } {
  const edits: PackEdit[] = [];
  const left: VatFinding[] = [];
  for (const f of findings) {
    const pack = packs.find((p) => p.id === f.pack);
    const table = pack && inForce(pack, day);
    if (!pack || !table || f.rate !== 'standard' || f.officialBps.length !== 1 || f.officialBps[0] === table.rates.standard) {
      left.push(f);
      continue;
    }
    const after: RulePack = structuredClone(pack);
    const next: VatTable = {
      from: day,
      rates: { ...table.rates, standard: f.officialBps[0] },
      note: `${f.source} lists a standard rate of ${f.officialBps[0] / 100}% in force on ${day}. Check the date the change applied from and the reduced rates before merging.`,
    } as VatTable;
    after.vatRates = [...(after.vatRates ?? []).filter((t) => t.from !== day), next];
    after.reviewed = day;
    const [y, n] = (after.version ?? `${day.slice(0, 4)}.0`).split('.');
    after.version = `${y}.${Number(n) + 1}`;
    edits.push({ pack: pack.id, summary: `${pack.country}: standard VAT ${table.rates.standard / 100}% → ${f.officialBps[0] / 100}% (${f.source}, ${day})`, after });
  }
  return { edits, left };
}

export type HolidayAction =
  | { kind: 'set'; country: string; year: number; days: number[] }
  | { kind: 'add'; country: string; year: number; day: number }
  /** Days the registry has that the data dropped: they stay once the year has started (a vault's date can only move later). */
  | { kind: 'kept'; country: string; year: number; days: number[] };

/**
 * What the registry needs for a country's holidays: a year's whole list can
 * be replaced until the year starts; after that only future days are added.
 */
export function holidaySyncPlan(data: HolidayData, have: Record<number, number[]>, years: number[], today: number): HolidayAction[] {
  const out: HolidayAction[] = [];
  for (const y of years) {
    const want = registryHolidays(data, y);
    const got = [...(have[y] ?? [])].sort((a, b) => a - b);
    const started = Date.UTC(y, 0, 1) / 86_400_000 <= today;
    if (!got.length || !started) {
      if (JSON.stringify(got) !== JSON.stringify(want) && want.length) out.push({ kind: 'set', country: data.country, year: y, days: want });
      continue;
    }
    for (const d of want.filter((d) => !got.includes(d) && d > today)) out.push({ kind: 'add', country: data.country, year: y, day: d });
    const gone = got.filter((d) => !want.includes(d));
    if (gone.length) out.push({ kind: 'kept', country: data.country, year: y, days: gone });
  }
  return out;
}

export interface RegistryStep {
  /** One line a person reads before signing. */
  what: string;
  op: xdr.Operation;
}

export interface RegistryLawPlan {
  steps: RegistryStep[];
  /** Changes inside the registry's notice: vault owners apply them themselves (`propose_rule_at`). */
  late: SyncAction[];
  kept: HolidayAction[];
}

/**
 * Reads the registry and lists what the publisher signs so it matches the
 * packs and their holidays (this year and the next by default).
 */
export async function registryLawPlan(
  client: KyrosClient,
  registry: string,
  packs: { pack: RulePack; holidays?: HolidayData }[],
  now = BigInt(Math.floor(Date.now() / 1000)),
  years?: number[],
): Promise<RegistryLawPlan> {
  const minNotice = await client.registryMinNotice(registry);
  const today = Number(now / 86_400n);
  const y0 = new Date(Number(now) * 1000).getUTCFullYear();
  const ys = years ?? [y0, y0 + 1];
  const steps: RegistryStep[] = [];
  const late: SyncAction[] = [];
  const kept: HolidayAction[] = [];
  const doneCountries = new Set<string>();
  for (const { pack, holidays } of packs) {
    const onChain: Record<string, RegistryEntry[]> = {};
    for (const rate of Object.keys(registryEntries(pack))) onChain[rate] = await client.rateSchedule(registry, pack.country, rate);
    for (const a of registrySyncPlan(pack, onChain, now, minNotice)) {
      if (a.kind === 'late') late.push(a);
      else if (a.kind === 'seed') steps.push({ what: `${pack.country} ${a.rate}: ${a.bps / 100}% in force today`, op: client.seedRateOp(registry, pack.country, a.rate, a.bps) });
      else if (a.kind === 'publish') steps.push({ what: `${pack.country} ${a.rate}: ${a.bps / 100}% from ${a.day}`, op: client.publishRateOp(registry, pack.country, a.rate, a.from, a.bps) });
      else steps.push({ what: `${pack.country} ${a.rate}: withdraw the entry of ${a.day}`, op: client.withdrawRateOp(registry, pack.country, a.rate, a.from) });
    }
    if (!holidays || doneCountries.has(holidays.country)) continue;
    doneCountries.add(holidays.country);
    const have: Record<number, number[]> = {};
    for (const y of ys) have[y] = await client.holidays(registry, holidays.country, y);
    for (const h of holidaySyncPlan(holidays, have, ys, today)) {
      if (h.kind === 'set') steps.push({ what: `${h.country} ${h.year}: ${h.days.length} public holidays`, op: client.setHolidaysOp(registry, h.country, h.year, h.days) });
      else if (h.kind === 'add')
        steps.push({
          what: `${h.country}: add the holiday of ${new Date(h.day * 86_400_000).toISOString().slice(0, 10)}`,
          op: new Contract(registry).call('add_holiday', xdr.ScVal.scvSymbol(h.country), xdr.ScVal.scvU32(h.day)),
        });
      else kept.push(h);
    }
  }
  return { steps, late, kept };
}

/**
 * The steps as transactions for the publisher's account, simulated and
 * ready to sign, in sequence order. Nothing is signed or sent: the publisher
 * signs them with their own key.
 */
export function prepareRegistrySteps(client: KyrosClient, publisher: string, steps: RegistryStep[], timeoutSecs = 3600): Promise<{ what: string; xdr: string }[]> {
  return prepareSequence(client, publisher, steps, timeoutSecs);
}
