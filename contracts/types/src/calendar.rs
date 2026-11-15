//! Fiscal periods and due dates, in UTC, after Howard Hinnant's civil-date
//! algorithms.
//!
//! Dates are plain integer arithmetic over a bounded domain: ledger times
//! before the year 9999, periods of at most ten years and due dates at most
//! four years after a period. Every result stays far inside i64 and u64, so
//! this module is exempt from the crate-wide `arithmetic_side_effects` lint;
//! the property tests in `test.rs` cover the whole domain, and the release
//! profile keeps `overflow-checks` on as a backstop.
#![allow(clippy::arithmetic_side_effects)]
use crate::*;

/// How the vault groups reserves into fiscal periods. Calendar periods use
/// UTC; `Months(n)` are n-month periods from January (2: bimonthly, 4:
/// four-monthly, 6: half-yearly; n divides 12); `Seconds` is a fixed length
/// counted from the Unix epoch (testing and non-calendar regimes).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PeriodKind {
    /// Calendar months.
    Month,
    /// Calendar quarters.
    Quarter,
    /// Calendar years.
    Year,
    /// A fixed length in seconds, from the Unix epoch.
    Seconds(u64),
    /// n-month periods from January (n divides 12).
    Months(u32),
}

/// A due date set as a day of a month after the period ends. `months` counts
/// from the month right after the period (0: that month, e.g. "the 20th of
/// the month after the quarter"; 1: the month after it). A period whose last
/// month is `exception_month` (1-12; 0 for none) has its own date instead,
/// e.g. Spain's fourth-quarter VAT, due on 30 January rather than the 20th
/// (exception_month 12), or Portugal's second-quarter VAT, due in September.
/// Days past the end of a month mean its last day.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MonthDay {
    /// Months after the one right after the period (0-24).
    pub months: u32,
    /// Day of that month (1-31; past its end means its last day).
    pub day: u32,
    /// The period's last month that has its own date (1-12), or 0.
    pub exception_month: u32,
    /// `months` for that period.
    pub exception_months: u32,
    /// `day` for that period.
    pub exception_day: u32,
}

/// A due date fixed in the calendar after the fiscal year that contains the
/// period, e.g. the annual income-tax payment: 30 June of the following year
/// in Spain, 31 January two years after the tax year starts in the UK. The
/// fiscal year starts on `fy_start_month`/`fy_start_day` (1/1 for a calendar
/// year, 4/6 in the UK); `years_after` counts from the year it starts in.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct YearDate {
    /// Month the fiscal year starts (1-12).
    pub fy_start_month: u32,
    /// Day the fiscal year starts (1-31).
    pub fy_start_day: u32,
    /// Month of the due date (1-12).
    pub month: u32,
    /// Day of the due date (1-31; past the month's end means its last day).
    pub day: u32,
    /// Years after the year the fiscal year starts in (0-3).
    pub years_after: u32,
}

/// When a tax set aside in a period falls due. The reserve can be paid at any
/// time and only released to the owner after the end of its due day (UTC).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Due {
    /// A fixed number of seconds after the period ends.
    After(u64),
    /// A day of a month after the period ends.
    MonthDay(MonthDay),
    /// A date after the fiscal year that contains the period.
    YearDate(YearDate),
}

const DAY: i64 = 86_400;

/// Days since 1970-01-01 for a proleptic Gregorian date.
pub fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = (if y >= 0 { y } else { y - 399 }) / 400;
    let yoe = y - era * 400;
    let mp = (if m > 2 { m - 3 } else { m + 9 }) as i64;
    let doy = (153 * mp + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// (year, month 1-12, day 1-31) for days since 1970-01-01.
pub fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = (if z >= 0 { z } else { z - 146_096 }) / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    (y, m, d)
}

/// The longest fixed-length period (ten years).
pub const MAX_PERIOD_SECS: u64 = 10 * 366 * 86_400;

/// Whether a period kind is usable: `Months(n)` needs n to divide 12, and
/// `Seconds` a length from a minute to `MAX_PERIOD_SECS`.
pub fn valid_period(kind: &PeriodKind) -> bool {
    match kind {
        PeriodKind::Months(n) => *n > 0 && 12 % *n == 0,
        // From a minute to ten years: longer ones overflow the clock.
        PeriodKind::Seconds(len) => (60..=MAX_PERIOD_SECS).contains(len),
        _ => true,
    }
}

/// Months per period for calendar kinds (`None` for `Seconds`).
fn months_per(kind: &PeriodKind) -> Option<i64> {
    match kind {
        PeriodKind::Month => Some(1),
        PeriodKind::Quarter => Some(3),
        PeriodKind::Year => Some(12),
        PeriodKind::Months(n) => Some((*n).clamp(1, 12) as i64),
        PeriodKind::Seconds(_) => None,
    }
}

