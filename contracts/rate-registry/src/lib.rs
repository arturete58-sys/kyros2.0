//! Kyros Rate Registry: public, dated VAT rates per country, on-chain.
//!
//! The publisher (a multisig of rule-pack maintainers) records each rate with
//! the date it applies from. A vault that opts in reads the rate in force on
//! every payment, so when a country's VAT changes the vault follows on the
//! day, with no signature from its owner.
//!
//! What the contract enforces, so following it is safe:
//! - **Advance notice.** A rate can only be published at least `min_notice`
//!   seconds before it applies. `min_notice` is fixed at deployment; a vault
//!   follows only a registry whose notice is at least its own, so its owner
//!   always has time to see a change and stop following.
//! - **History is final.** A rate that has started to apply cannot be edited
//!   or withdrawn; only future entries can be corrected.
//! - **Everything is an event,** so apps and keepers alert users ahead.
//!
//! The registry never holds or moves money.
#![no_std]
use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, Address, Env, Symbol, Vec,
};

const DAY_IN_LEDGERS: u32 = 17_280;
const TTL: u32 = 365 * DAY_IN_LEDGERS;
/// Most dated entries kept per rate.
const MAX_ENTRIES: u32 = 64;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum RegistryError {
    /// The rate would apply sooner than `min_notice` from now.
    TooSoon = 1,
    /// More than 100%.
    InvalidRate = 2,
    /// The entry has started to apply and cannot change.
    AlreadyInForce = 3,
    NotFound = 4,
    /// The rate already has entries: use `publish`.
    AlreadySeeded = 5,
    TooManyEntries = 6,
}

/// A rate and the moment it applies from.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Entry {
    pub from: u64,
    pub bps: u32,
}

#[contracttype]
#[derive(Clone)]
enum Key {
    Admin,
    MinNotice,
    Rate(Symbol, Symbol),
}

#[contractevent(topics = ["kyros_registry", "published"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Published {
    #[topic]
    pub country: Symbol,
    #[topic]
    pub name: Symbol,
    pub from: u64,
    pub bps: u32,
}

#[contractevent(topics = ["kyros_registry", "withdrawn"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Withdrawn {
    #[topic]
    pub country: Symbol,
    #[topic]
    pub name: Symbol,
    pub from: u64,
}

#[contractevent(topics = ["kyros_registry", "admin_changed"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdminChanged {
    pub admin: Address,
}

fn now(e: &Env) -> u64 {
    e.ledger().timestamp()
}

fn admin(e: &Env) -> Address {
    e.storage().instance().get(&Key::Admin).unwrap()
}

fn min_notice(e: &Env) -> u64 {
    e.storage().instance().get(&Key::MinNotice).unwrap()
}

fn entries(e: &Env, country: &Symbol, name: &Symbol) -> Vec<Entry> {
    e.storage()
        .persistent()
        .get(&Key::Rate(country.clone(), name.clone()))
        .unwrap_or(Vec::new(e))
}

fn save(e: &Env, country: &Symbol, name: &Symbol, v: &Vec<Entry>) {
    let k = Key::Rate(country.clone(), name.clone());
    e.storage().persistent().set(&k, v);
    e.storage().persistent().extend_ttl(&k, TTL / 2, TTL);
    e.storage().instance().extend_ttl(TTL / 2, TTL);
}

fn at(v: &Vec<Entry>, t: u64) -> Option<u32> {
    let mut found = None;
    for x in v.iter() {
        if x.from <= t {
            found = Some(x.bps);
        } else {
            break;
        }
    }
    found
}

#[contract]
pub struct RateRegistry;

#[contractimpl]
impl RateRegistry {
    /// `min_notice` cannot change after deployment.
    pub fn __constructor(e: Env, admin: Address, min_notice: u64) {
        e.storage().instance().set(&Key::Admin, &admin);
        e.storage().instance().set(&Key::MinNotice, &min_notice);
        e.storage().instance().extend_ttl(TTL / 2, TTL);
    }

