import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dueAt, periodOf as periodOfImpl, validDue, validPeriod, type Due, type Dues, type PeriodKind } from './periods.js';
import { type Rule, validateRule } from './split.js';
import type { Enforcement, Estimate, Precision, Prepayment, Region } from './estimate.js';
import { WEEKDAYS, lockAt, lockMask, payBy, type HolidayData, type Workdays } from './workdays.js';

/** How often the vault books reserves: the VAT filing period (Months2 = bimonthly, Months4 = four-monthly, Months6 = half-yearly). */
export type CalendarPeriod = 'Month' | 'Quarter' | 'Year' | 'Months2' | 'Months4' | 'Months6';

/**
 * When a tax falls due, as a rule pack writes it:
 *   `{ "days": 28 }`: 28 days after the period;
 *   `{ "monthsAfter": 0, "day": 20, "except": { "periodEndMonth": 12, "monthsAfter": 0, "day": 30 } }`:
 *     the 20th of the month after the period, but 30 January for a period ending in December;
 *   `{ "date": "06-30", "yearsAfter": 1 }`: 30 June of the year after the fiscal year starts.
 * The tax may be paid earlier; after the end of that day what is left can be released.
 */
export type DueSpec =
  | { days: number }
  | { monthsAfter: number; day: number; except?: { periodEndMonth: number; monthsAfter: number; day: number } }
  | { date: string; yearsAfter: number };

/**
 * How Kyros suggests the amount of a prepayment (see `installments.ts`):
 *   `es130`: Spain's modelo 130, exactly: `rate` x (income - expenses) of the
 *     year so far, minus what clients withheld and the earlier 130 payments;
 *   `reservedSoFar` (default): what the income-tax reserve holds for the tax year so far;
 *   `annualized`: `share` of the year's tax estimated from the reserve so far, minus what was paid;
 *   `previousYear`: `share` of last year's income tax (which the user gives once);
 *   `notice`: the amount on the tax office's notice.
 * `taxYear: -1` means the tax year before the one the date falls in.
 */
export type PrepaymentAmount =
  | { kind: 'es130'; rate: number; taxYear?: number }
  | { kind: 'reservedSoFar'; taxYear?: number }
  | { kind: 'annualized'; share: number; taxYear?: number }
  | { kind: 'previousYear'; share: number }
  | { kind: 'notice'; bucket?: string };

export interface PrepaymentDate {
  date: string;
  what: string;
  amount?: PrepaymentAmount;
}

/** A country's tax calendar: when VAT, the income-tax reserve and any other bucket fall due. */
export interface TaxCalendar {
  period: CalendarPeriod;
  /** First day of the fiscal year (MM-DD); default 01-01. */
  fiscalYearStart?: string;
  /** When the VAT of a period is due (absent: no VAT). */
  vat?: DueSpec;
  /** When the income-tax reserve (and any bucket not listed in `buckets`) is due: usually the annual payment. */
  income: DueSpec;
  /** Buckets with their own date (e.g. a monthly turnover tax). */
  buckets?: Record<string, DueSpec>;
  /** Prepayments along the year, paid from the reserve (MM-DD), with how Kyros suggests the amount. */
  prepayments?: PrepaymentDate[];
  /** What happens when a deadline falls on a weekend or public holiday. */
  workdays?: Workdays;
  note: string;
  sources?: { title: string; url: string }[];
}
/** What a preset's reserve buckets are meant to cover, for the reserve check. */
export type Coverage = 'incomeTax' | 'social';

/** The VAT, GST or sales-tax rates in force from a date, in basis points by rate name (`standard`, `reduced`, ...). */
export interface VatTable {
  /** First day the rates apply (YYYY-MM-DD, UTC). */
  from: string;
  rates: Record<string, number>;
  /** Announced or proposed, not yet law: listed by `vatChanges`, never applied by `vatRatesOn`. */
  proposed?: boolean;
  note?: string;
}

