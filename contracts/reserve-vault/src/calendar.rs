//! Due dates: the rule pack's dates, weekends and holidays, and dates set by the tax office.
use crate::*;

/// Dues with one fixed delay after the period for every bucket (tests, simple regimes).
pub fn dues_after(e: &Env, secs: u64) -> Dues {
    Dues {
        default: Due::After(secs),
        buckets: Map::new(e),
        closed: 0,
        holidays: Holidays::None,
    }
}

pub(crate) fn bucket_due(d: &Dues, bucket: &Symbol) -> Due {
    d.buckets.get(bucket.clone()).unwrap_or(d.default.clone())
}

pub(crate) fn check_dues(d: &Dues, period: &PeriodKind) -> Result<(), VaultError> {
    if d.closed >= 0b111_1111 {
        return Err(VaultError::InvalidDue);
    }
    // Calendar due dates (a day of a month, a date after the fiscal year)
    // only make sense for calendar periods: a fixed-length period can end
    // after the day of its month, and its tax would be due before it ends.
    let fits = |due: &Due| {
        valid_due(due)
            && (matches!(due, Due::After(_)) || !matches!(period, PeriodKind::Seconds(_)))
    };
    if !fits(&d.default) {
        return Err(VaultError::InvalidDue);
    }
    for (_, due) in d.buckets.iter() {
        if !fits(&due) {
            return Err(VaultError::InvalidDue);
        }
    }
    Ok(())
}

/// The day number containing the last second before `end`.
pub(crate) fn day_before(end: u64) -> u32 {
    ((end - 1) / 86_400) as u32
}

/// `end` moved past closed weekdays and published holidays.
pub(crate) fn open_day(e: &Env, d: &Dues, end: u64) -> u64 {
    let mut lists: Vec<u32> = Vec::new(e);
    if let Holidays::Registry(h) = &d.holidays {
        let r = RegistryClient::new(e, &h.registry);
        let first = civil_from_days(day_before(end) as i64).0 as u32;
        let last = civil_from_days((day_before(end) + MAX_SHIFT_DAYS) as i64).0 as u32;
        for y in first..=last {
            // A registry that cannot answer moves nothing (weekends still apply).
            if let Ok(Ok(v)) = r.try_holidays(&h.country, &y) {
                lists.append(&v);
            }
        }
    }
    next_open(end, d.closed, |day| lists.contains(day))
}

/// The moment `bucket` of `period` stops being locked: the due date from the
/// rule pack (or the one the owner set from the tax office's notice), moved
/// to the next day the tax office is open.
pub(crate) fn lock_at(e: &Env, c: &Config, period: u32, bucket: &Symbol) -> u64 {
    let set: Option<u64> = e
        .storage()
        .persistent()
        .get(&Key::DueSet(period, bucket.clone()));
    let end = set.unwrap_or_else(|| due_at(&c.period, period, &bucket_due(&c.dues, bucket)));
    open_day(e, &c.dues, end)
}

#[contractimpl]
impl ReserveVault {
    /// Sets the due date of `bucket` for periods `from_period..=to_period` to
    /// the day number `day` (e.g. the payment date on the tax office's
    /// assessment notice). It still moves past closed days and holidays. A
    /// date later than the current one applies at once; an earlier one must
    /// be at least the notice period away, so the lock can never be opened
    /// sooner than that.
    pub fn set_due(
        e: Env,
        bucket: Symbol,
        from_period: u32,
        to_period: u32,
        day: u32,
    ) -> Result<(), VaultError> {
        let c = active(&e);
        c.owner.require_auth();
        if to_period < from_period || to_period - from_period >= MAX_BATCH {
            return Err(VaultError::TooMany);
        }
        let end = (day as u64 + 1) * 86_400;
        // At most ten years after the last period: a typo should not lock money for ever.
        if end > period_end(&c.period, to_period) + 3_660 * 86_400 {
            return Err(VaultError::InvalidDue);
        }
        let new_lock = open_day(&e, &c.dues, end);
        for p in from_period..=to_period {
            // The cheap check first: the lock (which may ask the registry for
            // holidays) is only read for a date inside the notice period.
            if new_lock < now(&e) + c.notice_secs && new_lock < lock_at(&e, &c, p, &bucket) {
                return Err(VaultError::DueTooSoon);
            }
        }
        for p in from_period..=to_period {
            let k = Key::DueSet(p, bucket.clone());
            e.storage().persistent().set(&k, &end);
            e.storage()
                .persistent()
                .extend_ttl(&k, TTL_THRESHOLD, PERIOD_TTL);
            let k = Key::EarliestSet(p);
            let earliest: Option<u64> = e.storage().persistent().get(&k);
            if earliest.is_none_or(|x| end < x) {
                e.storage().persistent().set(&k, &end);
            }
            e.storage()
                .persistent()
                .extend_ttl(&k, TTL_THRESHOLD, PERIOD_TTL);
        }
        bump_instance(&e);
        DueSet {
            bucket,
            from_period,
            to_period,
            day,
        }
        .publish(&e);
        Ok(())
    }
}
