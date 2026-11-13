//! Ledger keys, TTLs, and reading and writing the vault's state.
use crate::*;

/// The period books and every other persistent entry: extended when written.
pub(crate) const PERIOD_TTL: u32 = TTL_EXTEND_TO;
pub(crate) const INSTANCE_TTL: u32 = TTL_EXTEND_TO;

#[contracttype]
#[derive(Clone)]
pub(crate) enum Key {
    Config,
    PendingRule,
    PendingDestination,
    Period(u32, Address),
    Feed,
    Conversion,
    PendingConversion,
    Strategy,
    PendingStrategy,
    Held(Address),
    Invoice(BytesN<32>),
    DueSet(u32, Symbol),
    Scheduled(u32),
    ScheduledIds,
    NextScheduled,
    Payer(Address),
    Correction(u32),
    CorrectionIds,
    NextCorrection,
    PendingPayout,
    PendingFixed,
    PendingToken,
    /// The periods with reserve still in a bucket, per token (for `invest`).
    Open(Address),
    /// Set once a token had more than `MAX_OPEN` such periods: `invest` then
    /// treats all its reserve as due soon.
    OpenFull(Address),
    /// The earliest date set by hand (`set_due`) for any bucket of a period:
    /// one read per period lets `invest` stay well inside the network's
    /// per-transaction entry limit.
    EarliestSet(u32),
    /// The owner stopped the strategy while it could not pay everything out:
    /// `invest` brings the rest back and then removes it.
    Stopping,
}

pub(crate) fn now(e: &Env) -> u64 {
    e.ledger().timestamp()
}

pub(crate) fn bump_instance(e: &Env) {
    e.deployer().extend_ttl_for_contract_instance(
        e.current_contract_address(),
        TTL_THRESHOLD,
        INSTANCE_TTL,
    );
}

pub(crate) fn stored_config(e: &Env) -> Config {
    e.storage().instance().get(&Key::Config).unwrap()
}

pub(crate) fn pending_rule(e: &Env) -> Option<PendingRule> {
    e.storage().instance().get(&Key::PendingRule)
}

pub(crate) fn pending_destination(e: &Env) -> Option<PendingDestination> {
    e.storage().instance().get(&Key::PendingDestination)
}

pub(crate) fn pending_payout(e: &Env) -> Option<PendingPayout> {
    e.storage().instance().get(&Key::PendingPayout)
}

pub(crate) fn pending_fixed(e: &Env) -> Option<PendingFixed> {
    e.storage().instance().get(&Key::PendingFixed)
}

pub(crate) fn pending_token(e: &Env) -> Option<PendingToken> {
    e.storage().instance().get(&Key::PendingToken)
}

/// The config in force now: a pending change counts once its notice has passed,
/// even before anyone calls `apply_pending`.
pub(crate) fn active(e: &Env) -> Config {
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
    if let Some(p) = pending_payout(e) {
        if now(e) >= p.ready_at {
            c.payout = p.payout;
        }
    }
    if let Some(p) = pending_fixed(e) {
        if now(e) >= p.ready_at {
            c.fixed = p.fixed;
        }
    }
    if let Some(p) = pending_token(e) {
        if now(e) >= p.ready_at && !c.tokens.contains(&p.token) {
            c.tokens.push_back(p.token);
        }
    }
    c
}

pub(crate) fn feed(e: &Env) -> Option<Feed> {
    e.storage().instance().get(&Key::Feed)
}

/// The VAT the registry gives now, if the vault follows one and the rate is within the ceiling.
pub(crate) fn followed_vat(e: &Env, f: &Feed) -> Option<u32> {
    RegistryClient::new(e, &f.registry)
        .rate_at(&f.country, &f.rate, &now(e))
        .filter(|b| *b <= f.max_bps)
}

/// The config in force now with the followed VAT applied: what payments use.
pub(crate) fn effective(e: &Env) -> Config {
    let mut c = active(e);
    if let Some(f) = feed(e) {
        if let Some(bps) = followed_vat(e, &f) {
            c.rule.vat_bps = bps;
        }
    }
    c
}

pub(crate) fn load_period(e: &Env, id: u32, token: &Address) -> PeriodState {
    e.storage()
        .persistent()
        .get(&Key::Period(id, token.clone()))
        .unwrap_or(PeriodState {
            buckets: Map::new(e),
            reserved: 0,
            paid: 0,
            released: 0,
            converted: 0,
            income: 0,
            withheld: 0,
            paid_buckets: Map::new(e),
            fixed: Map::new(e),
            deposited: 0,
        })
}

pub(crate) fn held(e: &Env, token: &Address) -> i128 {
    e.storage()
        .persistent()
        .get(&Key::Held(token.clone()))
        .unwrap_or(0)
}

pub(crate) fn add_held(e: &Env, token: &Address, delta: i128) {
    let k = Key::Held(token.clone());
    e.storage().persistent().set(&k, &(held(e, token) + delta));
    e.storage()
        .persistent()
        .extend_ttl(&k, TTL_THRESHOLD, PERIOD_TTL);
}

pub(crate) fn save_period(e: &Env, id: u32, token: &Address, s: &PeriodState) {
    let k = Key::Period(id, token.clone());
    e.storage().persistent().set(&k, s);
    e.storage()
        .persistent()
        .extend_ttl(&k, TTL_THRESHOLD, PERIOD_TTL);
    track_open(e, id, token, s.buckets.values().iter().any(|v| v > 0));
}

/// Keeps `Key::Open(token)`, the periods whose buckets still hold reserve.
pub(crate) fn track_open(e: &Env, id: u32, token: &Address, open: bool) {
    let store = e.storage().persistent();
    let k = Key::Open(token.clone());
    let mut ids: Vec<u32> = store.get(&k).unwrap_or(Vec::new(e));
    let at = ids.first_index_of(id);
    match (open, at) {
        (true, None) => {
            if ids.len() >= MAX_OPEN {
                store.set(&Key::OpenFull(token.clone()), &true);
                store.extend_ttl(&Key::OpenFull(token.clone()), TTL_THRESHOLD, PERIOD_TTL);
                return;
            }
            ids.push_back(id);
        }
        (false, Some(i)) => {
            ids.remove(i);
        }
        _ => {
            if store.has(&k) {
                store.extend_ttl(&k, TTL_THRESHOLD, PERIOD_TTL);
            }
            return;
        }
    }
    store.set(&k, &ids);
    store.extend_ttl(&k, TTL_THRESHOLD, PERIOD_TTL);
}

pub(crate) fn scheduled_ids(e: &Env) -> Vec<u32> {
    e.storage()
        .instance()
        .get(&Key::ScheduledIds)
        .unwrap_or(Vec::new(e))
}