export interface RulePackPreset {
  id: string;
  label: string;
  vatBps: number;
  /** Name of the rate in the pack's `vatRates` this preset charges; the rule then follows the table's dates. */
  vatRate?: string;
  buckets: { name: string; bps: number; label?: string }[];
  /** What the buckets reserve for. Default: income tax. */
  covers?: Coverage[];
  /** Overrides the pack's estimate for this preset (e.g. a flat-rate regime). */
  estimate?: Estimate;
  /** Overrides parts of the pack's tax calendar for this preset (another regime). */
  calendar?: Partial<TaxCalendar>;
  /** Overrides the computed precision of the reserve check (see `precisionOf`). */
  precision?: Precision;
}

export interface RulePack {
  id: string;
  country: string;
  name: string;
  version: string;
  /** Date the rates were last checked against the sources (YYYY-MM-DD). */
  reviewed?: string;
  /** ISO 4217 code of the local currency the taxes are paid in. */
  currency: string;
  /** Local name of the consumption tax (VAT, GST, IVA, ...). */
  vatName?: string;
  /** Consumption-tax rate tables with the dates they apply from. */
  vatRates?: VatTable[];
  /** When each tax falls due (official deadlines, with sources). */
  calendar: TaxCalendar;
  presets: RulePackPreset[];
  /** Simplified annual tax estimate used by `checkReserve`. */
  estimate?: Estimate;
  /** How strictly late or short payment is penalised; sets the safety margin of the reserve check. */
  enforcement?: Enforcement;
  /** Who is tax resident there, and on what income. */
  residence?: Residence;
  /** How the law sets income-tax prepayments, when it does so objectively. */
  prepayment?: Prepayment;
  /** Regions with their own income tax (US states), chosen with `ReserveInput.region`. */
  regions?: Region[];
  notes?: string[];
  sources?: { title: string; url: string }[];
}

export interface VaultTerms {
  rule: Rule;
  period: PeriodKind;
  dues: Dues;
}

function packDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const d of [join(here, '..', 'rule-packs'), join(here, '..', '..', 'rule-packs'), join(here, '..', '..', '..', 'rule-packs')]) {
    if (existsSync(join(d, 'es.json'))) return d;
  }
  throw new Error('rule-packs directory not found');
}

/** Ids of the bundled rule packs (`ad`, `ae`, `ch`, `de`, `es`, ...). */
export function listRulePacks(): string[] {
  return readdirSync(packDir())
    .filter((f) => f.endsWith('.json') && f !== 'schema.json')
    .map((f) => f.slice(0, -5))
    .sort();
}

/** Loads a bundled rule pack by id (`es`), or any pack file by path. */
export function loadRulePack(idOrPath: string): RulePack {
  const file = idOrPath.endsWith('.json') ? idOrPath : join(packDir(), `${idOrPath}.json`);
  const pack = JSON.parse(readFileSync(file, 'utf8')) as RulePack;
  checkRulePack(pack);
  return pack;
}

const PERIODS = ['Month', 'Quarter', 'Year', 'Months2', 'Months4', 'Months6'];
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MMDD = /^(\d{2})-(\d{2})$/;

function mmdd(s: string, what: string): [number, number] {
  const m = MMDD.exec(s);
  if (!m || +m[1] < 1 || +m[1] > 12 || +m[2] < 1 || +m[2] > 31) throw new Error(`${what}: ${s} is not MM-DD`);
  return [+m[1], +m[2]];
}

/** The contract's period kind for a pack period. */
export function periodKindOf(p: CalendarPeriod): PeriodKind {
  const m = /^Months(\d+)$/.exec(p);
  return m ? { kind: 'Months', months: Number(m[1]) } : { kind: p as 'Month' | 'Quarter' | 'Year' };
}

/** The contract's due rule for a pack's due spec. */
export function dueOfSpec(spec: DueSpec, fiscalYearStart = '01-01'): Due {
  if ('days' in spec) return { after: BigInt(spec.days) * 86_400n };
  if ('date' in spec) {
    const [fm, fd] = mmdd(fiscalYearStart, 'fiscalYearStart');
    const [m, d] = mmdd(spec.date, 'due date');
    return { yearDate: { fyStartMonth: fm, fyStartDay: fd, month: m, day: d, yearsAfter: spec.yearsAfter } };
  }
  return {
    monthDay: {
      months: spec.monthsAfter,
      day: spec.day,
      exceptionMonth: spec.except?.periodEndMonth ?? 0,
      exceptionMonths: spec.except?.monthsAfter ?? 0,
      exceptionDay: spec.except?.day ?? 0,
    },
  };
}

