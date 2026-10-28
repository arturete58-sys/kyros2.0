/**
 * Fiscal periods, the same calendar as `kyros_types` (UTC, Howard Hinnant's
 * civil-date algorithms), so the app shows the same period id and due date
 * the vault will use.
 */

export type PeriodKind = { kind: 'Month' } | { kind: 'Quarter' } | { kind: 'Year' } | { kind: 'Months'; months: number } | { kind: 'Seconds'; seconds: bigint };

/**
 * When a tax set aside in a period falls due (`kyros_types::Due`): a fixed
 * delay after the period, a day of a month after it (with one exception for
 * periods ending in a given month), or a date after the fiscal year.
 */
export type Due =
  | { after: bigint }
  | { monthDay: { months: number; day: number; exceptionMonth: number; exceptionMonths: number; exceptionDay: number } }
  | { yearDate: { fyStartMonth: number; fyStartDay: number; month: number; day: number; yearsAfter: number } };

/** Due rules per bucket (`vat`, `irpf`...), and the one for any other bucket. */
export interface Dues {
  default: Due;
  buckets: Record<string, Due>;
  /** Weekdays the tax office is closed (bit 0 Monday … bit 6 Sunday): due dates move past them. */
  closed: number;
  /** The Rate Registry and country whose published holidays move due dates, or null. */
  holidays: { registry: string; country: string } | null;
}

const DAY = 86_400n;
const floorDiv = (a: bigint, b: bigint) => (a >= 0n ? a / b : -((-a + b - 1n) / b));

export function daysFromCivil(y: bigint, m: number, d: number): bigint {
  const yy = m <= 2 ? y - 1n : y;
  const era = floorDiv(yy, 400n);
  const yoe = yy - era * 400n;
  const mp = BigInt(m > 2 ? m - 3 : m + 9);
  const doy = (153n * mp + 2n) / 5n + BigInt(d) - 1n;
  const doe = yoe * 365n + yoe / 4n - yoe / 100n + doy;
  return era * 146_097n + doe - 719_468n;
}

export function civilFromDays(z0: bigint): [bigint, number, number] {
  const z = z0 + 719_468n;
  const era = floorDiv(z, 146_097n);
  const doe = z - era * 146_097n;
  const yoe = (doe - doe / 1460n + doe / 36_524n - doe / 146_096n) / 365n;
  const doy = doe - (365n * yoe + yoe / 4n - yoe / 100n);
  const mp = (5n * doy + 2n) / 153n;
  const d = Number(doy - (153n * mp + 2n) / 5n + 1n);
  const m = Number(mp < 10n ? mp + 3n : mp - 9n);
  const y = yoe + era * 400n + (m <= 2 ? 1n : 0n);
  return [y, m, d];
}

/** Months per period for calendar kinds (undefined for fixed lengths). */
function monthsPer(kind: PeriodKind): number | undefined {
  switch (kind.kind) {
    case 'Month':
      return 1;
    case 'Quarter':
      return 3;
    case 'Year':
      return 12;
    case 'Months':
      return Math.min(Math.max(kind.months, 1), 12);
    case 'Seconds':
      return undefined;
  }
}

/** Whether the contract accepts this period kind (n-month periods need n to divide 12). */
export const validPeriod = (kind: PeriodKind): boolean =>
  kind.kind === 'Months' ? kind.months > 0 && 12 % kind.months === 0 : kind.kind === 'Seconds' ? kind.seconds > 0n : true;

/** The period id containing `ts` (Unix seconds). */
export function periodOf(kind: PeriodKind, ts: bigint): number {
  const [y, m] = civilFromDays(floorDiv(ts, DAY));
  const n = monthsPer(kind);
  if (n === undefined) return Number(ts / ((kind as { seconds: bigint }).seconds > 0n ? (kind as { seconds: bigint }).seconds : 1n));
  return Number(y * BigInt(12 / n) + BigInt(Math.floor((m - 1) / n)));
}

export function periodStart(kind: PeriodKind, id: number): bigint {
  const n = monthsPer(kind);
  if (n === undefined) {
    const len = (kind as { seconds: bigint }).seconds;
    return BigInt(id) * (len > 0n ? len : 1n);
  }
  const per = 12 / n;
  return daysFromCivil(BigInt(Math.floor(id / per)), (id % per) * n + 1, 1) * DAY;
}

export const periodEnd = (kind: PeriodKind, id: number): bigint => periodStart(kind, id + 1);

const daysInMonth = (y: bigint, m: number) =>
  Number((m === 12 ? daysFromCivil(y + 1n, 1, 1) : daysFromCivil(y, m + 1, 1)) - daysFromCivil(y, m, 1));

