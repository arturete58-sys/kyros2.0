//! Kyros Reserve Vault: one per user, owned by the user.
//!
//! Every payment that reaches the vault (through the Router or the user's
//! Inbox) is split by the owner's rule: the net amount goes straight to the
//! owner and the reserve stays here, booked to the current fiscal period in
//! one bucket per tax (`vat`, `irpf`, ...).
//!
//! What the contract enforces:
//! - **Lock.** A period's reserve cannot go back to the owner before the
//!   period's due date (`release`).
//! - **Destination.** Before that date reserve can only leave for the
//!   registered tax-payment destination (`pay_tax`), e.g. the owner's anchor
//!   account used to pay the tax in euros.
//! - **Notice.** A new rule or destination takes effect only after the
//!   notice period, and both the proposal and the change emit events.
//! - **VAT that follows the law (opt-in).** The owner can have the vault read
//!   its VAT rate from a Kyros Rate Registry, so a legal change applies on
//!   its date with no signature. The registry must give at least the vault's
//!   own notice, the owner sets a ceiling, and `unfollow` works at any time.
//!
//! No admin and no upgrade path: Kyros never controls a vault. A new version
//! is a new contract the owner moves to by choice.
#![no_std]
use kyros_types::{
    period_end, period_of, split, validate, vat_symbol, PeriodKind, RegistryClient, Rule, Split,
};
use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, token, Address, BytesN,
    Env, Map, Symbol, Vec,
};

const DAY_IN_LEDGERS: u32 = 17_280;
/// Period entries live at least ~13 months after their last change.
const PERIOD_TTL: u32 = 400 * DAY_IN_LEDGERS;
const INSTANCE_TTL: u32 = 180 * DAY_IN_LEDGERS;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum VaultError {
    /// The rule is invalid (VAT over 100%, buckets over the base, duplicate or reserved names, too many buckets).
    InvalidRule = 1,
    InvalidAmount = 2,
    /// The vault does not accept this token.
    TokenNotAccepted = 3,
    /// The period's due date has not passed yet.
    NotDue = 4,
    NothingToRelease = 5,
    /// More than the bucket holds.
    ExceedsReserve = 6,
    NoPendingChange = 7,
    /// The notice period has not passed yet.
    ChangeNotReady = 8,
    UnknownBucket = 9,
    NoTokens = 10,
    /// The change has already taken effect.
    AlreadyInForce = 11,
    /// The vault is not following a rate registry.
    NotFollowing = 12,
    /// The registry's advance notice is shorter than the vault's.
    RegistryNoticeTooShort = 13,
    /// The registry does not list this rate.
    UnknownRate = 14,
    /// The registry's rate today differs from the vault's VAT, or is above the ceiling:
    /// align the rule first, so following changes nothing today.
    RateMismatch = 15,
}

/// Where the vault reads its VAT rate while it follows a registry.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Feed {
    pub registry: Address,
    /// Country code, e.g. `ES`.
    pub country: Symbol,
    /// Rate name in that country, e.g. `standard`.
    pub rate: Symbol,
    /// Highest VAT the vault accepts from the registry; above it the vault keeps its own rule.
    pub max_bps: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Config {
    pub owner: Address,
    pub rule: Rule,
    pub tax_destination: Address,
    /// Seconds a proposed rule or destination waits before it can apply.
    pub notice_secs: u64,
    pub period: PeriodKind,
    /// Seconds after a period ends until its due date (from the rule pack).
    pub due_offset_secs: u64,
    /// SEP-41 tokens the vault accepts (an allow-list: USDC, EURC).
    pub tokens: Vec<Address>,
}

/// A proposed rule, waiting for its notice period.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingRule {
    pub rule: Rule,
    /// Unix seconds from which it applies.
    pub ready_at: u64,
}

/// A proposed tax destination, waiting for its notice period.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingDestination {
    pub destination: Address,
    /// Unix seconds from which it applies.
    pub ready_at: u64,
}

