//! Changes that wait out the notice period (proposing, applying, withdrawing),
//! and VAT that follows the law's registry.
use crate::*;

#[contractimpl]
impl ReserveVault {
    // ---- Changes, with notice ----

    /// Proposes a new rule; it applies after `notice_secs`. A new proposal
    /// replaces a pending one and restarts the notice.
    pub fn propose_rule(e: Env, rule: Rule) -> Result<u64, VaultError> {
        Self::propose_rule_at(e, rule, 0)
    }

    /// Proposes a new rule that takes effect at `effective_at` (UNIX seconds),
    /// or after `notice_secs` if that is later. Used to follow a scheduled VAT
    /// change: the owner signs ahead and the vault switches on the day the new
    /// rate applies, never before the notice has run. 0 means as soon as possible.
    pub fn propose_rule_at(e: Env, rule: Rule, effective_at: u64) -> Result<u64, VaultError> {
        let c = active(&e);
        c.owner.require_auth();
        check_rule(&e, &rule)?;
        Self::fold(&e);
        let ready_at = (now(&e) + c.notice_secs).max(effective_at);
        e.storage().instance().set(
            &Key::PendingRule,
            &PendingRule {
                rule: rule.clone(),
                ready_at,
            },
        );
        bump_instance(&e);
        RuleProposed { rule, ready_at }.publish(&e);
        Ok(ready_at)
    }

    /// Proposes a new tax destination; it applies after `notice_secs`.
    pub fn propose_destination(e: Env, destination: Address) -> Result<u64, VaultError> {
        let c = active(&e);
        c.owner.require_auth();
        // The tax may be paid in one currency only (a euro anchor takes
        // EURC; the dollars are converted first): it must take at least one.
        if !c.tokens.iter().any(|t| holds(&e, &t, &destination)) {
            return Err(VaultError::CannotHold);
        }
        Self::fold(&e);
        let ready_at = now(&e) + c.notice_secs;
        e.storage().instance().set(
            &Key::PendingDestination,
            &PendingDestination {
                destination: destination.clone(),
                ready_at,
            },
        );
        bump_instance(&e);
        DestinationProposed {
            destination,
            ready_at,
        }
        .publish(&e);
        Ok(ready_at)
    }

    /// Proposes a new payout address (where the net amount, releases and
    /// corrections go); it applies after `notice_secs`. The owner still signs.
    pub fn propose_payout(e: Env, payout: Address) -> Result<u64, VaultError> {
        let c = active(&e);
        c.owner.require_auth();
        if !can_hold(&e, &c, &payout) {
            return Err(VaultError::CannotHold);
        }
        Self::fold(&e);
        let ready_at = now(&e) + c.notice_secs;
        e.storage().instance().set(
            &Key::PendingPayout,
            &PendingPayout {
                payout: payout.clone(),
                ready_at,
            },
        );
        bump_instance(&e);
        PayoutProposed { payout, ready_at }.publish(&e);
        Ok(ready_at)
    }

    /// Proposes the fixed amounts set aside each period (an empty list
    /// removes them); they apply after `notice_secs`.
    pub fn propose_fixed(e: Env, fixed: Vec<Fixed>) -> Result<u64, VaultError> {
        let c = active(&e);
        c.owner.require_auth();
        check_fixed(&e, &c, &fixed)?;
        Self::fold(&e);
        let ready_at = now(&e) + c.notice_secs;
        e.storage().instance().set(
            &Key::PendingFixed,
            &PendingFixed {
                fixed: fixed.clone(),
                ready_at,
            },
        );
        bump_instance(&e);
        FixedProposed { fixed, ready_at }.publish(&e);
        Ok(ready_at)
    }

    /// Proposes a token for the vault to accept from now on (a central bank
    /// digital currency, a government's digital dollar...); it applies after
    /// `notice_secs`. A new proposal replaces a pending one.
    pub fn propose_token(e: Env, token: Address) -> Result<u64, VaultError> {
        let c = active(&e);
        c.owner.require_auth();
        if c.tokens.contains(&token) {
            return Err(VaultError::AlreadyAccepted);
        }
        if c.tokens.len() >= MAX_TOKENS {
            return Err(VaultError::TooMany);
        }
        // The net amount goes to the payout address in this currency too; and
        // an address that answers no `balance` is not a token at all.
        if !holds(&e, &token, &c.payout) {
            return Err(VaultError::CannotHold);
        }
        Self::fold(&e);
        let ready_at = now(&e) + c.notice_secs;
        e.storage().instance().set(
            &Key::PendingToken,
            &PendingToken {
                token: token.clone(),
                ready_at,
            },
        );
        bump_instance(&e);
        TokenProposed { token, ready_at }.publish(&e);
        Ok(ready_at)
    }

