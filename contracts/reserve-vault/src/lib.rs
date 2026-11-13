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
//!   Each tax (bucket) has its own due date from the country's calendar,
//!   moved past weekends and public holidays to the next day the tax office
//!   is open, so the lock never opens before the legal deadline.
//! - **Dates set by the tax office.** Where the final payment date comes
//!   from the tax office's notice, the owner can set it (`set_due`): a later
//!   date applies at once, an earlier one only after the notice period.
//! - **Scheduled payments.** The owner can schedule a payment of a bucket to
//!   the tax destination on a date (`schedule`); anyone can then run it on
//!   or after that date (`run_scheduled`), so instalments go out on time
//!   without the owner online. The money can only go to the destination.
//! - **Clients with their own terms.** The owner can register terms for a
//!   payer address (a client's wallet, or a second payment address for
//!   clients abroad): its payments split by them with no invoice reference.
//! - **Corrections, with notice.** If a payment was split with tax it did
//!   not owe (a client abroad paid the general address), the owner can
//!   propose to take that amount back; it applies only after the notice period.
//! - **Destination.** Before that date reserve can only leave for the
//!   registered tax-payment destination (`pay_tax`), e.g. the owner's anchor
//!   account used to pay the tax in euros.
//! - **Notice.** A new rule or destination takes effect only after the
//!   notice period, and both the proposal and the change emit events.
//! - **VAT that follows the law (opt-in).** The owner can have the vault read
//!   its VAT rate from a Kyros Rate Registry, so a legal change applies on
//!   its date with no signature. The registry must give at least the vault's
//!   own notice, the owner sets a ceiling, and `unfollow` works at any time.
//! - **Reserve in the tax's currency (opt-in).** Reserve received in one token
//!   (USDC) can be swapped into another (EURC), so what is set aside is in
//!   the currency the tax is owed in. Anyone can trigger the swap (`convert`),
//!   but only through the swapper and price oracle the owner chose with
//!   notice, and never for less than the oracle price minus the owner's
//!   tolerance.
//! - **Yield (opt-in).** Part of the reserve can be lent through a yield
//!   strategy the owner chose with notice, one strategy instance per vault.
//!   The buckets keep their amounts; what the strategy earns on top is the
//!   owner's (`harvest`). Payments out withdraw from the strategy as needed.
//! - **Fixed amounts per period (opt-in).** A fixed amount (e.g. the monthly
//!   self-employed fee) is set aside from the first payments of each period,
//!   before the net amount goes out, on top of the percentages.
//! - **Reserve without income.** Anyone can add reserve to a bucket
//!   (`deposit`), e.g. the VAT on income received in another wallet; it does
//!   not count as income.
//! - **Payout address.** The net amount (and whatever the vault returns) goes
//!   to the payout address, the owner unless they set another one with notice.
//! - **New currencies, with notice.** The owner can add a token the vault
//!   accepts (`propose_token`), e.g. a central bank digital currency or a
//!   government's digital dollar issued on Stellar; it applies after the notice.
//! - **Paying through an anchor.** `pay_tax_to` sends to the destination
//!   with a muxed id (the anchor's memo), so an anchor can match the payment
//!   and send euros to the owner's bank account.
//!
//! No admin and no upgrade path: Kyros never controls a vault. A new version
//! is a new contract the owner moves to by choice.
//!
//! # Layout
//!
//! | Module | Contents |
//! | --- | --- |
//! | `types`, `error`, `events` | The public interface: stored data, limits, errors, events |
//! | `storage` | Ledger keys, TTLs, the active configuration and the period books |
//! | `terms` | How a payment splits: rule, invoice or payer terms, fixed amounts |
//! | `calendar` | Due dates, weekends and holidays, dates set by the tax office |
//! | `money_in`, `money_out` | Receiving and depositing; paying the tax and releasing |
//! | `scheduled`, `corrections` | Payments on a date; reserve taken back after notice |
//! | `changes` | Every change that waits out the notice period; VAT that follows the law |
//! | `conversion`, `strategy` | Opt-in currency conversion and yield |
//! | `reads` | Read-only entry points |
//! | `internal` | Steps shared by the entry points |
//!
//! Every Soroban storage choice is deliberate: the configuration and the
//! small, bounded lists live in instance storage (read on every call); the
//! period books, invoices, payers and dates live in persistent storage, one
//! entry each, so no call reads more than it needs. Entries extend their
//! time to live when written; an archived entry is restored by the
//! transaction that needs it.
#![no_std]
use kyros_types::{
    civil_from_days, due_at, next_open, period_end, period_of, split, split_withheld, valid_due,
    valid_period, validate, validate_withholding, vat_symbol, Asset, Due, Fixed, OracleClient,
    PeriodKind, RegistryClient, Rule, Split, SwapClient, YieldClient, BPS, MAX_FIXED,
    MAX_SHIFT_DAYS, TTL_EXTEND_TO, TTL_THRESHOLD,
};
use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, token, Address, BytesN,
    Env, Map, MuxedAddress, String, Symbol, Vec,
};

mod calendar;
mod changes;
mod conversion;
mod corrections;
mod error;
mod events;
mod internal;
mod money_in;
mod money_out;
mod reads;
mod scheduled;
mod storage;
mod strategy;
mod terms;
mod types;

pub use calendar::dues_after;
use calendar::*;
pub use error::*;
pub use events::*;
use storage::*;
use strategy::*;
use terms::*;

soroban_sdk::contractmeta!(key = "Description", val = "Kyros Reserve Vault: splits each payment and locks the tax reserve until it is due. Owned by the user, no admin.");
soroban_sdk::contractmeta!(
    key = "Source",
    val = "https://github.com/arturete58-sys/kyros2.0"
);
pub use types::*;

#[contract]
pub struct ReserveVault;

#[contractimpl]
impl ReserveVault {
    // Each argument is part of the vault's setup and is checked here once.
    #[allow(clippy::too_many_arguments)]
    pub fn __constructor(
        e: Env,
        owner: Address,
        rule: Rule,
        tax_destination: Address,
        notice_secs: u64,
        period: PeriodKind,
        dues: Dues,
        tokens: Vec<Address>,
    ) -> Result<(), VaultError> {
        check_rule(&e, &rule)?;
        if !valid_period(&period) {
            return Err(VaultError::InvalidPeriod);
        }
        check_dues(&dues, &period)?;
        if tokens.is_empty() {
            return Err(VaultError::NoTokens);
        }
        let c = Config {
            payout: owner.clone(),
            owner,
            rule,
            fixed: Vec::new(&e),
            tax_destination,
            notice_secs,
            period,
            dues,
            tokens,
        };
        e.storage().instance().set(&Key::Config, &c);
        bump_instance(&e);
        Ok(())
    }
}

#[cfg(test)]
mod test;
