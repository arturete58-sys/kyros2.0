//! Types and pure functions shared by the Kyros contracts: the split rule,
//! the split arithmetic and the fiscal-period calendar.
//!
//! Nothing here touches storage or tokens, so the same functions run in the
//! contracts, in their tests and (mirrored line by line) in the TypeScript SDK.
#![no_std]
use soroban_sdk::{contractclient, contracttype, Address, BytesN, Env, Symbol, Vec};

/// Basis points in one whole: 10000 bps = 100%.
pub const BPS: i128 = 10_000;
/// Most buckets a rule may have besides VAT.
pub const MAX_BUCKETS: u32 = 8;

/// One reserve bucket charged on the taxable base, e.g. the Spanish
/// income-tax prepayment (`irpf`, 2000 bps).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Bucket {
    pub name: Symbol,
    pub bps: u32,
}

/// How a gross payment is split. VAT is included in the gross amount; every
/// other bucket is a share of the taxable base (gross without VAT).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Rule {
    pub vat_bps: u32,
    pub buckets: Vec<Bucket>,
}

/// The result of applying a rule to a gross amount. `parts[i]` belongs to
/// `rule.buckets[i]`; `reserve = vat + sum(parts)`; `net + reserve = gross`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Split {
    pub gross: i128,
    pub base: i128,
    pub vat: i128,
    pub parts: Vec<i128>,
    pub reserve: i128,
    pub net: i128,
}

/// How the vault groups reserves into fiscal periods. Calendar periods use
/// UTC; `Seconds` is a fixed length counted from the Unix epoch (testing and
/// non-calendar regimes).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PeriodKind {
    Month,
    Quarter,
    Year,
    Seconds(u64),
}

/// Why a rule is invalid.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RuleError {
    VatTooHigh,
    TooManyBuckets,
    BucketsOverBase,
    DuplicateBucket,
    ReservedName,
}

/// `vat` is the bucket name VAT is booked under.
pub fn vat_symbol(e: &Env) -> Symbol {
    Symbol::new(e, "vat")
}

/// A rule is valid when VAT is at most 100%, there are at most `MAX_BUCKETS`
/// buckets with distinct names (none called `vat`), and the buckets together
/// take at most the whole base, so the net amount is never negative.
pub fn validate(e: &Env, rule: &Rule) -> Result<(), RuleError> {
    if rule.vat_bps as i128 > BPS {
        return Err(RuleError::VatTooHigh);
    }
    if rule.buckets.len() > MAX_BUCKETS {
        return Err(RuleError::TooManyBuckets);
    }
    let vat = vat_symbol(e);
    let mut total: i128 = 0;
    for (i, b) in rule.buckets.iter().enumerate() {
        if b.name == vat {
            return Err(RuleError::ReservedName);
        }
        for other in rule.buckets.iter().skip(i + 1) {
            if other.name == b.name {
                return Err(RuleError::DuplicateBucket);
            }
        }
        total += b.bps as i128;
    }
    if total > BPS {
        return Err(RuleError::BucketsOverBase);
    }
    Ok(())
}

/// Applies `rule` to `gross` (in the token's smallest unit, gross >= 0).
///
/// ```text
/// base   = floor(gross * 10000 / (10000 + vat_bps))
/// vat    = gross - base
/// part_i = floor(base * bps_i / 10000)
/// net    = gross - vat - sum(part_i)
/// ```
/// Rounding never favours the net amount over the reserve by more than one
/// unit per bucket, and the parts always add up to the gross exactly.
pub fn split(e: &Env, rule: &Rule, gross: i128) -> Split {
    split_withheld(e, rule, 0, gross)
}

/// Like `split`, for an invoice from which the client withheld
/// `withholding_bps` of the base (e.g. Spanish IRPF, 1500) and paid it to the
/// tax authority itself, so the gross received is base + VAT - withholding:
///
/// ```text
/// base = floor(gross * 10000 / (10000 + vat_bps - withholding_bps))
/// vat  = floor(base * vat_bps / 10000)   (with withholding)
/// ```
/// With no withholding it is exactly `split`. The buckets and the
/// withholding together must not exceed the base (`validate_withholding`),
/// so the net amount is never negative.
pub fn split_withheld(e: &Env, rule: &Rule, withholding_bps: u32, gross: i128) -> Split {
    if withholding_bps == 0 {
        return split_plain(e, rule, gross);
    }
    let base = gross * BPS / (BPS + rule.vat_bps as i128 - withholding_bps as i128);
    let vat = base * rule.vat_bps as i128 / BPS;
    let mut parts = Vec::new(e);
    let mut reserve = vat;
    for b in rule.buckets.iter() {
        let p = base * b.bps as i128 / BPS;
        parts.push_back(p);
        reserve += p;
    }
    Split {
        gross,
        base,
        vat,
        parts,
        reserve,
        net: gross - reserve,
    }
}

/// A withholding is valid when it and the rule's buckets take at most the whole base.
pub fn validate_withholding(rule: &Rule, withholding_bps: u32) -> bool {
    let mut total = withholding_bps as i128;
    for b in rule.buckets.iter() {
        total += b.bps as i128;
    }
    total <= BPS
}

fn split_plain(e: &Env, rule: &Rule, gross: i128) -> Split {
    let base = gross * BPS / (BPS + rule.vat_bps as i128);
    let vat = gross - base;
    let mut parts = Vec::new(e);
    let mut reserve = vat;
    for b in rule.buckets.iter() {
        let p = base * b.bps as i128 / BPS;
        parts.push_back(p);
        reserve += p;
    }
    Split {
        gross,
        base,
        vat,
        parts,
        reserve,
        net: gross - reserve,
    }
}