    // ---- Applying and withdrawing changes ----

    /// Withdraws pending changes that have not taken effect yet.
    pub fn cancel(e: Env) -> Result<(), VaultError> {
        stored_config(&e).owner.require_auth();
        let t = now(&e);
        let r = pending_rule(&e).filter(|p| t < p.ready_at).is_some();
        let d = pending_destination(&e).filter(|p| t < p.ready_at).is_some();
        let o = pending_payout(&e).filter(|p| t < p.ready_at).is_some();
        let f = pending_fixed(&e).filter(|p| t < p.ready_at).is_some();
        let k = pending_token(&e).filter(|p| t < p.ready_at).is_some();
        if !r && !d && !o && !f && !k {
            return if pending_rule(&e).is_some()
                || pending_destination(&e).is_some()
                || pending_payout(&e).is_some()
                || pending_fixed(&e).is_some()
                || pending_token(&e).is_some()
            {
                Err(VaultError::AlreadyInForce)
            } else {
                Err(VaultError::NoPendingChange)
            };
        }
        if r {
            e.storage().instance().remove(&Key::PendingRule);
        }
        if d {
            e.storage().instance().remove(&Key::PendingDestination);
        }
        if o {
            e.storage().instance().remove(&Key::PendingPayout);
        }
        if f {
            e.storage().instance().remove(&Key::PendingFixed);
        }
        if k {
            e.storage().instance().remove(&Key::PendingToken);
        }
        ChangeCancelled {
            rule: r,
            destination: d,
            payout: o,
            fixed: f,
            token: k,
        }
        .publish(&e);
        Ok(())
    }

    /// Writes pending changes whose notice has passed into the config. Anyone can call it.
    pub fn apply_pending(e: Env) -> Result<(), VaultError> {
        if pending_rule(&e).is_none()
            && pending_destination(&e).is_none()
            && pending_payout(&e).is_none()
            && pending_fixed(&e).is_none()
            && pending_token(&e).is_none()
        {
            return Err(VaultError::NoPendingChange);
        }
        if !Self::fold(&e) {
            return Err(VaultError::ChangeNotReady);
        }
        bump_instance(&e);
        Ok(())
    }

    // ---- VAT that follows the law ----

    /// Starts reading the VAT rate from `registry` (`country`, `rate`), so
    /// legal changes apply on their date with no signature. Changes nothing
    /// today: the registry's current rate must equal the vault's VAT. The
    /// registry must give at least the vault's own notice. A rate above
    /// `max_bps` is ignored and the vault keeps its own rule.
    pub fn follow(
        e: Env,
        registry: Address,
        country: Symbol,
        rate: Symbol,
        max_bps: u32,
    ) -> Result<(), VaultError> {
        let c = effective(&e);
        c.owner.require_auth();
        let r = RegistryClient::new(&e, &registry);
        if r.min_notice() < c.notice_secs {
            return Err(VaultError::RegistryNoticeTooShort);
        }
        let today = r
            .rate_at(&country, &rate, &now(&e))
            .ok_or(VaultError::UnknownRate)?;
        if today != c.rule.vat_bps || today > max_bps || max_bps > 10_000 {
            return Err(VaultError::RateMismatch);
        }
        e.storage().instance().set(
            &Key::Feed,
            &Feed {
                registry: registry.clone(),
                country: country.clone(),
                rate: rate.clone(),
                max_bps,
            },
        );
        bump_instance(&e);
        VatFollowed {
            registry,
            country,
            rate,
            max_bps,
        }
        .publish(&e);
        Ok(())
    }

    /// Stops following the registry, at once. The vault keeps the VAT in
    /// force at this moment as its own.
    pub fn unfollow(e: Env) -> Result<u32, VaultError> {
        let c = effective(&e);
        c.owner.require_auth();
        if feed(&e).is_none() {
            return Err(VaultError::NotFollowing);
        }
        Self::fold(&e);
        let mut stored = stored_config(&e);
        stored.rule.vat_bps = c.rule.vat_bps;
        e.storage().instance().set(&Key::Config, &stored);
        e.storage().instance().remove(&Key::Feed);
        bump_instance(&e);
        VatUnfollowed {
            vat_bps: c.rule.vat_bps,
        }
        .publish(&e);
        Ok(c.rule.vat_bps)
    }
}
