//! Internal steps shared by the entry points: paying out, and applying changes
//! whose notice has passed.
use crate::*;

impl ReserveVault {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn pay(
        e: &Env,
        c: &Config,
        period: u32,
        token: Address,
        bucket: Symbol,
        amount: i128,
        to: MuxedAddress,
    ) -> Result<(), VaultError> {
        c.owner.require_auth();
        Self::pay_out(e, c, period, token, bucket, amount, to)
    }

    /// Pays `amount` of a bucket to `to` (the destination, maybe muxed). No auth: callers check.
    pub(crate) fn pay_out(
        e: &Env,
        c: &Config,
        period: u32,
        token: Address,
        bucket: Symbol,
        amount: i128,
        to: MuxedAddress,
    ) -> Result<(), VaultError> {
        if amount <= 0 {
            return Err(VaultError::InvalidAmount);
        }
        let mut p = load_period(e, period, &token);
        let held_now = p
            .buckets
            .get(bucket.clone())
            .ok_or(VaultError::UnknownBucket)?;
        if amount > held_now {
            return Err(VaultError::ExceedsReserve);
        }
        p.buckets.set(bucket.clone(), held_now - amount);
        p.paid += amount;
        p.paid_buckets.set(
            bucket.clone(),
            p.paid_buckets.get(bucket.clone()).unwrap_or(0) + amount,
        );
        save_period(e, period, &token, &p);
        add_held(e, &token, -amount);
        ensure_liquid(e, &token, amount)?;
        let memo = to.id();
        token::Client::new(e, &token).transfer(&e.current_contract_address(), &to, &amount);
        TaxPaid {
            token,
            period,
            bucket,
            amount,
            destination: c.tax_destination.clone(),
            memo,
        }
        .publish(e);
        Ok(())
    }

    pub(crate) fn drop_correction(e: &Env, id: u32) {
        e.storage().persistent().remove(&Key::Correction(id));
        let mut ids: Vec<u32> = e
            .storage()
            .instance()
            .get(&Key::CorrectionIds)
            .unwrap_or(Vec::new(e));
        if let Some(i) = ids.first_index_of(id) {
            ids.remove(i);
        }
        e.storage().instance().set(&Key::CorrectionIds, &ids);
        bump_instance(e);
    }

    pub(crate) fn drop_scheduled(e: &Env, id: u32) {
        e.storage().persistent().remove(&Key::Scheduled(id));
        let mut ids = scheduled_ids(e);
        if let Some(i) = ids.first_index_of(id) {
            ids.remove(i);
        }
        e.storage().instance().set(&Key::ScheduledIds, &ids);
        bump_instance(e);
    }

    /// `vat` and the rule's buckets, plus any bucket with its own due date.
    pub(crate) fn bucket_names(e: &Env, c: &Config) -> Vec<Symbol> {
        let mut v = Vec::new(e);
        v.push_back(vat_symbol(e));
        for b in c.rule.buckets.iter() {
            if !v.contains(&b.name) {
                v.push_back(b.name);
            }
        }
        for (k, _) in c.dues.buckets.iter() {
            if !v.contains(&k) {
                v.push_back(k);
            }
        }
        for f in c.fixed.iter() {
            if !v.contains(&f.bucket) {
                v.push_back(f.bucket);
            }
        }
        v
    }

    /// Moves a conversion or strategy whose notice has passed into place.
    pub(crate) fn fold_extras(e: &Env) {
        let t = now(e);
        let pc: Option<PendingConversion> = e.storage().instance().get(&Key::PendingConversion);
        if let Some(p) = pc {
            if t >= p.ready_at {
                e.storage().instance().set(&Key::Conversion, &p.conversion);
                e.storage().instance().remove(&Key::PendingConversion);
            }
        }
        let ps: Option<PendingStrategy> = e.storage().instance().get(&Key::PendingStrategy);
        if let Some(p) = ps {
            if t >= p.ready_at {
                e.storage().instance().set(&Key::Strategy, &p.strategy);
                e.storage().instance().remove(&Key::PendingStrategy);
            }
        }
    }

    /// Moves ready pending changes into the stored config. Returns whether any applied.
    pub(crate) fn fold(e: &Env) -> bool {
        let t = now(e);
        let mut c = stored_config(e);
        let mut applied = false;
        if let Some(p) = pending_rule(e) {
            if t >= p.ready_at {
                c.rule = p.rule.clone();
                e.storage().instance().remove(&Key::PendingRule);
                RuleApplied { rule: p.rule }.publish(e);
                applied = true;
            }
        }
        if let Some(p) = pending_destination(e) {
            if t >= p.ready_at {
                c.tax_destination = p.destination.clone();
                e.storage().instance().remove(&Key::PendingDestination);
                DestinationApplied {
                    destination: p.destination,
                }
                .publish(e);
                applied = true;
            }
        }
        if let Some(p) = pending_payout(e) {
            if t >= p.ready_at {
                c.payout = p.payout.clone();
                e.storage().instance().remove(&Key::PendingPayout);
                PayoutApplied { payout: p.payout }.publish(e);
                applied = true;
            }
        }
        if let Some(p) = pending_fixed(e) {
            if t >= p.ready_at {
                c.fixed = p.fixed.clone();
                e.storage().instance().remove(&Key::PendingFixed);
                FixedApplied { fixed: p.fixed }.publish(e);
                applied = true;
            }
        }
        if let Some(p) = pending_token(e) {
            if t >= p.ready_at {
                if !c.tokens.contains(&p.token) {
                    c.tokens.push_back(p.token.clone());
                }
                e.storage().instance().remove(&Key::PendingToken);
                TokenAdded { token: p.token }.publish(e);
                applied = true;
            }
        }
        if applied {
            e.storage().instance().set(&Key::Config, &c);
        }
        applied
    }
}
