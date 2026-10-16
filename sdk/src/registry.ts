/**
 * Keeping the on-chain Rate Registry in step with the rule packs, and moving
 * a user to another country.
 *
 * The rule packs are the reviewed source of truth (each rate with the date it
 * applies from and its official sources). `registrySyncPlan` compares a pack
 * with what the registry holds and lists what the publisher has to sign:
 * rates to seed, future changes to publish (at least the registry's notice
 * ahead), entries to withdraw (a reform voted down) and changes already too
 * close to publish in time, which vault owners must apply themselves.
 */
import type { Rule } from './split.js';
import { validateRule } from './split.js';
import { presetVatBps, type CalendarPeriod, type RulePack } from './rulepacks.js';

export interface RegistryEntry {
  /** UNIX seconds the rate applies from. */
  from: bigint;
  bps: number;
}

const toUnix = (d: string) => BigInt(Date.parse(`${d}T00:00:00Z`) / 1000);
const toDay = (s: bigint) => new Date(Number(s) * 1000).toISOString().slice(0, 10);

/**
 * The dated entries a pack implies for each rate name, oldest first. Only
 * enacted tables count; a proposal is never published. When a rate ends (it
 * is missing from a later table), its goods fall back to that table's
 * `standard` rate, so a vault following it moves with them.
 */
export function registryEntries(pack: RulePack): Record<string, RegistryEntry[]> {
  const tables = (pack.vatRates ?? []).filter((t) => !t.proposed).sort((a, b) => (a.from < b.from ? -1 : 1));
  const out: Record<string, RegistryEntry[]> = {};
  const names = new Set(tables.flatMap((t) => Object.keys(t.rates)));
  for (const name of names) {
    const list: RegistryEntry[] = [];
    let seen = false;
    for (const t of tables) {
      const bps = t.rates[name] ?? (seen ? t.rates.standard : undefined);
      if (bps === undefined) continue;
      seen = true;
      if (list.length && list[list.length - 1].bps === bps) continue;
      list.push({ from: toUnix(t.from), bps });
    }
    out[name] = list;
  }
  return out;
}

export type SyncAction =
  | { kind: 'seed'; rate: string; bps: number }
  | { kind: 'publish'; rate: string; from: bigint; bps: number; day: string }
  | { kind: 'withdraw'; rate: string; from: bigint; day: string }
  /** A change that applies sooner than the registry's notice: it cannot be published in time. */
  | { kind: 'late'; rate: string; from: bigint; bps: number; day: string };

/**
 * What the publisher signs so the registry matches the pack. `onChain` holds
 * the registry's current schedule per rate name (empty or missing = unknown).
 */
export function registrySyncPlan(
  pack: RulePack,
  onChain: Record<string, RegistryEntry[]>,
  now: bigint,
  minNoticeSecs: bigint,
): SyncAction[] {
  const want = registryEntries(pack);
  const actions: SyncAction[] = [];
  for (const [rate, entries] of Object.entries(want)) {
    const have = onChain[rate] ?? [];
    if (!have.length) {
      const today = [...entries].reverse().find((x) => x.from <= now);
      if (today) actions.push({ kind: 'seed', rate, bps: today.bps });
    }
    for (const x of entries.filter((x) => x.from > now)) {
      const same = have.find((h) => h.from === x.from);
      if (same && same.bps === x.bps) continue;
      if (x.from < now + minNoticeSecs) actions.push({ kind: 'late', rate, from: x.from, bps: x.bps, day: toDay(x.from) });
      else actions.push({ kind: 'publish', rate, from: x.from, bps: x.bps, day: toDay(x.from) });
    }
    for (const h of have.filter((h) => h.from > now)) {
      if (!entries.some((x) => x.from === h.from)) actions.push({ kind: 'withdraw', rate, from: h.from, day: toDay(h.from) });
    }
  }
  return actions;
}

export interface CountryChoice {
  pack: RulePack;
  presetId: string;
  /** The user's own reserves; default: the preset's buckets. */
  reserves?: { name: string; bps: number }[];
}

export interface CountryChangePlan {
  /** True when the calendars match and the same vault can take the new rule. */
  sameVault: boolean;
  rule: Rule;
  period: CalendarPeriod;
  dueOffsetSecs: bigint;
  /** Rate to follow in the registry for the new country, when the preset charges a named VAT rate. */
  follow?: { country: string; rate: string };
  /** What the owner does, in order. */
  steps: string[];
}

/**
 * Moving to another country. If the new country uses the same calendar, the
 * vault takes the new rule with the usual notice. Otherwise the user gets a
 * new vault built from the new pack and moves their inbox to it: the payment
 * address stays the same, and the old vault keeps its reserves and releases
 * them on its own due dates, so no locked money is moved.
 */
export function changeCountryPlan(
  current: { period: CalendarPeriod | 'Seconds'; dueOffsetSecs: bigint; following?: boolean },
  next: CountryChoice,
  date: Date | string = new Date(),
): CountryChangePlan {
  const p = next.pack.presets.find((x) => x.id === next.presetId);
  if (!p) throw new Error(`no preset ${next.presetId} in ${next.pack.id}`);
  const rule: Rule = {
    vatBps: presetVatBps(next.pack, next.presetId, date),
    buckets: (next.reserves ?? p.buckets).map(({ name, bps }) => ({ name, bps })),
  };
  validateRule(rule);
  const period = p.period ?? next.pack.period;
  const dueOffsetSecs = BigInt(p.dueOffsetDays ?? next.pack.dueOffsetDays) * 86_400n;
  const follow = p.vatRate ? { country: next.pack.country, rate: p.vatRate } : undefined;
  const sameVault = current.period === period && current.dueOffsetSecs === dueOffsetSecs;
  const steps: string[] = [];
  if (sameVault) {
    if (current.following) steps.push('unfollow: keep the current VAT while the new rule waits for its notice');
    steps.push(`propose_rule: VAT ${rule.vatBps / 100}% and the new reserves, applying after the notice`);
    steps.push("propose_destination: the account that pays the new country's taxes");
    if (follow) steps.push(`after the rule applies, follow ${follow.country}/${follow.rate} in the registry`);
  } else {
    steps.push(`deploy a new vault from the ${next.pack.id} pack (${period}, released ${Number(dueOffsetSecs / 86_400n)} days after each period)`);
    if (follow) steps.push(`follow ${follow.country}/${follow.rate} in the registry from the new vault`);
    steps.push('propose_vault on the inbox: the same payment address pays into the new vault after the notice');
    steps.push('Router and SEP-7 payment links: use the new vault address');
    steps.push('the old vault keeps its reserves: pay the old country\'s taxes from it and release the rest on its due dates');
  }
  return { sameVault, rule, period, dueOffsetSecs, follow, steps };
}
