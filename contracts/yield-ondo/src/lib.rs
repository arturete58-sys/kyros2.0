//! Kyros yield strategy holding Ondo's USDY: implements the `YieldApi` a
//! Reserve Vault uses to put part of its dollar reserve to work.
//!
//! USDY is a token backed by short-term US Treasuries and bank deposits whose
//! price rises as the yield accrues. The strategy buys USDY with the vault's
//! dollars through a swapper, values it at the USDY/USD price of a SEP-40
//! oracle (RedStone publishes one on Stellar), and sells it back when the
//! vault withdraws. Every swap has a floor taken from that price, so a bad
//! market cannot take more than `max_slippage_bps`; a price older than
//! `max_age_secs` stops it.
//!
//! One instance per vault: `owner` is the vault, and only the owner can
//! deposit or withdraw. No admin, no fees.
//!
//! **Not active yet.** USDY is offered only to eligible non-US persons under
//! Ondo's terms, and the holder may need Ondo's authorization; a vault (a
//! contract) holding it has to be cleared first. Until then Kyros does not
//! deploy this strategy, and the app shows it as coming.
#![no_std]
use kyros_types::{Asset, OracleClient, SwapClient, TTL_EXTEND_TO, TTL_THRESHOLD};
use soroban_sdk::{contract, contracterror, contractimpl, contracttype, token, Address, Env};

soroban_sdk::contractmeta!(
    key = "Description",
    val = "Kyros yield strategy holding Ondo USDY, one per vault (not deployed)."
);
soroban_sdk::contractmeta!(
    key = "Source",
    val = "https://github.com/arturete58-sys/kyros2.0"
);

const BPS: i128 = 10_000;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum YieldError {
    /// The amount must be positive.
    InvalidAmount = 1,
    /// The oracle has no USDY price.
    NoPrice = 2,
    /// The USDY price is older than `max_age_secs`.
    StalePrice = 3,
    /// Slippage above 5%, an age of zero, or tokens with different decimals.
    InvalidSetup = 4,
}

#[contracttype]
#[derive(Clone)]
enum Key {
    Setup,
}

#[contracttype]
#[derive(Clone)]
pub struct Setup {
    /// The vault.
    pub owner: Address,
    /// The dollar token the vault holds (USDC).
    pub asset: Address,
    /// Ondo's USDY token.
    pub usdy: Address,
    /// Exchanges `asset` and USDY (e.g. the Soroswap adapter).
    pub swapper: Address,
    /// A SEP-40 oracle pricing USDY in US dollars.
    pub oracle: Address,
    /// The most a swap may lose against the oracle price (at most 5%).
    pub max_slippage_bps: u32,
    /// The oldest price a swap may trade at.
    pub max_age_secs: u64,
}

fn setup(e: &Env) -> Setup {
    e.storage().instance().get(&Key::Setup).unwrap()
}

/// USDY's latest price in dollars, as (price, 10^decimals, timestamp). The dollar token counts as one dollar.
fn last_price(e: &Env, s: &Setup) -> Result<(i128, i128, u64), YieldError> {
    let o = OracleClient::new(e, &s.oracle);
    let p = o
        .lastprice(&Asset::Stellar(s.usdy.clone()))
        .ok_or(YieldError::NoPrice)?;
    if p.price <= 0 {
        return Err(YieldError::NoPrice);
    }
    Ok((p.price, 10i128.pow(o.decimals()), p.timestamp))
}

/// The price to trade at: refused when older than `max_age_secs`.
fn price(e: &Env, s: &Setup) -> Result<(i128, i128), YieldError> {
    let (p, scale, at) = last_price(e, s)?;
    if e.ledger().timestamp().saturating_sub(at) > s.max_age_secs {
        return Err(YieldError::StalePrice);
    }
    Ok((p, scale))
}

/// Extends this instance only: the shared wasm's rent is paid once for all
/// instances (anyone can extend it), not by each vault's strategy.
fn bump(e: &Env) {
    e.deployer().extend_ttl_for_contract_instance(
        e.current_contract_address(),
        TTL_THRESHOLD,
        TTL_EXTEND_TO,
    );
}

#[contract]
pub struct OndoYield;