/** The pack's calendar with the preset's overrides. */
export function calendarOf(pack: RulePack, presetId: string): TaxCalendar {
  const p = pack.presets.find((x) => x.id === presetId);
  if (!p) throw new Error(`no preset ${presetId} in ${pack.id}`);
  const o = p.calendar ?? {};
  const c = { ...pack.calendar, ...o, buckets: { ...(pack.calendar.buckets ?? {}), ...(o.buckets ?? {}) } };
  // A preset without VAT has no VAT date.
  if (p.vatBps === 0 && !p.vatRate) delete c.vat;
  return c;
}

/** The vault's due rules for a calendar: VAT, the named buckets, and the income date for everything else. */
export function duesOfCalendar(c: TaxCalendar, holidays: Dues['holidays'] = null): Dues {
  const fy = c.fiscalYearStart ?? '01-01';
  const buckets: Record<string, Due> = {};
  if (c.vat) buckets.vat = dueOfSpec(c.vat, fy);
  for (const [k, v] of Object.entries(c.buckets ?? {})) buckets[k] = dueOfSpec(v, fy);
  return { default: dueOfSpec(c.income, fy), buckets, closed: lockMask(c.workdays), holidays };
}

/** Loads the holidays generated for a bundled pack (`rule-packs/holidays/<id>.json`). */
export function loadHolidays(id: string): HolidayData | undefined {
  const f = join(packDir(), 'holidays', `${id}.json`);
  return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as HolidayData) : undefined;
}

function checkCalendar(id: string, c: TaxCalendar): void {
  if (!c || !PERIODS.includes(c.period)) throw new Error(`${id}: calendar period ${c?.period}`);
  if (!c.note) throw new Error(`${id}: calendar note`);
  if (!validPeriod(periodKindOf(c.period))) throw new Error(`${id}: period ${c.period}`);
  const d = duesOfCalendar(c);
  for (const due of [d.default, ...Object.values(d.buckets)]) if (!validDue(due)) throw new Error(`${id}: due rule ${JSON.stringify(due, (_, v) => (typeof v === 'bigint' ? String(v) : v))}`);
  for (const pp of c.prepayments ?? []) {
    mmdd(pp.date, `${id}: prepayment`);
    const a = pp.amount;
    if (a && !['es130', 'reservedSoFar', 'annualized', 'previousYear', 'notice'].includes(a.kind)) throw new Error(`${id}: prepayment amount ${a.kind}`);
    if (a && 'share' in a && !(a.share > 0 && a.share <= 1)) throw new Error(`${id}: prepayment share ${a.share}`);
  }
  const w = c.workdays;
  if (w) {
    if (!['next', 'previous', 'none'].includes(w.rule)) throw new Error(`${id}: workdays rule ${w.rule}`);
    if (!w.closed.every((d) => WEEKDAYS.includes(d))) throw new Error(`${id}: workdays closed ${w.closed}`);
    for (const x of w.extra ?? []) mmdd(x, `${id}: workdays extra`);
    if (!w.note) throw new Error(`${id}: workdays note`);
    if (w.verified && !(w.sources ?? []).length) throw new Error(`${id}: verified workdays need a source`);
  }
}

