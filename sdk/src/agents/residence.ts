/**
 * Residence agent: counts the days a user spends in each country (from a
 * travel log the user keeps on their device: one country per day), checks
 * them against each country's residence test (its day threshold and the
 * window it counts over), warns before a threshold is crossed, and plans the
 * move: the same payment address (inbox), and the vault's rules switched to
 * the new country on the date the user's tax residence changes.
 *
 * Which country taxes a person is decided by each country's law and, when
 * two claim them, by the tax treaty between them; this is a guide for when
 * to switch the rule pack, never a ruling. It runs on the device: the log is
 * never sent anywhere.
 */
import type { Rule } from '../split.js';
import type { KyrosClient } from '../client.js';
import { residenceGuide, type RulePack, type ResidenceFinding } from '../rulepacks.js';
import { changeCountryPlan, type CountryChoice, type CountryChangePlan } from '../registry.js';
import type { CalendarPeriod } from '../rulepacks.js';
import type { Dues } from '../periods.js';
import type { xdr } from '@stellar/stellar-sdk';

/** Where the user was each day (YYYY-MM-DD → ISO country), as they logged it. */
export type DayLog = Record<string, string>;

const DAY_MS = 86_400_000;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const ms = (d: string) => Date.parse(`${d}T00:00:00Z`);

/** Days in each country between `from` and `to`, both included. */
export function daysByCountry(log: DayLog, from: string, to: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [d, c] of Object.entries(log)) if (d >= from && d <= to) out[c] = (out[c] ?? 0) + 1;
  return out;
}

/** The longest run of consecutive days in `country` ending at or before `to`. */
function longestRun(log: DayLog, country: string, to: string): number {
  const days = Object.keys(log).filter((d) => log[d] === country && d <= to).sort();
  let best = 0;
  let run = 0;
  let prev = -Infinity;
  for (const d of days) {
    const t = ms(d);
    run = t - prev === DAY_MS ? run + 1 : 1;
    best = Math.max(best, run);
    prev = t;
  }
  return best;
}

/** The window a pack counts days over, ending on `today`. */
export function residenceWindow(pack: RulePack, today: string): { from: string; to: string; kind: string } {
  const w = pack.residence?.window ?? 'calendar-year';
  const y = Number(today.slice(0, 4));
  if (w === 'tax-year') {
    const fy = pack.calendar.fiscalYearStart ?? '01-01';
    let start = `${y}-${fy}`;
    if (start > today) start = `${y - 1}-${fy}`;
    const end = iso(Date.UTC(Number(start.slice(0, 4)) + 1, Number(fy.slice(0, 2)) - 1, Number(fy.slice(3))) - DAY_MS);
    return { from: start, to: end, kind: w };
  }
  if (w === '12-months' || w === '365-days') return { from: iso(ms(today) - 364 * DAY_MS), to: today, kind: w };
  if (w === 'continuous') return { from: '0000-01-01', to: today, kind: w };
  return { from: `${y}-01-01`, to: `${y}-12-31`, kind: 'calendar-year' };
}

export interface ResidenceCount {
  country: string;
  days: number;
  /** The day threshold of its test, if it has one. */
  threshold?: number;
  inclusive?: boolean;
  window: { from: string; to: string; kind: string };
  /** Days left before the test is met (0 when it is met). */
  left?: number;
  /** If the user stays from today on, the day the test is met (within the window). */
  metOn?: string;
}

export interface ResidenceWatch {
  counts: ResidenceCount[];
  /** Countries whose test is met or will be within `warnDays` at this pace. */
  alerts: ResidenceCount[];
  findings: ResidenceFinding[];
  summary: string;
}

/**
 * Days per country against each country's test, from the log. `warnDays`:
 * how close to a threshold counts as an alert (default 30 days).
 */
export function residenceWatch(packs: RulePack[], log: DayLog, today: string, o: { homes?: string[]; citizenships?: string[]; warnDays?: number } = {}): ResidenceWatch {
  const warn = o.warnDays ?? 30;
  const counts: ResidenceCount[] = [];
  const countries = new Set(Object.values(log));
  for (const p of packs) {
    if (!countries.has(p.country) && !(o.homes ?? []).includes(p.country)) continue;
    const r = p.residence;
    const win = residenceWindow(p, today);
    const days = win.kind === 'continuous' ? longestRun(log, p.country, today) : (daysByCountry(log, win.from, win.to < today ? win.to : today)[p.country] ?? 0);
    const c: ResidenceCount = { country: p.country, days, threshold: r?.days, inclusive: r?.inclusive, window: win };
    if (r?.days !== undefined) {
      const need = r.inclusive ? r.days : r.days + 1;
      c.left = Math.max(0, need - days);
      // Staying from tomorrow on, one more day each day.
      const met = iso(ms(today) + c.left * DAY_MS);
      // A rolling window moves with the days; a calendar or tax year ends.
      const rolling = win.kind === '12-months' || win.kind === '365-days' || win.kind === 'continuous';
      if (c.left > 0 && (rolling || met <= win.to)) c.metOn = met;
    }
    counts.push(c);
  }
  counts.sort((a, b) => b.days - a.days);
  const alerts = counts.filter((c) => c.left !== undefined && c.left <= warn);
  const situation = { days: Object.fromEntries(counts.map((c) => [c.country, c.days])), homes: o.homes, citizenships: o.citizenships };
  const { findings, summary } = residenceGuide(packs, situation);
  return { counts, alerts, findings, summary };
}

/**
 * The tie-breaker that decides between two countries that both claim a
 * person as resident, in the order of the OECD Model Tax Convention
 * (article 4(2)), which most treaties follow. The treaty between the two
 * countries is what applies.
 */
export const TREATY_TIE_BREAKER = ['permanent home', 'centre of vital interests', 'habitual abode', 'nationality', 'mutual agreement between the two tax authorities'] as const;

export interface MoveSchedule {
  plan: CountryChangePlan;
  /** The day the new country's rules should apply (the residence change the user confirmed). */
  effective: string;
  /** For a new vault: the last day to propose the inbox move so it applies on `effective`, given the notice. */
  proposeBy?: string;
  /** Same calendar: the rule change, scheduled for `effective` (`propose_rule_at`). */
  ruleAt?: { rule: Rule; at: bigint };
}

/**
 * Plans the switch for a residence change on `effective`: with the same
 * calendar, the vault takes the new rule at that moment (`propose_rule_at`);
 * otherwise a new vault is created and the inbox moved to it, proposed at
 * least the notice ahead so the same payment address pays into the new
 * vault from that day.
 */
export function scheduleMove(
  current: { period: CalendarPeriod | 'Seconds'; dues: Dues; following?: boolean; noticeSecs: bigint },
  next: CountryChoice,
  effective: string,
): MoveSchedule {
  const plan = changeCountryPlan(current, next, effective);
  const at = BigInt(ms(effective) / 1000);
  if (plan.sameVault) return { plan, effective, ruleAt: { rule: plan.rule, at } };
  return { plan, effective, proposeBy: iso(Number(at - current.noticeSecs) * 1000) };
}

/** The owner's operation for a same-calendar move, effective on the day. */
export function moveRuleOp(client: KyrosClient, vault: string, s: MoveSchedule): xdr.Operation | undefined {
  return s.ruleAt ? client.proposeRuleAtOp(vault, s.ruleAt.rule, s.ruleAt.at) : undefined;
}
