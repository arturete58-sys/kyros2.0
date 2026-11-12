extern crate std;
use super::*;
use kyros_types::PriceData;
use soroban_sdk::{
    contract, contractimpl,
    testutils::{Address as _, Ledger},
    token::{StellarAssetClient, TokenClient},
    Map,
};

const UNIT: i128 = 10_000_000;
/// The oracle's prices have 14 decimals, like RedStone's on Stellar.
const P: i128 = 100_000_000_000_000;
const NOW: u64 = 1_800_000_000;

#[contract]
pub struct TestOracle;

#[contractimpl]
impl TestOracle {
    pub fn set(e: Env, asset: Asset, price: i128, timestamp: u64) {
        let mut m: Map<Asset, PriceData> =
            e.storage().instance().get(&0u32).unwrap_or(Map::new(&e));
        m.set(asset, PriceData { price, timestamp });
        e.storage().instance().set(&0u32, &m);
    }
    pub fn lastprice(e: Env, asset: Asset) -> Option<PriceData> {
        let m: Map<Asset, PriceData> = e.storage().instance().get(&0u32)?;
        m.get(asset)
    }
    pub fn decimals(_e: Env) -> u32 {
        14
    }
}

/// Pays `num/den` of `token_out` per `token_in` from its own balance, and
/// refuses below `min_out`, as a real swapper does.
#[contract]
pub struct Swapper;

#[contractimpl]
impl Swapper {
    pub fn set_rate(e: Env, token_out: Address, num: i128, den: i128) {
        e.storage().instance().set(&token_out, &(num, den));
    }
    pub fn swap(
        e: Env,
        _token_in: Address,
        token_out: Address,
        amount_in: i128,
        min_out: i128,
        to: Address,
    ) -> i128 {
        let (num, den): (i128, i128) = e.storage().instance().get(&token_out).unwrap();
        let out = amount_in * num / den;
        assert!(out >= min_out, "below min_out");
        token::Client::new(&e, &token_out).transfer(&e.current_contract_address(), &to, &out);
        out
    }
}

struct W {
    e: Env,
    vault: Address,
    usdc: Address,
    usdy: Address,
    oracle: TestOracleClient<'static>,
    swapper: SwapperClient<'static>,
    y: OndoYieldClient<'static>,
}

fn world() -> W {
    let e = Env::default();
    e.mock_all_auths();
    e.ledger().set_timestamp(NOW);
    let vault = Address::generate(&e);
    let usdc = e
        .register_stellar_asset_contract_v2(Address::generate(&e))
        .address();
    let usdy = e
        .register_stellar_asset_contract_v2(Address::generate(&e))
        .address();
    let oracle_id = e.register(TestOracle, ());
    let swapper_id = e.register(Swapper, ());
    StellarAssetClient::new(&e, &usdc).mint(&swapper_id, &(1_000_000 * UNIT));
    StellarAssetClient::new(&e, &usdy).mint(&swapper_id, &(1_000_000 * UNIT));
    StellarAssetClient::new(&e, &usdc).mint(&vault, &(10_000 * UNIT));
    let y = e.register(
        OndoYield,
        (
            vault.clone(),
            usdc.clone(),
            usdy.clone(),
            swapper_id.clone(),
            oracle_id.clone(),
            50u32,
            86_400u64,
        ),
    );
    let w = W {
        oracle: TestOracleClient::new(&e, &oracle_id),
        swapper: SwapperClient::new(&e, &swapper_id),
        y: OndoYieldClient::new(&e, &y),
        e,
        vault,
        usdc,
        usdy,
    };
    // USDY at 1.10 dollars; the market pays exactly that.
    set_price(&w, 110, NOW);
    w
}

fn set_price(w: &W, cents: i128, at: u64) {
    w.oracle
        .set(&Asset::Stellar(w.usdy.clone()), &(cents * P / 100), &at);
    w.swapper.set_rate(&w.usdy, &100, &cents);
    w.swapper.set_rate(&w.usdc, &cents, &100);
}