export function checkRulePack(pack: RulePack): void {
  if (!pack.id || !pack.country || !Array.isArray(pack.presets) || pack.presets.length === 0) throw new Error('incomplete rule pack');
  checkCalendar(pack.id, pack.calendar);
  if (!/^[A-Z]{3}$/.test(pack.currency ?? '')) throw new Error(`${pack.id}: currency must be an ISO 4217 code`);
  if (pack.reviewed !== undefined && !DAY.test(pack.reviewed)) throw new Error(`${pack.id}: reviewed must be YYYY-MM-DD`);
  for (const t of pack.vatRates ?? []) {
    if (!DAY.test(t.from)) throw new Error(`${pack.id}: VAT table date ${t.from}`);
    for (const [k, v] of Object.entries(t.rates)) {
      if (!Number.isInteger(v) || v < 0 || v > 10_000) throw new Error(`${pack.id}: VAT rate ${k} ${v}`);
    }
  }
  const ids = new Set<string>();
  for (const p of pack.presets) {
    if (ids.has(p.id)) throw new Error(`${pack.id}: duplicate preset ${p.id}`);
    ids.add(p.id);
    if (p.calendar) checkCalendar(`${pack.id}/${p.id}`, calendarOf(pack, p.id));
    if (p.vatRate && !(pack.vatRates ?? []).some((t) => p.vatRate! in t.rates)) throw new Error(`${pack.id}/${p.id}: no VAT rate ${p.vatRate}`);
    validateRule({ vatBps: p.vatBps, buckets: p.buckets.map(({ name, bps }) => ({ name, bps })) });
  }
}

function day(date: Date | string): string {
  return typeof date === 'string' ? date : date.toISOString().slice(0, 10);
}

/** The VAT table in force on a date (enacted tables only), or undefined before the first one. */
export function vatTableOn(pack: RulePack, date: Date | string = new Date()): VatTable | undefined {
  const d = day(date);
  return (pack.vatRates ?? [])
    .filter((t) => !t.proposed && t.from <= d)
    .sort((a, b) => (a.from < b.from ? 1 : -1))[0];
}

/** The consumption-tax rates in force on a date, by name, in basis points. */
export function vatRatesOn(pack: RulePack, date: Date | string = new Date()): Record<string, number> {
  return { ...(vatTableOn(pack, date)?.rates ?? {}) };
}

/** Rate tables that start after `after` and up to `until`, including announced or proposed ones, oldest first. */
export function vatChanges(pack: RulePack, after: Date | string = new Date(), until?: Date | string): VatTable[] {
  const a = day(after);
  const u = until === undefined ? '9999-12-31' : day(until);
  return (pack.vatRates ?? []).filter((t) => t.from > a && t.from <= u).sort((x, y) => (x.from < y.from ? -1 : 1));
}

/** The VAT a preset charges on a date: its named rate from the table in force, else its fixed `vatBps`. */
export function presetVatBps(pack: RulePack, presetId: string, date: Date | string = new Date()): number {
  const p = preset(pack, presetId);
  if (!p.vatRate) return p.vatBps;
  const rates = vatRatesOn(pack, date);
  const r = rates[p.vatRate];
  if (r === undefined) throw new Error(`${pack.id}/${p.id}: rate ${p.vatRate} is not in force on ${day(date)}`);
  return r;
}

export interface VatCheck {
  /** The vault's rule charges the rate in force. */
  upToDate: boolean;
  ruleBps: number;
  /** Rate in force on the date (undefined if the preset's rate no longer exists). */
  inForceBps?: number;
  /** Next enacted or proposed change to this preset's rate. */
  next?: { from: string; bps?: number; proposed: boolean };
}

/**
 * Compares a vault's VAT with the table: is it the rate in force, and does a change
 * come next? An app or keeper uses this to propose the new rule (`propose_rule`)
 * early enough for the vault's notice period to end before the change date.
 */
export function checkRuleVat(pack: RulePack, presetId: string, ruleVatBps: number, date: Date | string = new Date()): VatCheck {
  const p = preset(pack, presetId);
  let inForceBps: number | undefined;
  try {
    inForceBps = presetVatBps(pack, presetId, date);
  } catch {
    inForceBps = undefined;
  }
  let next: VatCheck['next'];
  if (p.vatRate) {
    for (const t of vatChanges(pack, date)) {
      const bps = t.rates[p.vatRate];
      if (bps !== (inForceBps ?? -1)) {
        next = { from: t.from, bps, proposed: !!t.proposed };
        break;
      }
    }
  }
  return { upToDate: inForceBps === ruleVatBps, ruleBps: ruleVatBps, inForceBps, next };
}

