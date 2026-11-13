//! Data the vault stores and returns, and its limits.
use crate::*;

/// Most tokens a vault accepts.
pub const MAX_TOKENS: u32 = 8;
/// Reserve due within this long stays in the vault, never in a strategy:
/// `invest` keeps it liquid and brings it back if it is out, so a pool that is
/// fully lent on the due date cannot hold up the tax.
pub const INVEST_HORIZON_SECS: u64 = 14 * 86_400;
/// Periods with reserve tracked per token for `invest`.
pub const MAX_OPEN: u32 = 36;

/// Most corrections waiting at once.
pub const MAX_CORRECTIONS: u32 = 20;

/// Part of a bucket the owner takes back after the notice period (tax it did not owe).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Correction {
    pub period: u32,
    pub token: Address,
    pub bucket: Symbol,
    pub amount: i128,
    pub ready_at: u64,
}

/// Most periods `set_due` changes at once, and most items in one scheduled payment.
pub const MAX_BATCH: u32 = 24;
/// The most a conversion may lose against the oracle (10%): anyone can run
/// `convert`, so a tolerance near 100% would let a bad market take the reserve.
pub const MAX_SLIPPAGE_BPS: u32 = 1_000;
/// The oldest oracle price a conversion may trade at (one day).
pub const MAX_PRICE_AGE_SECS: u64 = 86_400;
/// Most scheduled payments open at once.
pub const MAX_SCHEDULED: u32 = 40;

/// How the payments of one invoice are split (shared with the CCTP receiver, which predicts the split).
pub use kyros_types::InvoiceTerms;

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
    /// Where the net amount, releases and corrections go (the owner by default).
    pub payout: Address,
    pub rule: Rule,
    /// Fixed amounts set aside each period before the net amount goes out.
    pub fixed: Vec<Fixed>,
    pub tax_destination: Address,
    /// Seconds a proposed rule or destination waits before it can apply.
    pub notice_secs: u64,
    pub period: PeriodKind,
    /// When each tax set aside in a period falls due (from the rule pack).
    pub dues: Dues,
    /// SEP-41 tokens the vault accepts (an allow-list: USDC, EURC).
    pub tokens: Vec<Address>,
}

/// When each bucket of a period falls due: VAT and income tax usually have
/// different dates (in Spain, VAT on the 20th after each quarter and the
/// income-tax reserve on 30 June of the next year). A bucket not listed uses
/// `default`. Before its due date a bucket's reserve can only be paid to the
/// tax destination; after it, what is left can be released to the owner.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Dues {
    pub default: Due,
    pub buckets: Map<Symbol, Due>,
    /// Weekdays the tax office is closed, as a bitmask (bit 0 Monday … bit 6
    /// Sunday): a due date on one of them moves to the next open day.
    pub closed: u32,
    /// Where the country's public holidays are published, if anywhere.
    pub holidays: Holidays,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Holidays {
    None,
    Registry(HolidaySource),
}

/// A Kyros Rate Registry and the country whose holidays it lists.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HolidaySource {
    pub registry: Address,
    pub country: Symbol,
}

/// One item of a scheduled payment: `amount` of a period's bucket in `token`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Payment {
    pub period: u32,
    pub token: Address,
    pub bucket: Symbol,
    pub amount: i128,
}

/// A payment to the tax destination that anyone can run from `at` on.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Scheduled {
    pub at: u64,
    pub payments: Vec<Payment>,
    /// The destination as a strkey: the account, or a muxed account carrying the anchor's memo.
    pub to: String,
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

/// A proposed payout address, waiting for its notice period.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingPayout {
    pub payout: Address,
    pub ready_at: u64,
}

/// Proposed fixed amounts per period, waiting for their notice period.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingFixed {
    pub fixed: Vec<Fixed>,
    pub ready_at: u64,
}

pub use kyros_types::PendingToken;

/// What one period holds for one token.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PeriodState {
    /// Reserve still held, per bucket (`vat` and the rule's buckets).
    pub buckets: Map<Symbol, i128>,
    /// Total reserved in the period so far (payments, and conversions into this token).
    pub reserved: i128,
    /// Total sent to the tax destination.
    pub paid: i128,
    /// Total returned to the owner after the due date.
    pub released: i128,
    /// Total swapped out of this token into the reserve currency.
    pub converted: i128,
    /// Taxable income booked to the period (the base of every payment).
    pub income: i128,
    /// Income tax the clients withheld and paid themselves (invoices with withholding).
    pub withheld: i128,
    /// What has been paid to the tax destination from each bucket.
    pub paid_buckets: Map<Symbol, i128>,
    /// How much of each fixed amount the period's payments have set aside so far.
    pub fixed: Map<Symbol, i128>,
    /// Reserve added with `deposit` (not income).
    pub deposited: i128,
}

/// How reserve received in `from_token` is turned into `to_token`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Conversion {
    pub from_token: Address,
    pub to_token: Address,
    /// A contract implementing `SwapApi`.
    pub swapper: Address,
    /// A SEP-40 price oracle (e.g. Reflector) that prices both tokens in one base.
    pub oracle: Address,
    /// How the oracle names each token, e.g. `Other(USD)` and `Other(EUR)` on a fiat oracle.
    pub from_price: Asset,
    pub to_price: Asset,
    /// Most a swap may return below the oracle price, in bps.
    pub max_slippage_bps: u32,
    /// Oldest oracle price accepted, in seconds.
    pub max_age_secs: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingConversion {
    pub conversion: Conversion,
    pub ready_at: u64,
}

/// A yield strategy for the reserve held in `token`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Strategy {
    /// A contract implementing `YieldApi` whose owner is this vault.
    pub adapter: Address,
    pub token: Address,
    /// Most of the reserve in `token` the strategy may hold, in bps.
    pub max_bps: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingStrategy {
    pub strategy: Strategy,
    pub ready_at: u64,
}

/// Where the reserve in one token is, and what it has earned.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Position {
    /// What the buckets of every period hold in this token: what the vault owes.
    pub held: i128,
    /// Tokens in the vault itself.
    pub liquid: i128,
    /// What the strategy would give back now.
    pub invested: i128,
    /// liquid + invested - held: the owner's yield (negative if the strategy lost value).
    pub surplus: i128,
}
