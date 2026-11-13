//! Money in: payments split on arrival, and deposits.
use crate::*;

#[contractimpl]
impl ReserveVault {
    /// Pulls `gross` of `token` from `from` (who must authorize the transfers):
    /// the net amount to the payout address, the reserve into the vault, booked to the
    /// current period. Called by the Router (the payer authorizes) and by the
    /// user's Inbox (the inbox contract authorizes).
    pub fn receive(
        e: Env,
        from: Address,
        token: Address,
        gross: i128,
        reference: BytesN<32>,
    ) -> Result<Split, VaultError> {
        from.require_auth();
        if gross <= 0 {
            return Err(VaultError::InvalidAmount);
        }
        let mut c = effective(&e);
        if !c.tokens.contains(&token) {
            return Err(VaultError::TokenNotAccepted);
        }
        let (rule, mut s) = split_for(&e, &c.rule, &from, &reference, gross);
        c.rule = rule;
        let id = period_of(&c.period, now(&e));
        let mut p = load_period(&e, id, &token);
        // The period's fixed amounts come first, out of the net amount.
        for (bucket, take) in fixed_takes(&e, &c, &token, &p, s.net).iter() {
            p.buckets.set(
                bucket.clone(),
                p.buckets.get(bucket.clone()).unwrap_or(0) + take,
            );
            p.fixed.set(
                bucket.clone(),
                p.fixed.get(bucket.clone()).unwrap_or(0) + take,
            );
            s.fixed += take;
        }
        s.net -= s.fixed;
        s.reserve += s.fixed;
        let t = token::Client::new(&e, &token);
        if s.net > 0 {
            t.transfer(&from, &c.payout, &s.net);
        }
        if s.reserve > 0 {
            t.transfer(&from, e.current_contract_address(), &s.reserve);
        }
        let vat = vat_symbol(&e);
        p.buckets
            .set(vat.clone(), p.buckets.get(vat).unwrap_or(0) + s.vat);
        for (i, b) in c.rule.buckets.iter().enumerate() {
            let part = s.parts.get(i as u32).unwrap();
            p.buckets
                .set(b.name.clone(), p.buckets.get(b.name).unwrap_or(0) + part);
        }
        p.reserved += s.reserve;
        p.income += s.base;
        p.withheld += s.base + s.vat - s.gross;
        save_period(&e, id, &token, &p);
        add_held(&e, &token, s.reserve);
        bump_instance(&e);
        Received {
            token,
            period: id,
            from,
            reference,
            gross,
            net: s.net,
            vat: s.vat,
            parts: s.parts.clone(),
            fixed: s.fixed,
            reserve: s.reserve,
        }
        .publish(&e);
        Ok(s)
    }

    /// Adds `amount` of `token` from `from` to `bucket` of `period` (the
    /// current one or an earlier one), e.g. the VAT and income-tax reserve on
    /// income received in another wallet. It is reserve like any other
    /// (locked until the bucket's due date, payable to the tax destination)
    /// but not income: the period's income does not change.
    pub fn deposit(
        e: Env,
        from: Address,
        token: Address,
        period: u32,
        bucket: Symbol,
        amount: i128,
    ) -> Result<(), VaultError> {
        from.require_auth();
        if amount <= 0 {
            return Err(VaultError::InvalidAmount);
        }
        let c = active(&e);
        if !c.tokens.contains(&token) {
            return Err(VaultError::TokenNotAccepted);
        }
        if period > period_of(&c.period, now(&e)) {
            return Err(VaultError::FuturePeriod);
        }
        if !Self::bucket_names(&e, &c).contains(&bucket) {
            return Err(VaultError::UnknownBucket);
        }
        token::Client::new(&e, &token).transfer(&from, e.current_contract_address(), &amount);
        let mut p = load_period(&e, period, &token);
        p.buckets.set(
            bucket.clone(),
            p.buckets.get(bucket.clone()).unwrap_or(0) + amount,
        );
        p.reserved += amount;
        p.deposited += amount;
        save_period(&e, period, &token, &p);
        add_held(&e, &token, amount);
        bump_instance(&e);
        Deposited {
            token,
            period,
            from,
            bucket,
            amount,
        }
        .publish(&e);
        Ok(())
    }
}