export type VatUpdateAction =
  /** The vault charges the rate in force and no enacted change is coming. */
  | 'none'
  /** Sign `propose_rule_at(rule, effectiveAt)`: the vault switches on the change date. */
  | 'schedule'
  /** The vault's rate is out of date: sign `propose_rule(rule)`, it applies after the notice. */
  | 'update'
  /** The preset's rate ends or a change is only proposed: tell the user, the choice is theirs. */
  | 'review';

export interface VatUpdatePlan {
  action: VatUpdateAction;
  /** The rule to propose, with the vault's own reserves kept. */
  rule?: Rule;
  /** UNIX seconds the new rule should take effect (for `schedule`). */
  effectiveAt?: bigint;
  /** Latest moment to sign so the notice ends by the change date. */
  signBy?: Date;
  message: string;
}

/**
 * What an app or keeper should do so a vault's VAT follows the country's table:
 * nothing, schedule a rule for the change date, update an out-of-date rule now, or
 * ask the user. The vault's reserves are never touched. Only the owner can sign
 * the change; the plan says what to put in front of them and by when.
 */
export function vatUpdatePlan(pack: RulePack, presetId: string, rule: Rule, noticeSecs: bigint | number, date: Date | string = new Date()): VatUpdatePlan {
  const check = checkRuleVat(pack, presetId, rule.vatBps, date);
  const name = pack.vatName ?? 'VAT';
  const withVat = (vatBps: number): Rule => {
    const r = { vatBps, buckets: rule.buckets.map(({ name, bps }) => ({ name, bps })) };
    validateRule(r);
    return r;
  };
  const pctOf = (bps: number) => `${bps / 100}%`;
  if (check.inForceBps === undefined) {
    return { action: 'review', message: `${name}: the rate this preset charged no longer exists; choose another rate.` };
  }
  if (!check.upToDate) {
    return {
      action: 'update',
      rule: withVat(check.inForceBps),
      message: `${name} in force is ${pctOf(check.inForceBps)} and the vault charges ${pctOf(check.ruleBps)}: sign the update now.`,
    };
  }
  const next = check.next;
  if (!next) return { action: 'none', message: `${name} ${pctOf(check.ruleBps)} is in force and no change is scheduled.` };
  if (next.proposed) {
    return { action: 'review', message: `${name} may change to ${next.bps === undefined ? 'another rate' : pctOf(next.bps)} on ${next.from}; it is not law yet, so nothing changes.` };
  }
  if (next.bps === undefined) {
    return { action: 'review', message: `${name}: this rate ends on ${next.from}; choose the rate that applies after it.` };
  }
  const effectiveAt = BigInt(Date.parse(`${next.from}T00:00:00Z`) / 1000);
  return {
    action: 'schedule',
    rule: withVat(next.bps),
    effectiveAt,
    signBy: new Date(Number(effectiveAt - BigInt(noticeSecs)) * 1000),
    message: `${name} changes from ${pctOf(check.ruleBps)} to ${pctOf(next.bps)} on ${next.from}: sign once and the vault switches that day.`,
  };
}

function preset(pack: RulePack, presetId: string): RulePackPreset {
  const p = pack.presets.find((x) => x.id === presetId);
  if (!p) throw new Error(`no preset ${presetId} in ${pack.id}; have ${pack.presets.map((x) => x.id).join(', ')}`);
  return p;
}

/** The vault terms for one preset of a pack, with the VAT in force on `date` (default: today). */
export function termsFromPack(pack: RulePack, presetId: string, date: Date | string = new Date(), opts: { holidayRegistry?: string } = {}): VaultTerms {
  const p = preset(pack, presetId);
  const c = calendarOf(pack, presetId);
  const country = typeof c.workdays?.holidays === 'object' && c.workdays.holidays.country ? c.workdays.holidays.country : pack.country;
  return {
    rule: { vatBps: presetVatBps(pack, presetId, date), buckets: p.buckets.map(({ name, bps }) => ({ name, bps })) },
    period: periodKindOf(c.period),
    dues: duesOfCalendar(c, opts.holidayRegistry ? { registry: opts.holidayRegistry, country } : null),
  };
}

/**
 * A rule the user composes: one of the country's VAT rates (by name, as in force on `date`,
 * or a fixed `vatBps`) plus the reserves the user chooses. Validated like the contract does.
 */