#[contractimpl]
impl OndoYield {
    /// Sets the strategy up for `owner` (the vault). The prices compare the
    /// two tokens unit for unit, so they must have the same decimals (7 for
    /// every Stellar asset).
    #[allow(clippy::too_many_arguments)]
    pub fn __constructor(
        e: Env,
        owner: Address,
        asset: Address,
        usdy: Address,
        swapper: Address,
        oracle: Address,
        max_slippage_bps: u32,
        max_age_secs: u64,
    ) -> Result<(), YieldError> {
        if max_slippage_bps > 500
            || max_age_secs == 0
            || token::Client::new(&e, &asset).decimals() != token::Client::new(&e, &usdy).decimals()
        {
            return Err(YieldError::InvalidSetup);
        }
        e.storage().instance().set(
            &Key::Setup,
            &Setup {
                owner,
                asset,
                usdy,
                swapper,
                oracle,
                max_slippage_bps,
                max_age_secs,
            },
        );
        Ok(())
    }

    /// The vault this instance works for: the only one that can move funds.
    pub fn owner(e: Env) -> Address {
        setup(&e).owner
    }

    /// The dollar token the vault deposits and gets back.
    pub fn asset(e: Env) -> Address {
        setup(&e).asset
    }

    /// Everything the strategy was set up with.
    pub fn setup(e: Env) -> Setup {
        setup(&e)
    }

    /// Buys USDY with `amount` of the asset (already sent here by the owner),
    /// for no less than the oracle's price allows after slippage.
    pub fn deposit(e: Env, amount: i128) -> Result<(), YieldError> {
        let s = setup(&e);
        s.owner.require_auth();
        if amount <= 0 {
            return Err(YieldError::InvalidAmount);
        }
        let (p, scale) = price(&e, &s)?;
        let expected = amount * scale / p;
        let min_out = expected * (BPS - s.max_slippage_bps as i128) / BPS;
        let me = e.current_contract_address();
        token::Client::new(&e, &s.asset).transfer(&me, &s.swapper, &amount);
        SwapClient::new(&e, &s.swapper).swap(&s.asset, &s.usdy, &amount, &min_out, &me);
        bump(&e);
        Ok(())
    }

    /// Sells enough USDY for up to `amount` of the asset, straight to the
    /// owner; returns what arrived.
    pub fn withdraw(e: Env, amount: i128) -> Result<i128, YieldError> {
        let s = setup(&e);
        s.owner.require_auth();
        if amount <= 0 {
            return Err(YieldError::InvalidAmount);
        }
        let (p, scale) = price(&e, &s)?;
        let me = e.current_contract_address();
        let held = token::Client::new(&e, &s.usdy).balance(&me);
        // USDY to sell for `amount` dollars, rounded up, never more than held.
        // Asking for at least what `balance` reports sells everything: the
        // vault's "stop" asks for that, and nothing may be left behind.
        let mut sell = (amount * scale + p - 1) / p;
        let worth_all = held * p / scale * (BPS - s.max_slippage_bps as i128) / BPS;
        if sell > held || amount >= worth_all {
            sell = held;
        }
        if sell <= 0 {
            return Ok(0);
        }
        let worth = sell * p / scale;
        let min_out = worth * (BPS - s.max_slippage_bps as i128) / BPS;
        token::Client::new(&e, &s.usdy).transfer(&me, &s.swapper, &sell);
        let out =
            SwapClient::new(&e, &s.swapper).swap(&s.usdy, &s.asset, &sell, &min_out, &s.owner);
        bump(&e);
        Ok(out)
    }

    /// What the owner would get back now, at the oracle's latest price less
    /// the slippage allowed: a value the vault can count on. A stale price
    /// still values the position (only trading waits for a fresh one); no
    /// price at all values it at zero.
    pub fn balance(e: Env) -> i128 {
        let s = setup(&e);
        let held = token::Client::new(&e, &s.usdy).balance(&e.current_contract_address());
        match last_price(&e, &s) {
            Ok((p, scale, _)) => held * p / scale * (BPS - s.max_slippage_bps as i128) / BPS,
            Err(_) => 0,
        }
    }
}

#[cfg(test)]
mod test;