/// What one period holds for one token.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PeriodState {
    /// Reserve still held, per bucket (`vat` and the rule's buckets).
    pub buckets: Map<Symbol, i128>,
    /// Total reserved in the period so far.
    pub reserved: i128,
    /// Total sent to the tax destination.
    pub paid: i128,
    /// Total returned to the owner after the due date.
    pub released: i128,
}

#[contracttype]
#[derive(Clone)]
enum Key {
    Config,
    PendingRule,
    PendingDestination,
    Period(u32, Address),
    Feed,
}

#[contractevent(topics = ["kyros_vault", "received"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Received {
    #[topic]
    pub token: Address,
    #[topic]
    pub period: u32,
    pub from: Address,
    pub reference: BytesN<32>,
    pub gross: i128,
    pub net: i128,
    pub vat: i128,
    pub parts: Vec<i128>,
    pub reserve: i128,
}

#[contractevent(topics = ["kyros_vault", "tax_paid"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TaxPaid {
    #[topic]
    pub token: Address,
    #[topic]
    pub period: u32,
    pub bucket: Symbol,
    pub amount: i128,
    pub destination: Address,
}

#[contractevent(topics = ["kyros_vault", "released"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Released {
    #[topic]
    pub token: Address,
    #[topic]
    pub period: u32,
    pub amount: i128,
}

#[contractevent(topics = ["kyros_vault", "rule_proposed"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuleProposed {
    pub rule: Rule,
    pub ready_at: u64,
}

#[contractevent(topics = ["kyros_vault", "destination_proposed"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DestinationProposed {
    pub destination: Address,
    pub ready_at: u64,
}

#[contractevent(topics = ["kyros_vault", "rule_applied"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuleApplied {
    pub rule: Rule,
}

#[contractevent(topics = ["kyros_vault", "destination_applied"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DestinationApplied {
    pub destination: Address,
}

#[contractevent(topics = ["kyros_vault", "vat_followed"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VatFollowed {
    pub registry: Address,
    pub country: Symbol,
    pub rate: Symbol,
    pub max_bps: u32,
}

#[contractevent(topics = ["kyros_vault", "vat_unfollowed"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VatUnfollowed {
    /// The VAT the vault keeps from now on (the registry's rate when it stopped following).
    pub vat_bps: u32,
}

#[contractevent(topics = ["kyros_vault", "change_cancelled"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ChangeCancelled {
    pub rule: bool,
    pub destination: bool,
}

fn now(e: &Env) -> u64 {
    e.ledger().timestamp()
}

fn bump_instance(e: &Env) {
    e.storage()
        .instance()
        .extend_ttl(INSTANCE_TTL / 2, INSTANCE_TTL);
}

fn stored_config(e: &Env) -> Config {
    e.storage().instance().get(&Key::Config).unwrap()
}

fn pending_rule(e: &Env) -> Option<PendingRule> {
    e.storage().instance().get(&Key::PendingRule)
}

fn pending_destination(e: &Env) -> Option<PendingDestination> {
    e.storage().instance().get(&Key::PendingDestination)
}

/// The config in force now: a pending change counts once its notice has passed,
/// even before anyone calls `apply_pending`.
fn active(e: &Env) -> Config {
    let mut c = stored_config(e);
    if let Some(p) = pending_rule(e) {
        if now(e) >= p.ready_at {
            c.rule = p.rule;
        }
    }
    if let Some(p) = pending_destination(e) {
        if now(e) >= p.ready_at {
            c.tax_destination = p.destination;
        }
    }
    c
}

fn feed(e: &Env) -> Option<Feed> {
    e.storage().instance().get(&Key::Feed)
}

/// The VAT the registry gives now, if the vault follows one and the rate is within the ceiling.
fn followed_vat(e: &Env, f: &Feed) -> Option<u32> {
    RegistryClient::new(e, &f.registry)
        .rate_at(&f.country, &f.rate, &now(e))
        .filter(|b| *b <= f.max_bps)
}