export function customRule(
  pack: RulePack,
  choice: { vatRate?: string; vatBps?: number; reserves: { name: string; bps: number }[] },
  date: Date | string = new Date(),
): Rule {
  let vatBps = choice.vatBps ?? 0;
  if (choice.vatRate) {
    const r = vatRatesOn(pack, date)[choice.vatRate];
    if (r === undefined) throw new Error(`${pack.id}: no ${choice.vatRate} rate in force on ${day(date)}`);
    vatBps = r;
  }
  const rule = { vatBps, buckets: choice.reserves.map(({ name, bps }) => ({ name, bps })) };
  validateRule(rule);
  return rule;
}

/** How a jurisdiction decides who is tax resident, and what it taxes them on. */
export interface Residence {
  /** `worldwide`, `territorial` (local-source income only), `remittance` (foreign income when brought in) or `none` (no personal income tax). */
  basis: 'worldwide' | 'territorial' | 'remittance' | 'none';
  /** Day threshold of the main presence test, if any. */
  days?: number;
  /** Over what the days are counted. */
  window?: string;
  /** The day test is met at exactly `days` ("183 days or more"); otherwise it needs more ("more than 183 days"). */
  inclusive?: boolean;
  /** The tests, in plain words. */
  tests: string[];
  /** Regimes for newcomers, nomads or non-domiciled residents. */
  regimes?: { name: string; summary: string }[];
  /** Citizens are taxed wherever they live (the United States). */
  citizenshipBased?: boolean;
  source?: { title: string; url: string; official?: boolean; checked?: string };
}

export interface ResidenceSituation {
  /** Days spent in each country (ISO code) in the period that country counts. */
  days: Record<string, number>;
  /** Countries where the person keeps a home available to them. */
  homes?: string[];
  /** Citizenships (ISO codes). */
  citizenships?: string[];
}

export interface ResidenceFinding {
  country: string;
  /** `likely`: a test is clearly met; `possible`: depends on facts the days alone do not show; `no`: no test met on these facts. */
  resident: 'likely' | 'possible' | 'no';
  why: string;
  basis: Residence['basis'];
  regimes: { name: string; summary: string }[];
}

/**
 * A first answer to "where do I pay income tax?" from days spent, homes and
 * citizenship, using each pack's residence tests. When more than one country
 * claims the person, the tax treaty between them decides (permanent home,
 * centre of vital interests, habitual abode, nationality); the result says so.
 * It is a guide for choosing the rule pack, not a ruling.
 */
export function residenceGuide(packs: RulePack[], s: ResidenceSituation): { findings: ResidenceFinding[]; summary: string } {
  const findings: ResidenceFinding[] = [];
  for (const p of packs) {
    const r = p.residence;
    if (!r) continue;
    const days = s.days[p.country] ?? 0;
    const home = (s.homes ?? []).includes(p.country);
    const citizen = (s.citizenships ?? []).includes(p.country);
    let resident: ResidenceFinding['resident'] = 'no';
    let why = `${days} days`;
    if (r.citizenshipBased && citizen) {
      resident = 'likely';
      why = 'citizens are taxed on worldwide income wherever they live';
    } else if (r.days !== undefined && (r.inclusive ? days >= r.days : days > r.days)) {
      resident = 'likely';
      why = `${days} days, over the ${r.days}-day test`;
    } else if (home || days > 0) {
      resident = home ? 'possible' : 'no';
      why = home ? `a home there can make you resident under its other tests (${r.tests[0]})` : `${days} days, under the day test`;
    }
    if (resident !== 'no' || days > 0 || home) findings.push({ country: p.country, resident, why, basis: r.basis, regimes: r.regimes ?? [] });
  }
  const likely = findings.filter((f) => f.resident === 'likely');
  const taxing = likely.filter((f) => f.basis !== 'none');
  const summary =
    likely.length === 0
      ? 'No country is clearly claiming you on these facts: check the other tests (home, family, centre of interests), because being resident nowhere is rarely accepted.'
      : likely.length === 1
        ? `${likely[0].country} is likely your tax residence (${likely[0].why}); use its rule pack.`
        : `${likely.map((f) => f.country).join(' and ')} may both treat you as resident: the tax treaty between them decides (permanent home, then centre of vital interests, then habitual abode, then nationality).${taxing.length < likely.length ? ' Some of them have no personal income tax.' : ''}`;
  return { findings, summary };
}

