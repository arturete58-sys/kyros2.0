//! Scheduled tax payments that anyone can run on their date.
use crate::*;

#[contractimpl]
impl ReserveVault {
    /// Schedules a payment to the tax destination: from `at` on, anyone can
    /// run it. `to` is the destination, or the destination as a muxed
    /// account with the anchor's memo. Each item pays at most what its
    /// bucket holds when it runs.
    pub fn schedule(
        e: Env,
        at: u64,
        payments: Vec<Payment>,
        to: MuxedAddress,
    ) -> Result<u32, VaultError> {
        let c = active(&e);
        c.owner.require_auth();
        if to.address() != c.tax_destination {
            return Err(VaultError::WrongDestination);
        }
        if payments.is_empty() || payments.len() > MAX_BATCH {
            return Err(VaultError::TooMany);
        }
        for p in payments.iter() {
            if p.amount <= 0 {
                return Err(VaultError::InvalidAmount);
            }
            if !c.tokens.contains(&p.token) {
                return Err(VaultError::TokenNotAccepted);
            }
        }
        let mut ids = scheduled_ids(&e);
        if ids.len() >= MAX_SCHEDULED {
            return Err(VaultError::TooMany);
        }
        let id: u32 = e.storage().instance().get(&Key::NextScheduled).unwrap_or(1);
        e.storage().instance().set(&Key::NextScheduled, &(id + 1));
        let k = Key::Scheduled(id);
        e.storage().persistent().set(
            &k,
            &Scheduled {
                at,
                payments: payments.clone(),
                to: to.to_strkey(),
            },
        );
        e.storage()
            .persistent()
            .extend_ttl(&k, TTL_THRESHOLD, PERIOD_TTL);
        ids.push_back(id);
        e.storage().instance().set(&Key::ScheduledIds, &ids);
        bump_instance(&e);
        PaymentScheduled { id, at, payments }.publish(&e);
        Ok(id)
    }

    /// A scheduled payment not run or cancelled yet.
    pub fn scheduled(e: Env, id: u32) -> Option<Scheduled> {
        e.storage().persistent().get(&Key::Scheduled(id))
    }

    /// Scheduled payments not run or cancelled yet.
    pub fn scheduled_ids(e: Env) -> Vec<u32> {
        scheduled_ids(&e)
    }

    /// Runs a scheduled payment whose date has come. Anyone can call it (a
    /// keeper does); the money only goes to the tax destination.
    pub fn run_scheduled(e: Env, id: u32) -> Result<i128, VaultError> {
        let c = active(&e);
        let s: Scheduled = e
            .storage()
            .persistent()
            .get(&Key::Scheduled(id))
            .ok_or(VaultError::UnknownPayment)?;
        if now(&e) < s.at {
            return Err(VaultError::NotYet);
        }
        let to = MuxedAddress::from_string(&s.to);
        if to.address() != c.tax_destination {
            return Err(VaultError::WrongDestination);
        }
        let mut paid: i128 = 0;
        for p in s.payments.iter() {
            let held_now = load_period(&e, p.period, &p.token)
                .buckets
                .get(p.bucket.clone())
                .unwrap_or(0);
            let amount = p.amount.min(held_now);
            if amount > 0 {
                Self::pay_out(&e, &c, p.period, p.token, p.bucket, amount, to.clone())?;
                paid += amount;
            }
        }
        Self::drop_scheduled(&e, id);
        ScheduledRun { id, paid }.publish(&e);
        Ok(paid)
    }

    /// Cancels a scheduled payment before it runs.
    pub fn cancel_scheduled(e: Env, id: u32) -> Result<(), VaultError> {
        stored_config(&e).owner.require_auth();
        if !e.storage().persistent().has(&Key::Scheduled(id)) {
            return Err(VaultError::UnknownPayment);
        }
        Self::drop_scheduled(&e, id);
        ScheduledCancelled { id }.publish(&e);
        Ok(())
    }
}
