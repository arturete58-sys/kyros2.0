//! The interfaces between the contracts: each contract calls the others only
//! through these traits, so any implementation can be plugged in.
use crate::*;

/// The part of the Reserve Vault that the Router, the Inbox and the CCTP receiver call.
#[contractclient(name = "VaultClient")]
pub trait VaultApi {
    /// The vault owner, who signs for it.
    fn owner(e: Env) -> Address;
    /// Where the net amount goes (the owner unless they set another address).
    fn payout(e: Env) -> Address;
    /// The split the current rule gives for `gross`.
    fn quote(e: Env, gross: i128) -> Split;
    /// The split `receive` will make for this payer and reference (invoice
    /// terms, then the payer's terms, then the rule).
    fn quote_for(e: Env, from: Address, reference: BytesN<32>, gross: i128) -> Split;
    /// Exactly what `receive` will do now for this payment in `token`: the
    /// `quote_for` split with the period's fixed amounts taken from the net.
    fn quote_in(e: Env, from: Address, token: Address, reference: BytesN<32>, gross: i128)
        -> Split;
    /// Whether the vault accepts `token`.
    fn accepts(e: Env, token: Address) -> bool;
    /// A token the vault will accept once its notice has passed, if any.
    fn pending_token(e: Env) -> Option<PendingToken>;
    /// Pulls `gross` of `token` from `from`: the net amount to the payout address, the
    /// reserve to the vault, booked to the current period.
    fn receive(e: Env, from: Address, token: Address, gross: i128, reference: BytesN<32>) -> Split;
    /// Seconds a change to the vault waits before it takes effect.
    fn notice_secs(e: Env) -> u64;
    /// The terms registered for an invoice reference, if any.
    fn invoice(e: Env, reference: BytesN<32>) -> Option<InvoiceTerms>;
}

/// What a vault reads from a Kyros Rate Registry.
#[contractclient(name = "RegistryClient")]
pub trait RegistryApi {
    /// The rate `name` of `country` in force at `at` (Unix seconds), in bps.
    fn rate_at(e: Env, country: Symbol, name: Symbol, at: u64) -> Option<u32>;
    /// The least time between publishing a rate and the rate applying.
    fn min_notice(e: Env) -> u64;
    /// The public holidays of `country` in `year`, as day numbers (days since 1970-01-01).
    fn holidays(e: Env, country: Symbol, year: u32) -> Vec<u32>;
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
    /// UNIX seconds of the price.
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