/** Unix seconds at the end (UTC) of day `day` of month `m` (may exceed 12) of year `y`; days past the month's end mean its last day. */
function endOfDay(y: bigint, m: number, day: number): bigint {
  const yy = y + BigInt(Math.floor((m - 1) / 12));
  const mm = (((m - 1) % 12) + 12) % 12 + 1;
  const d = Math.min(Math.max(day, 1), daysInMonth(yy, mm));
  return (daysFromCivil(yy, mm, d) + 1n) * DAY;
}

/** Whether the contract accepts a due rule. */
export function validDue(due: Due): boolean {
  const inR = (x: number, a: number, b: number) => Number.isInteger(x) && x >= a && x <= b;
  if ('after' in due) return due.after >= 0n;
  if ('monthDay' in due) {
    const d = due.monthDay;
    return inR(d.months, 0, 24) && inR(d.day, 1, 31) && inR(d.exceptionMonth, 0, 12) && inR(d.exceptionMonths, 0, 24) && (d.exceptionMonth === 0 || inR(d.exceptionDay, 1, 31));
  }
  const d = due.yearDate;
  return inR(d.fyStartMonth, 1, 12) && inR(d.fyStartDay, 1, 31) && inR(d.month, 1, 12) && inR(d.day, 1, 31) && inR(d.yearsAfter, 0, 3);
}

/** Unix seconds from which the tax of period `id` is past its due day (`kyros_types::due_at`). */
export function dueAt(kind: PeriodKind, id: number, due: Due): bigint {
  const end = periodEnd(kind, id);
  if ('after' in due) return end + due.after;
  if ('monthDay' in due) {
    const d = due.monthDay;
    const [y, m] = civilFromDays(floorDiv(end, DAY));
    const [, lastMonth] = civilFromDays(floorDiv(end - 1n, DAY));
    const [months, day] = d.exceptionMonth !== 0 && lastMonth === d.exceptionMonth ? [d.exceptionMonths, d.exceptionDay] : [d.months, d.day];
    return endOfDay(y, m + months, day);
  }
  const d = due.yearDate;
  const [y, m, dd] = civilFromDays(floorDiv(end - 1n, DAY));
  const fy = m > d.fyStartMonth || (m === d.fyStartMonth && dd >= d.fyStartDay) ? y : y - 1n;
  return endOfDay(fy + BigInt(d.yearsAfter), d.month, d.day);
}

/** The due rule of one bucket. */
export const dueOf = (dues: Dues, bucket: string): Due => dues.buckets[bucket] ?? dues.default;

/** When `bucket`'s reserve of period `id` falls due. */
export const bucketDueAt = (kind: PeriodKind, id: number, dues: Dues, bucket: string): bigint => dueAt(kind, id, dueOf(dues, bucket));

/** When all of period `id` can be released: the latest of its buckets' due dates (the vault's `due_date`). */
export function dueDate(kind: PeriodKind, id: number, dues: Dues): bigint {
  let latest = dueAt(kind, id, dues.default);
  for (const d of Object.values(dues.buckets)) {
    const t = dueAt(kind, id, d);
    if (t > latest) latest = t;
  }
  return latest;
}

/** One fixed delay after the period for every bucket. */
export const duesAfter = (secs: bigint): Dues => ({ default: { after: secs }, buckets: {}, closed: 0, holidays: null });

/** "2027-Q1", "2027-02", "2027", "2027-B1" (n-month periods) or "#29504" for fixed-length periods. */
export function periodLabel(kind: PeriodKind, id: number): string {
  switch (kind.kind) {
    case 'Months': {
      const per = 12 / kind.months;
      return `${Math.floor(id / per)}-${kind.months === 6 ? 'H' : kind.months === 4 ? 'T' : 'B'}${(id % per) + 1}`;
    }
    case 'Month':
      return `${Math.floor(id / 12)}-${String((id % 12) + 1).padStart(2, '0')}`;
    case 'Quarter':
      return `${Math.floor(id / 4)}-Q${(id % 4) + 1}`;
    case 'Year':
      return String(id);
    case 'Seconds':
      return `#${id}`;
  }
}

/** Months in one period of `kind` (a period counted in seconds counts as one month). */
export function monthsIn(kind: PeriodKind): number {
  switch (kind.kind) {
    case 'Month':
      return 1;
    case 'Quarter':
      return 3;
    case 'Year':
      return 12;
    case 'Months':
      return kind.months;
    default:
      return 1;
  }
}
