//! Types and pure functions shared by the Kyros contracts: the split rule,
//! the split arithmetic and the fiscal-period calendar.
//!
//! Nothing here touches storage or tokens, so the same functions run in the
//! contracts, in their tests and (mirrored line by line) in the TypeScript SDK.
//!
//! | Module | Contents |
//! | --- | --- |
//! | `math` | Checked arithmetic: 256-bit ratios, `MathError` |
//! | `split` | Rules, buckets and the split of a payment |
//! | `calendar` | Fiscal periods, due dates, weekends and holidays |
//! | `api` | The traits the contracts call each other through |
#![no_std]
use soroban_sdk::{contractclient, contracttype, Address, BytesN, Env, Symbol, Vec, I256};

/// Basis points in one whole: 10000 bps = 100%.
pub const BPS: i128 = 10_000;
/// Most buckets a rule may have besides VAT.
pub const MAX_BUCKETS: u32 = 8;

/// Ledgers in a day (one ledger every five seconds).
pub const DAY_IN_LEDGERS: u32 = 17_280;
/// How long an entry is kept alive each time it is extended: about six
/// months, the most Stellar's network settings allow today (a longer request
/// is clamped by the network, never refused).
pub const TTL_EXTEND_TO: u32 = 180 * DAY_IN_LEDGERS;
/// An entry that is used with less than this left is extended again: half
/// of `TTL_EXTEND_TO`, so most calls pay no rent at all.
pub const TTL_THRESHOLD: u32 = TTL_EXTEND_TO / 2;

mod api;
mod calendar;
mod math;
mod split;

pub use api::*;
pub use calendar::*;
pub use math::*;
pub use split::*;

#[cfg(test)]
mod test;