/** A tax deadline the user meets from the vault. */
export interface Deadline {
  /** The day to pay by (UTC, YYYY-MM-DD): the legal date moved for weekends and holidays the country's way, never later than the real deadline. */
  date: string;
  /** The legal date as the law writes it. */
  legal: string;
  /** When the vault releases what is left (never before the real deadline). */
  lock: string;
  /** The prepayment's amount rule, for prepayments. */
  amount?: PrepaymentAmount;
  kind: 'vat' | 'income' | 'bucket' | 'prepayment';
  /** The bucket it pays (`vat`, `irpf`...), when one. */
  bucket?: string;
  /** The period whose reserve it pays, when one. */
  period?: number;
  what: string;
}

const dayOf = (secs: bigint) => new Date(Number(secs - 1n) * 1000).toISOString().slice(0, 10);

/**
 * The deadlines from `from` over the next `days` days for a vault built from
 * `pack`/`presetId`: each period's VAT and other buckets, the annual income-tax
 * payments and the prepayments, sorted by date.
 */
export function upcomingDeadlines(pack: RulePack, presetId: string, from: Date = new Date(), days = 400, holidays?: HolidayData): Deadline[] {
  const c = calendarOf(pack, presetId);
  const kind = periodKindOf(c.period);
  const dues = duesOfCalendar(c);
  const p = pack.presets.find((x) => x.id === presetId)!;
  const start = BigInt(Math.floor(from.getTime() / 1000));
  const end = start + BigInt(days) * 86_400n;
  const out: Deadline[] = [];
  const seen = new Set<string>();
  const add = (d: Deadline) => {
    const k = `${d.legal}|${d.kind}|${d.bucket ?? ''}|${d.what}`;
    if (!seen.has(k)) seen.add(k), out.push(d);
  };
  // Periods ending up to three years back can still fall due in the window (annual returns).
  const step = kind.kind === 'Months' ? kind.months : kind.kind === 'Month' ? 1 : kind.kind === 'Quarter' ? 3 : 12;
  const now = periodOfTs(kind, start);
  const back = Math.ceil(40 / step);
  const names = ['vat', ...p.buckets.map((b) => b.name)];
  for (let id = now - back; id <= now + Math.ceil(days / 28 / step); id++) {
    for (const b of names) {
      if (b === 'vat' && !c.vat) continue;
      const due = dueAt(kind, id, b === 'vat' ? dues.buckets.vat : dues.buckets[b] ?? dues.default);
      const by = payBy(due, c.workdays, holidays);
      if (by <= start || by - 86_400n > end) continue;
      add({ date: dayOf(by), legal: dayOf(due), lock: dayOf(lockAt(due, c.workdays, holidays)), kind: b === 'vat' ? 'vat' : b in (c.buckets ?? {}) ? 'bucket' : 'income', bucket: b, period: id, what: b === 'vat' ? (pack.vatName ?? 'VAT') : (p.buckets.find((x) => x.name === b)?.label ?? b) });
    }
  }
  for (const pp of c.prepayments ?? []) {
    const [m, d] = mmdd(pp.date, 'prepayment');
    for (let y = from.getUTCFullYear(); y <= from.getUTCFullYear() + Math.ceil(days / 365); y++) {
      const t = BigInt(Date.UTC(y, m - 1, d) / 1000) + 86_400n;
      const by = payBy(t, c.workdays, holidays);
      if (by > start && by - 86_400n <= end) add({ date: dayOf(by), legal: dayOf(t), lock: dayOf(lockAt(t, c.workdays, holidays)), kind: 'prepayment', what: pp.what, amount: pp.amount });
    }
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

function periodOfTs(kind: PeriodKind, ts: bigint): number {
  // Local import cycle-free copy of periods.periodOf.
  return periodOfImpl(kind, ts);
}
