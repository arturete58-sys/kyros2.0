import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PeriodKind } from './periods.js';
import { type Rule, validateRule } from './split.js';
import type { Estimate } from './estimate.js';

export type CalendarPeriod = 'Month' | 'Quarter' | 'Year';
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
  /** Overrides the pack's period for this preset. */
  period?: CalendarPeriod;
  /** Overrides the pack's due offset for this preset. */
  dueOffsetDays?: number;
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
  period: CalendarPeriod;
  dueOffsetDays: number;
  dueNote?: string;
  presets: RulePackPreset[];
  /** Simplified annual tax estimate used by `checkReserve`. */
  estimate?: Estimate;
  notes?: string[];
  sources?: { title: string; url: string }[];
}

export interface VaultTerms {
  rule: Rule;
  period: PeriodKind;
  dueOffsetSecs: bigint;
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

const PERIODS = ['Month', 'Quarter', 'Year'];
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function checkRulePack(pack: RulePack): void {
  if (!pack.id || !pack.country || !Array.isArray(pack.presets) || pack.presets.length === 0) throw new Error('incomplete rule pack');
  if (!PERIODS.includes(pack.period)) throw new Error(`unknown period ${pack.period}`);
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
    if (p.period && !PERIODS.includes(p.period)) throw new Error(`${pack.id}/${p.id}: unknown period ${p.period}`);
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
export function termsFromPack(pack: RulePack, presetId: string, date: Date | string = new Date()): VaultTerms {
  const p = preset(pack, presetId);
  return {
    rule: { vatBps: presetVatBps(pack, presetId, date), buckets: p.buckets.map(({ name, bps }) => ({ name, bps })) },
    period: { kind: p.period ?? pack.period },
    dueOffsetSecs: BigInt(p.dueOffsetDays ?? pack.dueOffsetDays) * 86_400n,
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