    pub fn admin(e: Env) -> Address {
        admin(&e)
    }

    pub fn min_notice(e: Env) -> u64 {
        min_notice(&e)
    }

    /// The rate in force at `at`, if any.
    pub fn rate_at(e: Env, country: Symbol, name: Symbol, at: u64) -> Option<u32> {
        self::at(&entries(&e, &country, &name), at)
    }

    /// The rate in force now, if any.
    pub fn rate(e: Env, country: Symbol, name: Symbol) -> Option<u32> {
        let t = now(&e);
        self::at(&entries(&e, &country, &name), t)
    }

    /// Every dated entry of a rate, oldest first.
    pub fn schedule(e: Env, country: Symbol, name: Symbol) -> Vec<Entry> {
        entries(&e, &country, &name)
    }

    /// Records the rate in force today for a rate the registry does not list
    /// yet. No vault can be following it, so it needs no notice.
    pub fn seed(e: Env, country: Symbol, name: Symbol, bps: u32) -> Result<(), RegistryError> {
        admin(&e).require_auth();
        if bps > 10_000 {
            return Err(RegistryError::InvalidRate);
        }
        if !entries(&e, &country, &name).is_empty() {
            return Err(RegistryError::AlreadySeeded);
        }
        let from = now(&e);
        let mut v = Vec::new(&e);
        v.push_back(Entry { from, bps });
        save(&e, &country, &name, &v);
        Published {
            country,
            name,
            from,
            bps,
        }
        .publish(&e);
        Ok(())
    }

    /// Publishes a rate that applies from `from`, at least `min_notice` from
    /// now. Publishing again for the same `from` corrects it while it is
    /// still in the future.
    pub fn publish(
        e: Env,
        country: Symbol,
        name: Symbol,
        from: u64,
        bps: u32,
    ) -> Result<(), RegistryError> {
        admin(&e).require_auth();
        if bps > 10_000 {
            return Err(RegistryError::InvalidRate);
        }
        if from < now(&e) + min_notice(&e) {
            return Err(RegistryError::TooSoon);
        }
        let old = entries(&e, &country, &name);
        let mut v: Vec<Entry> = Vec::new(&e);
        let mut placed = false;
        for x in old.iter() {
            if !placed && x.from >= from {
                v.push_back(Entry { from, bps });
                placed = true;
                if x.from == from {
                    continue;
                }
            }
            v.push_back(x);
        }
        if !placed {
            v.push_back(Entry { from, bps });
        }
        if v.len() > MAX_ENTRIES {
            return Err(RegistryError::TooManyEntries);
        }
        save(&e, &country, &name, &v);
        Published {
            country,
            name,
            from,
            bps,
        }
        .publish(&e);
        Ok(())
    }

    /// Withdraws an entry that has not started to apply (e.g. a reform that
    /// was voted down).
    pub fn withdraw(e: Env, country: Symbol, name: Symbol, from: u64) -> Result<(), RegistryError> {
        admin(&e).require_auth();
        if from <= now(&e) {
            return Err(RegistryError::AlreadyInForce);
        }
        let old = entries(&e, &country, &name);
        let mut v: Vec<Entry> = Vec::new(&e);
        let mut found = false;
        for x in old.iter() {
            if x.from == from {
                found = true;
            } else {
                v.push_back(x);
            }
        }
        if !found {
            return Err(RegistryError::NotFound);
        }
        save(&e, &country, &name, &v);
        Withdrawn {
            country,
            name,
            from,
        }
        .publish(&e);
        Ok(())
    }

    /// Hands the registry to a new publisher (both must sign).
    pub fn set_admin(e: Env, new_admin: Address) {
        admin(&e).require_auth();
        new_admin.require_auth();
        e.storage().instance().set(&Key::Admin, &new_admin);
        AdminChanged { admin: new_admin }.publish(&e);
    }
}

#[cfg(test)]
mod test;
