/**
 * Fiscal periods, the same calendar as `kyros_types` (UTC, Howard Hinnant's
 * civil-date algorithms), so the app shows the same period id and due date
 * the vault will use.
 */

export type PeriodKind = { kind: 'Month' } | { kind: 'Quarter' } | { kind: 'Year' } | { kind: 'Seconds'; seconds: bigint };

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

/** The period id containing `ts` (Unix seconds). */
export function periodOf(kind: PeriodKind, ts: bigint): number {
  const [y, m] = civilFromDays(floorDiv(ts, DAY));
  switch (kind.kind) {
    case 'Month':
      return Number(y * 12n + BigInt(m - 1));
    case 'Quarter':
      return Number(y * 4n + BigInt(Math.floor((m - 1) / 3)));
    case 'Year':
      return Number(y);
    case 'Seconds':
      return Number(ts / (kind.seconds > 0n ? kind.seconds : 1n));
  }
}

export function periodStart(kind: PeriodKind, id: number): bigint {
  const n = BigInt(id);
  switch (kind.kind) {
    case 'Month':
      return daysFromCivil(n / 12n, Number(n % 12n) + 1, 1) * DAY;
    case 'Quarter':
      return daysFromCivil(n / 4n, Number(n % 4n) * 3 + 1, 1) * DAY;
    case 'Year':
      return daysFromCivil(n, 1, 1) * DAY;
    case 'Seconds':
      return n * (kind.seconds > 0n ? kind.seconds : 1n);
  }
}

export const periodEnd = (kind: PeriodKind, id: number): bigint => periodStart(kind, id + 1);

/** Unix seconds from which a period's reserve can be released to the owner. */
export const dueDate = (kind: PeriodKind, id: number, dueOffsetSecs: bigint): bigint => periodEnd(kind, id) + dueOffsetSecs;

/** "2027-Q1", "2027-02", "2027" or "#29504" for fixed-length periods. */
export function periodLabel(kind: PeriodKind, id: number): string {
  switch (kind.kind) {
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