// ---- Calendar (UTC), after Howard Hinnant's civil-date algorithms ----

const DAY: i64 = 86_400;

/// Days since 1970-01-01 for a proleptic Gregorian date.
pub fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = (if y >= 0 { y } else { y - 399 }) / 400;
    let yoe = y - era * 400;
    let mp = (if m > 2 { m - 3 } else { m + 9 }) as i64;
    let doy = (153 * mp + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// (year, month 1-12, day 1-31) for days since 1970-01-01.
pub fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = (if z >= 0 { z } else { z - 146_096 }) / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    (y, m, d)
}

/// The id of the period containing `ts` (Unix seconds): year*12+month-1 for
/// months, year*4+quarter-1 for quarters, the year for years, ts/len for
/// fixed lengths.
pub fn period_of(kind: &PeriodKind, ts: u64) -> u32 {
    let (y, m, _) = civil_from_days(ts as i64 / DAY);
    match kind {
        PeriodKind::Month => (y * 12 + m as i64 - 1) as u32,
        PeriodKind::Quarter => (y * 4 + (m as i64 - 1) / 3) as u32,
        PeriodKind::Year => y as u32,
        PeriodKind::Seconds(len) => (ts / (*len).max(1)) as u32,
    }
}

/// Unix seconds at which period `id` starts.
pub fn period_start(kind: &PeriodKind, id: u32) -> u64 {
    let id = id as i64;
    let (y, m) = match kind {
        PeriodKind::Month => (id / 12, (id % 12) as u32 + 1),
        PeriodKind::Quarter => (id / 4, (id % 4) as u32 * 3 + 1),
        PeriodKind::Year => (id, 1),
        PeriodKind::Seconds(len) => return id as u64 * (*len).max(1),
    };
    (days_from_civil(y, m, 1) * DAY) as u64
}

/// Unix seconds at which period `id` ends (the start of the next one).
pub fn period_end(kind: &PeriodKind, id: u32) -> u64 {
    period_start(kind, id + 1)
}

/// The part of the Reserve Vault that the Router and the Inbox call.
#[contractclient(name = "VaultClient")]
pub trait VaultApi {
    /// The vault owner, who receives the net amount.
    fn owner(e: Env) -> Address;
    /// The split the current rule gives for `gross`.
    fn quote(e: Env, gross: i128) -> Split;
    /// Whether the vault accepts `token`.
    fn accepts(e: Env, token: Address) -> bool;
    /// Pulls `gross` of `token` from `from`: the net amount to the owner, the
    /// reserve to the vault, booked to the current period.
    fn receive(e: Env, from: Address, token: Address, gross: i128, reference: BytesN<32>) -> Split;
    /// Seconds a change to the vault waits before it takes effect.
    fn notice_secs(e: Env) -> u64;
}

/// What a vault reads from a Kyros Rate Registry.
#[contractclient(name = "RegistryClient")]
pub trait RegistryApi {
    /// The rate `name` of `country` in force at `at` (Unix seconds), in bps.
    fn rate_at(e: Env, country: Symbol, name: Symbol, at: u64) -> Option<u32>;
    /// The least time between publishing a rate and the rate applying.
    fn min_notice(e: Env) -> u64;
}

/// A yield strategy a vault can lend part of its reserve through. One
/// instance serves one vault (its `owner`), so the funds of different users
/// never mix and nobody but the vault can move them.
#[contractclient(name = "YieldClient")]
pub trait YieldApi {
    /// The vault this strategy works for.
    fn owner(e: Env) -> Address;
    /// The token it holds.
    fn asset(e: Env) -> Address;
    /// Puts to work `amount` of the asset, which the owner has already sent to the strategy.
    fn deposit(e: Env, amount: i128);
    /// Sends up to `amount` of the asset back to the owner and returns what it sent.
    fn withdraw(e: Env, amount: i128) -> i128;
    /// What the owner would get back now, in the asset's smallest unit.
    fn balance(e: Env) -> i128;
}

/// Exchanges one token for another. A swapper holds nothing between calls.
#[contractclient(name = "SwapClient")]
pub trait SwapApi {
    /// Swaps `amount_in` of `token_in`, which the caller has already sent to
    /// the swapper, for at least `min_out` of `token_out`, sent to `to`.
    /// Returns the amount sent.
    fn swap(
        e: Env,
        token_in: Address,
        token_out: Address,
        amount_in: i128,
        min_out: i128,
        to: Address,
    ) -> i128;
}

/// An asset as a SEP-40 price oracle names it: a Stellar token, or any other
/// symbol such as a fiat currency (`EUR`).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Asset {
    Stellar(Address),
    Other(Symbol),
}

/// A SEP-40 price: `price` in the oracle's base asset with `decimals()` decimals.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PriceData {
    pub price: i128,
    pub timestamp: u64,
}

/// The part of a SEP-40 price oracle (e.g. Reflector) a vault reads.
#[contractclient(name = "OracleClient")]
pub trait OracleApi {
    /// The latest price of `asset` in the base asset, if any.
    fn lastprice(e: Env, asset: Asset) -> Option<PriceData>;
    /// Decimals of every price.
    fn decimals(e: Env) -> u32;
}

#[cfg(test)]
mod test;
