//! Read-only entry points.
use crate::*;

#[contractimpl]
impl ReserveVault {
    /// The config in force now (a pending change whose notice has passed is
    /// included; while following a registry, the rule shows the followed VAT).
    pub fn config(e: Env) -> Config {
        effective(&e)
    }

    /// The registry the vault follows for its VAT, if any.
    pub fn feed(e: Env) -> Option<Feed> {
        feed(&e)
    }

    /// How long every change that can move the reserve waits, in seconds.
    pub fn notice_secs(e: Env) -> u64 {
        stored_config(&e).notice_secs
    }

    /// A proposed rule and when it takes effect.
    pub fn pending_rule(e: Env) -> Option<PendingRule> {
        pending_rule(&e)
    }

    /// A proposed tax destination and when it takes effect.
    pub fn pending_destination(e: Env) -> Option<PendingDestination> {
        pending_destination(&e)
    }

    /// The only address that can move the reserve or change the vault.
    pub fn owner(e: Env) -> Address {
        stored_config(&e).owner
    }

    /// Where the net amount, releases and corrections go now.
    pub fn payout(e: Env) -> Address {
        active(&e).payout
    }

    /// A proposed payout address and when it takes effect.
    pub fn pending_payout(e: Env) -> Option<PendingPayout> {
        pending_payout(&e)
    }

    /// Proposed fixed amounts and when they take effect.
    pub fn pending_fixed(e: Env) -> Option<PendingFixed> {
        pending_fixed(&e)
    }

    /// Whether the vault takes payments in `token` now.
    pub fn accepts(e: Env, token: Address) -> bool {
        active(&e).tokens.contains(&token)
    }

    /// A proposed new token and when the vault starts accepting it.
    pub fn pending_token(e: Env) -> Option<PendingToken> {
        pending_token(&e)
    }

    /// The split the current rule gives for `gross`.
    pub fn quote(e: Env, gross: i128) -> Split {
        split(&e, &effective(&e).rule, gross)
    }

    /// The split `receive` will make for this payer and reference: an
    /// invoice's terms, else the payer's, else the rule. Contracts that
    /// authorize the exact transfers (the Inbox, the CCTP receiver) ask this.
    pub fn quote_for(e: Env, from: Address, reference: BytesN<32>, gross: i128) -> Split {
        split_for(&e, &effective(&e).rule, &from, &reference, gross).1
    }

    /// Exactly what `receive` will do for this payment now, in `token`: the
    /// split of `quote_for` with the period's fixed amounts taken from the net.
    pub fn quote_in(
        e: Env,
        from: Address,
        token: Address,
        reference: BytesN<32>,
        gross: i128,
    ) -> Split {
        let c = effective(&e);
        let mut s = split_for(&e, &c.rule, &from, &reference, gross).1;
        let p = load_period(&e, period_of(&c.period, now(&e)), &token);
        for (_, take) in fixed_takes(&e, &c, &token, &p, s.net).iter() {
            s.fixed += take;
        }
        s.net -= s.fixed;
        s.reserve += s.fixed;
        s
    }

    /// The fiscal period payments are booked to now.
    pub fn current_period(e: Env) -> u32 {
        period_of(&stored_config(&e).period, now(&e))
    }

    /// Unix seconds from which all of `period`'s reserve can be released to
    /// the owner: the latest due date among its buckets.
    pub fn due_date(e: Env, period: u32) -> u64 {
        let c = active(&e);
        let mut latest = 0;
        for b in Self::bucket_names(&e, &c).iter() {
            latest = latest.max(lock_at(&e, &c, period, &b));
        }
        latest
    }

    /// Unix seconds from which `bucket`'s reserve of `period` is past its due
    /// date (e.g. `vat`, or `irpf` for the Spanish income-tax reserve).
    pub fn bucket_due_date(e: Env, period: u32, bucket: Symbol) -> u64 {
        let c = stored_config(&e);
        lock_at(&e, &c, period, &bucket)
    }

    /// The books of `period` in `token`: what each bucket holds and what came
    /// in and went out.
    pub fn period(e: Env, period: u32, token: Address) -> PeriodState {
        load_period(&e, period, &token)
    }
}