/// The id of the period containing `ts` (Unix seconds): year*12+month-1 for
/// months, year*4+quarter-1 for quarters, the year for years,
/// year*(12/n)+(month-1)/n for n-month periods, ts/len for fixed lengths.
pub fn period_of(kind: &PeriodKind, ts: u64) -> u32 {
    let (y, m, _) = civil_from_days(ts as i64 / DAY);
    match months_per(kind) {
        Some(n) => (y * (12 / n) + (m as i64 - 1) / n) as u32,
        None => match kind {
            PeriodKind::Seconds(len) => (ts / (*len).max(1)) as u32,
            _ => 0,
        },
    }
}

/// Unix seconds at which period `id` starts.
pub fn period_start(kind: &PeriodKind, id: u32) -> u64 {
    let id = id as i64;
    let (y, m) = match months_per(kind) {
        Some(n) => (id / (12 / n), ((id % (12 / n)) * n) as u32 + 1),
        None => match kind {
            PeriodKind::Seconds(len) => return id as u64 * (*len).max(1),
            _ => return 0,
        },
    };
    (days_from_civil(y, m, 1) * DAY) as u64
}

/// Unix seconds at which period `id` ends (the start of the next one).
pub fn period_end(kind: &PeriodKind, id: u32) -> u64 {
    period_start(kind, id + 1)
}

fn days_in_month(y: i64, m: u32) -> u32 {
    let (ny, nm) = if m == 12 { (y + 1, 1) } else { (y, m + 1) };
    (days_from_civil(ny, nm, 1) - days_from_civil(y, m, 1)) as u32
}

/// Unix seconds at the end (UTC) of day `day` of month `m` of year `y`, with
/// `m` allowed past 12 and `day` past the month's length (its last day).
fn end_of_day(y: i64, m: i64, day: u32) -> u64 {
    let y = y + (m - 1).div_euclid(12);
    let m = ((m - 1).rem_euclid(12) + 1) as u32;
    let d = day.clamp(1, days_in_month(y, m));
    ((days_from_civil(y, m, d) + 1) * DAY) as u64
}

/// The longest a tax may fall due after its period ends with `Due::After`
/// (four years: no tax waits longer, and the clock cannot overflow).
pub const MAX_DUE_AFTER_SECS: u64 = 4 * 366 * 86_400;

/// Whether a due rule is well formed.
pub fn valid_due(due: &Due) -> bool {
    match due {
        Due::After(secs) => *secs <= MAX_DUE_AFTER_SECS,
        Due::MonthDay(md) => {
            md.months <= 24
                && (1..=31).contains(&md.day)
                && md.exception_month <= 12
                && md.exception_months <= 24
                && (md.exception_month == 0 || (1..=31).contains(&md.exception_day))
        }
        Due::YearDate(yd) => {
            (1..=12).contains(&yd.fy_start_month)
                && (1..=31).contains(&yd.fy_start_day)
                && (1..=12).contains(&yd.month)
                && (1..=31).contains(&yd.day)
                && yd.years_after <= 3
        }
    }
}

/// Unix seconds from which the tax of period `id` is past its due day.
pub fn due_at(kind: &PeriodKind, id: u32, due: &Due) -> u64 {
    let end = period_end(kind, id);
    match due {
        Due::After(secs) => end + secs,
        Due::MonthDay(md) => {
            // The month in which the next period starts, and the period's last month.
            let (y, m, _) = civil_from_days(end as i64 / DAY);
            let (_, last_month, _) = civil_from_days((end as i64 - 1) / DAY);
            let (months, day) = if md.exception_month != 0 && last_month == md.exception_month {
                (md.exception_months, md.exception_day)
            } else {
                (md.months, md.day)
            };
            end_of_day(y, m as i64 + months as i64, day)
        }
        Due::YearDate(yd) => {
            // The fiscal year containing the period's last second.
            let (y, m, d) = civil_from_days((end as i64 - 1) / DAY);
            let fy = if (m, d) >= (yd.fy_start_month, yd.fy_start_day) {
                y
            } else {
                y - 1
            };
            end_of_day(fy + yd.years_after as i64, yd.month as i64, yd.day)
        }
    }
}

/// Most days a due date can move forward over closed days and holidays. A
/// holiday list that claims more cannot keep a reserve locked longer.
pub const MAX_SHIFT_DAYS: u32 = 14;

/// Weekday of a day number (days since 1970-01-01): Monday 0 … Sunday 6.
pub fn weekday(day: u32) -> u32 {
    (day + 3) % 7
}

/// A due date (the end of the due day, as [`due_at`] gives it) moved by
/// whole days until the due day is one the tax office is open: `closed` is
/// a bitmask of weekdays (bit 0 Monday … bit 6 Sunday) and `is_holiday`
/// says whether a day number is a holiday. Moves at most [`MAX_SHIFT_DAYS`].
pub fn next_open(end: u64, closed: u32, is_holiday: impl Fn(u32) -> bool) -> u64 {
    let day = ((end - 1) / DAY as u64) as u32;
    let mut moved = 0;
    while moved < MAX_SHIFT_DAYS
        && (closed & (1 << weekday(day + moved)) != 0 || is_holiday(day + moved))
    {
        moved += 1;
    }
    end + moved as u64 * DAY as u64
}