fn bal(w: &W, token: &Address, who: &Address) -> i128 {
    TokenClient::new(&w.e, token).balance(who)
}

#[test]
fn the_vault_buys_usdy_at_the_oracle_price_and_sells_it_back_with_the_yield() {
    let w = world();
    TokenClient::new(&w.e, &w.usdc).transfer(&w.vault, &w.y.address, &(1_100 * UNIT));
    w.y.deposit(&(1_100 * UNIT));
    // 1,100 dollars buy 1,000 USDY at 1.10.
    assert_eq!(bal(&w, &w.usdy, &w.y.address), 1_000 * UNIT);
    // Valued at the oracle price less the 0.5% slippage allowed.
    assert_eq!(w.y.balance(), 1_094_5 * UNIT / 10);
    // The yield accrues in USDY's price: at 1.21, the same 1,000 USDY are worth 1,210.
    set_price(&w, 121, NOW);
    assert_eq!(w.y.balance(), 1_203_95 * UNIT / 100);
    // Withdrawing 605 sells 500 USDY; the dollars go straight to the vault.
    let before = bal(&w, &w.usdc, &w.vault);
    assert_eq!(w.y.withdraw(&(605 * UNIT)), 605 * UNIT);
    assert_eq!(bal(&w, &w.usdc, &w.vault) - before, 605 * UNIT);
    assert_eq!(bal(&w, &w.usdy, &w.y.address), 500 * UNIT);
    // Asking for more than it holds sells everything it has.
    assert_eq!(w.y.withdraw(&(10_000 * UNIT)), 605 * UNIT);
    assert_eq!(bal(&w, &w.usdy, &w.y.address), 0);
}

#[test]
fn a_bad_market_or_a_stale_price_stops_the_trade() {
    let w = world();
    TokenClient::new(&w.e, &w.usdc).transfer(&w.vault, &w.y.address, &(1_100 * UNIT));
    // The market pays 2% less than the oracle: beyond the 0.5% allowed, the swap is refused.
    w.swapper.set_rate(&w.usdy, &98, &110);
    assert!(w.y.try_deposit(&(1_100 * UNIT)).is_err());
    w.swapper.set_rate(&w.usdy, &100, &110);
    w.y.deposit(&(1_100 * UNIT));
    // A day and a second later the price is stale: no trading, but the position keeps its value.
    w.e.ledger().set_timestamp(NOW + 86_401);
    assert_eq!(
        w.y.try_withdraw(&(100 * UNIT)),
        Err(Ok(YieldError::StalePrice))
    );
    assert!(w.y.balance() > 0);
}

#[test]
#[should_panic]
fn more_than_five_percent_slippage_is_refused() {
    let w = world();
    w.e.register(
        OndoYield,
        (
            w.vault.clone(),
            w.usdc.clone(),
            w.usdy.clone(),
            w.swapper.address.clone(),
            w.oracle.address.clone(),
            501u32,
            86_400u64,
        ),
    );
}

#[test]
fn only_positive_amounts() {
    let w = world();
    assert_eq!(w.y.try_deposit(&0), Err(Ok(YieldError::InvalidAmount)));
    assert_eq!(w.y.owner(), w.vault);
    assert_eq!(w.y.asset(), w.usdc);
}

#[test]
fn withdrawing_what_balance_reports_leaves_no_usdy_behind() {
    let w = world();
    TokenClient::new(&w.e, &w.usdc).transfer(&w.vault, &w.y.address, &(1_100 * UNIT));
    w.y.deposit(&(1_100 * UNIT));
    // The vault's stop asks for exactly `balance()`, which is net of the
    // slippage allowed: everything is sold, nothing is stranded here.
    let all = w.y.balance();
    let before = bal(&w, &w.usdc, &w.vault);
    w.y.withdraw(&all);
    assert_eq!(bal(&w, &w.usdy, &w.y.address), 0);
    assert_eq!(bal(&w, &w.usdc, &w.vault) - before, 1_100 * UNIT);
}