/// The config in force now with the followed VAT applied: what payments use.
fn effective(e: &Env) -> Config {
    let mut c = active(e);
    if let Some(f) = feed(e) {
        if let Some(bps) = followed_vat(e, &f) {
            c.rule.vat_bps = bps;
        }
    }
    c
}

fn load_period(e: &Env, id: u32, token: &Address) -> PeriodState {
    e.storage()
        .persistent()
        .get(&Key::Period(id, token.clone()))
        .unwrap_or(PeriodState {
            buckets: Map::new(e),
            reserved: 0,
            paid: 0,
            released: 0,
        })
}

fn save_period(e: &Env, id: u32, token: &Address, s: &PeriodState) {
    let k = Key::Period(id, token.clone());
    e.storage().persistent().set(&k, s);
    e.storage()
        .persistent()
        .extend_ttl(&k, PERIOD_TTL / 2, PERIOD_TTL);
}

fn check_rule(e: &Env, rule: &Rule) -> Result<(), VaultError> {
    validate(e, rule).map_err(|_| VaultError::InvalidRule)
}

#[contract]
pub struct ReserveVault;

#[contractimpl]
impl ReserveVault {
    pub fn __constructor(
        e: Env,
        owner: Address,
        rule: Rule,
        tax_destination: Address,
        notice_secs: u64,
        period: PeriodKind,
        due_offset_secs: u64,
        tokens: Vec<Address>,
    ) -> Result<(), VaultError> {
        check_rule(&e, &rule)?;
        if tokens.is_empty() {
            return Err(VaultError::NoTokens);
        }
        let c = Config {
            owner,
            rule,
            tax_destination,
            notice_secs,
            period,
            due_offset_secs,
            tokens,
        };
        e.storage().instance().set(&Key::Config, &c);
        bump_instance(&e);
        Ok(())
    }

    // ---- Reads ----

    /// The config in force now (a pending change whose notice has passed is
    /// included; while following a registry, the rule shows the followed VAT).
    pub fn config(e: Env) -> Config {
        effective(&e)
    }

    /// The registry the vault follows for its VAT, if any.
    pub fn feed(e: Env) -> Option<Feed> {
        feed(&e)
    }

    pub fn notice_secs(e: Env) -> u64 {
        stored_config(&e).notice_secs
    }

    pub fn pending_rule(e: Env) -> Option<PendingRule> {
        pending_rule(&e)
    }

    pub fn pending_destination(e: Env) -> Option<PendingDestination> {
        pending_destination(&e)
    }

    pub fn owner(e: Env) -> Address {
        stored_config(&e).owner
    }

    pub fn accepts(e: Env, token: Address) -> bool {
        stored_config(&e).tokens.contains(&token)
    }

    /// The split the current rule gives for `gross`.
    pub fn quote(e: Env, gross: i128) -> Split {
        split(&e, &effective(&e).rule, gross)
    }

    pub fn current_period(e: Env) -> u32 {
        period_of(&stored_config(&e).period, now(&e))
    }

    /// Unix seconds from which `period`'s reserve can be released to the owner.
    pub fn due_date(e: Env, period: u32) -> u64 {
        let c = stored_config(&e);
        period_end(&c.period, period) + c.due_offset_secs
    }

    pub fn period(e: Env, period: u32, token: Address) -> PeriodState {
        load_period(&e, period, &token)
    }

    // ---- Money in ----

