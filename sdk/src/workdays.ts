/**
 * Working days: when a tax deadline falls on a weekend or public holiday.
 *
 * Each rule pack says what its country does (`calendar.workdays`): the
 * deadline moves to the next working day (`next`), must be met the working
 * day before (`previous`), or stays (`none`). Holidays come from
 * `rule-packs/holidays/<cc>.json` (generated from the `holidays` package):
 * `pay` are the ones that move the date shown for paying, `lock` every
 * holiday of the country and its regions.
 *
 * Two dates come out of a legal due date:
 * - `payBy`: the day to pay on. It is never later than the real deadline:
 *   with `next` it moves forward over the country's own holidays only, and
 *   with `previous` or `none` it moves back to the last working day (banks
 *   do not move money on closed days).
 * - `lockAt`: when the vault releases the reserve. It is never earlier than
 *   the real deadline wherever the user lives: forward over weekends and
 *   every regional holiday (what the vault computes on-chain, `next_open`).
 */
import { civilFromDays, daysFromCivil } from './periods.js';

export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
export const WEEKDAYS: Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

export interface Workdays {
  rule: 'next' | 'previous' | 'none';
  /** Weekdays on which the deadline legally moves (`next`) or the office is closed. */
  closed: Weekday[];
  /** Which holidays move the date: national (default), every region's (`union`), or one subdivision. */
  holidays?: 'national' | 'union' | { country?: string; subdiv?: string };
  /** Extra closed days every year (MM-DD), e.g. Japan's 29 December to 3 January. */
  extra?: string[];
  /** Whether the rule was checked against an official or professional source. */
  verified: boolean;
  note: string;
  sources?: { title: string; url: string }[];
}

export interface HolidayData {
  source: string;
  country: string;
  years: Record<string, { pay: string[]; lock: string[] }>;
}

/** Most days a date moves (the vault's `MAX_SHIFT_DAYS`). */
export const MAX_SHIFT_DAYS = 14;
const DAY = 86_400n;

/** Monday 0 … Sunday 6, for a day number (days since 1970-01-01). */
export const weekday = (day: number): number => (((day + 3) % 7) + 7) % 7;

/** A bitmask of weekdays (bit 0 Monday … bit 6 Sunday). */
export const maskOf = (days: Weekday[]): number => days.reduce((m, d) => m | (1 << WEEKDAYS.indexOf(d)), 0);

/** The vault's mask: the country's closed days plus Saturday and Sunday. */
export const lockMask = (w?: Workdays): number => (w ? maskOf([...w.closed, 'sat', 'sun']) : 0);

/** The day numbers of a holiday set. */
export function holidayDays(data: HolidayData | undefined, which: 'pay' | 'lock'): Set<number> {
  const out = new Set<number>();
  for (const [y, sets] of Object.entries(data?.years ?? {}))
    for (const md of sets[which]) out.add(Number(daysFromCivil(BigInt(y), Number(md.slice(0, 2)), Number(md.slice(3)))));
  return out;
}

/** Holiday day numbers in one year, for publishing to the Rate Registry (the `lock` set). */
export function registryHolidays(data: HolidayData, year: number): number[] {
  const sets = data.years[String(year)];
  return sets ? sets.lock.map((md) => Number(daysFromCivil(BigInt(year), Number(md.slice(0, 2)), Number(md.slice(3))))).sort((a, b) => a - b) : [];
}

const closedOn = (day: number, mask: number, hol: Set<number>) => (mask & (1 << weekday(day))) !== 0 || hol.has(day);

/** `kyros_types::next_open`: `end` (the end of the due day) moved forward past closed days, at most 14. */
export function nextOpen(end: bigint, mask: number, hol: Set<number>): bigint {
  const day = Number((end - 1n) / DAY);
  let moved = 0;
  while (moved < MAX_SHIFT_DAYS && closedOn(day + moved, mask, hol)) moved++;
  return end + BigInt(moved) * DAY;
}

/** `end` moved back to the end of the last open day on or before the due day. */
export function previousOpen(end: bigint, mask: number, hol: Set<number>): bigint {
  const day = Number((end - 1n) / DAY);
  let moved = 0;
  while (moved < MAX_SHIFT_DAYS && closedOn(day - moved, mask, hol)) moved++;
  return end - BigInt(moved) * DAY;
}

/** When the vault releases a reserve whose legal due date ends at `end`. */
export const lockAt = (end: bigint, w: Workdays | undefined, data?: HolidayData): bigint =>
  w ? nextOpen(end, lockMask(w), holidayDays(data, 'lock')) : end;

/** The end of the day to pay on, for a legal due date ending at `end`. */
export function payBy(end: bigint, w: Workdays | undefined, data?: HolidayData): bigint {
  if (!w) return end;
  if (w.rule === 'next') return nextOpen(end, maskOf(w.closed), holidayDays(data, 'pay'));
  return previousOpen(end, maskOf([...w.closed, 'sat', 'sun']), holidayDays(data, 'lock'));
}

/** YYYY-MM-DD of the day ending at `end`. */
export function dayString(end: bigint): string {
  const [y, m, d] = civilFromDays((end - 1n) / DAY);
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
