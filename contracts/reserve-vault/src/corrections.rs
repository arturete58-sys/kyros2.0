//! Corrections: reserve taken back after the notice period (tax that was not owed).
use crate::*;

#[contractimpl]
impl ReserveVault {
    /// Proposes taking `amount` of a period's bucket back (tax a payment did
    /// not owe). Anyone can apply it once the notice period has passed;
    /// the owner can cancel it until then.
    pub fn propose_correction(
        e: Env,
        period: u32,
        token: Address,
        bucket: Symbol,
        amount: i128,
    ) -> Result<u32, VaultError> {
        let c = active(&e);
        c.owner.require_auth();
        if amount <= 0 {
            return Err(VaultError::InvalidAmount);
        }
        let held_now = load_period(&e, period, &token)
            .buckets
            .get(bucket.clone())
            .ok_or(VaultError::UnknownBucket)?;
        if amount > held_now {
            return Err(VaultError::ExceedsReserve);
        }
        let mut ids: Vec<u32> = e
            .storage()
            .instance()
            .get(&Key::CorrectionIds)
            .unwrap_or(Vec::new(&e));
        if ids.len() >= MAX_CORRECTIONS {
            return Err(VaultError::TooMany);
        }
        let id: u32 = e
            .storage()
            .instance()
            .get(&Key::NextCorrection)
            .unwrap_or(1);
        e.storage().instance().set(&Key::NextCorrection, &(id + 1));
        let correction = Correction {
            period,
            token,
            bucket,
            amount,
            ready_at: now(&e) + c.notice_secs,
        };
        let k = Key::Correction(id);
        e.storage().persistent().set(&k, &correction);
        e.storage()
            .persistent()
            .extend_ttl(&k, TTL_THRESHOLD, PERIOD_TTL);
        ids.push_back(id);
        e.storage().instance().set(&Key::CorrectionIds, &ids);
        bump_instance(&e);
        CorrectionProposed { id, correction }.publish(&e);
        Ok(id)
    }

    /// A proposed correction not applied or cancelled yet.
    pub fn correction(e: Env, id: u32) -> Option<Correction> {
        e.storage().persistent().get(&Key::Correction(id))
    }

    /// The corrections waiting for their notice to pass.
    pub fn correction_ids(e: Env) -> Vec<u32> {
        e.storage()
            .instance()
            .get(&Key::CorrectionIds)
            .unwrap_or(Vec::new(&e))
    }

    /// Applies a correction whose notice has passed: at most what the bucket
    /// still holds goes back to the owner. Anyone can call it.
    pub fn apply_correction(e: Env, id: u32) -> Result<i128, VaultError> {
        let c = active(&e);
        let x: Correction = e
            .storage()
            .persistent()
            .get(&Key::Correction(id))
            .ok_or(VaultError::UnknownCorrection)?;
        if now(&e) < x.ready_at {
            return Err(VaultError::NotYet);
        }
        let mut p = load_period(&e, x.period, &x.token);
        let held_now = p.buckets.get(x.bucket.clone()).unwrap_or(0);
        let amount = x.amount.min(held_now);
        Self::drop_correction(&e, id);
        if amount > 0 {
            p.buckets.set(x.bucket.clone(), held_now - amount);
            p.released += amount;
            save_period(&e, x.period, &x.token, &p);
            add_held(&e, &x.token, -amount);
            ensure_liquid(&e, &x.token, amount)?;
            token::Client::new(&e, &x.token).transfer(
                &e.current_contract_address(),
                &c.payout,
                &amount,
            );
        }
        CorrectionApplied { id, amount }.publish(&e);
        Ok(amount)
    }

    /// Withdraws a correction before it is applied: the reserve stays booked.
    pub fn cancel_correction(e: Env, id: u32) -> Result<(), VaultError> {
        stored_config(&e).owner.require_auth();
        if !e.storage().persistent().has(&Key::Correction(id)) {
            return Err(VaultError::UnknownCorrection);
        }
        Self::drop_correction(&e, id);
        CorrectionCancelled { id }.publish(&e);
        Ok(())
    }
}