    /// Pulls `gross` of `token` from `from` (who must authorize the transfers):
    /// the net amount to the owner, the reserve into the vault, booked to the
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
        let c = effective(&e);
        if !c.tokens.contains(&token) {
            return Err(VaultError::TokenNotAccepted);
        }
        let s = split(&e, &c.rule, gross);
        let t = token::Client::new(&e, &token);
        if s.net > 0 {
            t.transfer(&from, &c.owner, &s.net);
        }
        if s.reserve > 0 {
            t.transfer(&from, &e.current_contract_address(), &s.reserve);
        }
        let id = period_of(&c.period, now(&e));
        let mut p = load_period(&e, id, &token);
        let vat = vat_symbol(&e);
        p.buckets
            .set(vat.clone(), p.buckets.get(vat).unwrap_or(0) + s.vat);
        for (i, b) in c.rule.buckets.iter().enumerate() {
            let part = s.parts.get(i as u32).unwrap();
            p.buckets
                .set(b.name.clone(), p.buckets.get(b.name).unwrap_or(0) + part);
        }
        p.reserved += s.reserve;
        save_period(&e, id, &token, &p);
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
            reserve: s.reserve,
        }
        .publish(&e);
        Ok(s)
    }

    // ---- Money out ----

    /// Sends `amount` from a period's bucket to the tax destination. Allowed at
    /// any time; this is the only way reserve leaves before the due date.
    pub fn pay_tax(
        e: Env,
        period: u32,
        token: Address,
        bucket: Symbol,
        amount: i128,
    ) -> Result<(), VaultError> {
        let c = active(&e);
        c.owner.require_auth();
        if amount <= 0 {
            return Err(VaultError::InvalidAmount);
        }
        let mut p = load_period(&e, period, &token);
        let held = p
            .buckets
            .get(bucket.clone())
            .ok_or(VaultError::UnknownBucket)?;
        if amount > held {
            return Err(VaultError::ExceedsReserve);
        }
        p.buckets.set(bucket.clone(), held - amount);
        p.paid += amount;
        save_period(&e, period, &token, &p);
        token::Client::new(&e, &token).transfer(
            &e.current_contract_address(),
            &c.tax_destination,
            &amount,
        );
        TaxPaid {
            token,
            period,
            bucket,
            amount,
            destination: c.tax_destination,
        }
        .publish(&e);
        Ok(())
    }

    /// After the period's due date, returns everything it still holds to the owner.
    pub fn release(e: Env, period: u32, token: Address) -> Result<i128, VaultError> {
        let c = active(&e);
        c.owner.require_auth();
        if now(&e) < period_end(&c.period, period) + c.due_offset_secs {
            return Err(VaultError::NotDue);
        }
        let mut p = load_period(&e, period, &token);
        let mut total: i128 = 0;
        let mut emptied = Map::new(&e);
        for (k, v) in p.buckets.iter() {
            total += v;
            emptied.set(k, 0i128);
        }
        if total <= 0 {
            return Err(VaultError::NothingToRelease);
        }
        p.buckets = emptied;
        p.released += total;
        save_period(&e, period, &token, &p);
        token::Client::new(&e, &token).transfer(&e.current_contract_address(), &c.owner, &total);
        Released {
            token,
            period,
            amount: total,
        }
        .publish(&e);
        Ok(total)
    }

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

    /// Withdraws pending changes that have not taken effect yet.
    pub fn cancel(e: Env) -> Result<(), VaultError> {
        stored_config(&e).owner.require_auth();
        let t = now(&e);
        let r = pending_rule(&e).filter(|p| t < p.ready_at).is_some();
        let d = pending_destination(&e).filter(|p| t < p.ready_at).is_some();
        if !r && !d {
            return if pending_rule(&e).is_some() || pending_destination(&e).is_some() {
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
        ChangeCancelled {
            rule: r,
            destination: d,
        }
        .publish(&e);
        Ok(())
    }

    /// Writes pending changes whose notice has passed into the config. Anyone can call it.
    pub fn apply_pending(e: Env) -> Result<(), VaultError> {
        if pending_rule(&e).is_none() && pending_destination(&e).is_none() {
            return Err(VaultError::NoPendingChange);
        }
        if !Self::fold(&e) {
            return Err(VaultError::ChangeNotReady);
        }
        bump_instance(&e);
        Ok(())
    }
}

impl ReserveVault {
    /// Moves ready pending changes into the stored config. Returns whether any applied.
    fn fold(e: &Env) -> bool {
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
        if applied {
            e.storage().instance().set(&Key::Config, &c);
        }
        applied
    }
}

#[cfg(test)]
mod test;
