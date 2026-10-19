extern crate std;
use super::*;
use kyros_types::Bucket;
use soroban_sdk::{
    symbol_short,
    testutils::{Address as _, Ledger},
    token::{StellarAssetClient, TokenClient},
    vec, Env,
};

/// 2027-02-10 12:00 UTC: inside Q1 2027.
const FEB_10_2027: u64 = 1_802_260_800;
/// 2027-04-01 00:00 UTC: Q1 2027 ends.
const APR_1_2027: u64 = 1_806_537_600;
const DUE_OFFSET: u64 = 30 * 86_400;
const NOTICE: u64 = 7 * 86_400;
const UNIT: i128 = 10_000_000;

struct W {
    e: Env,
    v: ReserveVaultClient<'static>,
    token: Address,
    owner: Address,
    payer: Address,
    tax: Address,
}

fn spain(e: &Env) -> Rule {
    Rule {
        vat_bps: 2100,
        buckets: vec![
            e,
            Bucket {
                name: Symbol::new(e, "irpf"),
                bps: 2000,
            },
        ],
    }
}

fn world() -> W {
    let e = Env::default();
    e.mock_all_auths();
    e.ledger().set_timestamp(FEB_10_2027);
    let sac = e.register_stellar_asset_contract_v2(Address::generate(&e));
    let token = sac.address();
    let owner = Address::generate(&e);
    let payer = Address::generate(&e);
    let tax = Address::generate(&e);
    StellarAssetClient::new(&e, &token).mint(&payer, &(10_000 * UNIT));
    let id = e.register(
        ReserveVault,
        (
            owner.clone(),
            spain(&e),
            tax.clone(),
            NOTICE,
            PeriodKind::Quarter,
            crate::dues_after(&e, DUE_OFFSET),
            vec![&e, token.clone()],
        ),
    );
    let v = ReserveVaultClient::new(&e, &id);
    W {
        e,
        v,
        token,
        owner,
        payer,
        tax,
    }
}

fn bal(w: &W, a: &Address) -> i128 {
    TokenClient::new(&w.e, &w.token).balance(a)
}

fn r(w: &W) -> BytesN<32> {
    BytesN::from_array(&w.e, &[7; 32])
}

#[test]
fn a_payment_is_split_between_the_owner_and_the_vault() {
    let w = world();
    let s = w.v.receive(&w.payer, &w.token, &(1_210 * UNIT), &r(&w));
    assert_eq!(
        (s.net, s.vat, s.reserve),
        (800 * UNIT, 210 * UNIT, 410 * UNIT)
    );
    assert_eq!(bal(&w, &w.owner), 800 * UNIT);
    assert_eq!(bal(&w, &w.v.address), 410 * UNIT);
    let q = w.v.current_period();
    assert_eq!(q, 2027 * 4); // Q1 2027
    let p = w.v.period(&q, &w.token);
    assert_eq!(p.buckets.get(symbol_short!("vat")).unwrap(), 210 * UNIT);
    assert_eq!(p.buckets.get(symbol_short!("irpf")).unwrap(), 200 * UNIT);
    assert_eq!(p.reserved, 410 * UNIT);
}

#[test]
fn the_reserve_is_locked_until_the_due_date() {
    let w = world();
    w.v.receive(&w.payer, &w.token, &(1_210 * UNIT), &r(&w));
    let q = w.v.current_period();
    assert_eq!(w.v.due_date(&q), APR_1_2027 + DUE_OFFSET);
    assert_eq!(w.v.try_release(&q, &w.token), Err(Ok(VaultError::NotDue)));
    w.e.ledger().set_timestamp(APR_1_2027 + DUE_OFFSET - 1);
    assert_eq!(w.v.try_release(&q, &w.token), Err(Ok(VaultError::NotDue)));
    w.e.ledger().set_timestamp(APR_1_2027 + DUE_OFFSET);
    assert_eq!(w.v.release(&q, &w.token), 410 * UNIT);
    assert_eq!(bal(&w, &w.owner), 1_210 * UNIT);
    assert_eq!(
        w.v.try_release(&q, &w.token),
        Err(Ok(VaultError::NothingToRelease))
    );
}

#[test]
fn tax_can_be_paid_at_any_time_but_only_to_the_destination() {
    let w = world();
    w.v.receive(&w.payer, &w.token, &(1_210 * UNIT), &r(&w));
    let q = w.v.current_period();
    w.v.pay_tax(&q, &w.token, &symbol_short!("vat"), &(210 * UNIT));
    assert_eq!(bal(&w, &w.tax), 210 * UNIT);
    assert_eq!(
        w.v.try_pay_tax(&q, &w.token, &symbol_short!("vat"), &1),
        Err(Ok(VaultError::ExceedsReserve))
    );
    assert_eq!(
        w.v.try_pay_tax(&q, &w.token, &symbol_short!("nope"), &1),
        Err(Ok(VaultError::UnknownBucket))
    );
    let p = w.v.period(&q, &w.token);
    assert_eq!(p.paid, 210 * UNIT);
    assert_eq!(p.buckets.get(symbol_short!("irpf")).unwrap(), 200 * UNIT);
    // After the due date only what is left goes back to the owner.
    w.e.ledger().set_timestamp(APR_1_2027 + DUE_OFFSET);
    assert_eq!(w.v.release(&q, &w.token), 200 * UNIT);
}

#[test]
fn a_new_destination_waits_for_the_notice_period() {
    let w = world();
    w.v.receive(&w.payer, &w.token, &(1_210 * UNIT), &r(&w));
    let q = w.v.current_period();
    let thief = Address::generate(&w.e);
    let ready = w.v.propose_destination(&thief);
    assert_eq!(ready, FEB_10_2027 + NOTICE);
    // During the notice the old destination still applies.
    w.v.pay_tax(&q, &w.token, &symbol_short!("vat"), &UNIT);
    assert_eq!(bal(&w, &w.tax), UNIT);
    assert_eq!(bal(&w, &thief), 0);
    assert_eq!(w.v.try_apply_pending(), Err(Ok(VaultError::ChangeNotReady)));
    // The owner can still cancel it.
    w.v.cancel();
    assert_eq!(w.v.pending_destination(), None);
    // Proposed again and left to run: after the notice it is in force.
    w.v.propose_destination(&thief);
    w.e.ledger().set_timestamp(FEB_10_2027 + NOTICE);
    assert_eq!(w.v.config().tax_destination, thief);
    assert_eq!(w.v.try_cancel(), Err(Ok(VaultError::AlreadyInForce)));
    w.v.apply_pending();
    assert_eq!(w.v.pending_destination(), None);
    assert_eq!(
        w.v.try_apply_pending(),
        Err(Ok(VaultError::NoPendingChange))
    );
}

#[test]
fn a_new_rule_applies_only_after_notice_and_must_be_valid() {
    let w = world();
    let bad = Rule {
        vat_bps: 2100,
        buckets: vec![
            &w.e,
            Bucket {
                name: symbol_short!("x"),
                bps: 10_001,
            },
        ],
    };
    assert_eq!(w.v.try_propose_rule(&bad), Err(Ok(VaultError::InvalidRule)));
    let lower = Rule {
        vat_bps: 2100,
        buckets: vec![
            &w.e,
            Bucket {
                name: symbol_short!("irpf"),
                bps: 700,
            },
        ],
    };
    w.v.propose_rule(&lower);
    assert_eq!(w.v.quote(&(1_210 * UNIT)).reserve, 410 * UNIT);
    w.e.ledger().set_timestamp(FEB_10_2027 + NOTICE);
    assert_eq!(w.v.quote(&(1_210 * UNIT)).reserve, 280 * UNIT);
}

#[test]
fn a_scheduled_rule_switches_on_its_date_and_never_before_the_notice() {
    let w = world();
    // VAT goes from 21% to 22% thirty days from now; the owner signs today.
    let date = FEB_10_2027 + 30 * 86_400;
    let higher = Rule {
        vat_bps: 2200,
        buckets: vec![
            &w.e,
            Bucket {
                name: symbol_short!("irpf"),
                bps: 2000,
            },
        ],
    };
    assert_eq!(w.v.propose_rule_at(&higher, &date), date);
    // The notice has run but the date has not come: the old rate still applies.
    w.e.ledger().set_timestamp(FEB_10_2027 + NOTICE);
    assert_eq!(w.v.quote(&(1_210 * UNIT)).vat, 210 * UNIT);
    w.e.ledger().set_timestamp(date - 1);
    assert_eq!(w.v.quote(&(1_210 * UNIT)).vat, 210 * UNIT);
    // From the date on, every payment uses the new rate.
    w.e.ledger().set_timestamp(date);
    assert_eq!(w.v.quote(&(1_220 * UNIT)).vat, 220 * UNIT);
    // A date sooner than the notice is pushed back to the end of the notice.
    let lower = Rule {
        vat_bps: 2100,
        buckets: vec![
            &w.e,
            Bucket {
                name: symbol_short!("irpf"),
                bps: 2000,
            },
        ],
    };
    assert_eq!(w.v.propose_rule_at(&lower, &(date + 1)), date + NOTICE);
}

#[test]
fn only_accepted_tokens_and_positive_amounts() {
    let w = world();
    let other =
        w.e.register_stellar_asset_contract_v2(Address::generate(&w.e))
            .address();
    assert!(!w.v.accepts(&other));
    assert_eq!(
        w.v.try_receive(&w.payer, &other, &UNIT, &r(&w)),
        Err(Ok(VaultError::TokenNotAccepted))
    );
    assert_eq!(
        w.v.try_receive(&w.payer, &w.token, &0, &r(&w)),
        Err(Ok(VaultError::InvalidAmount))
    );
}

#[test]
fn reserves_are_booked_to_the_period_they_arrive_in() {
    let w = world();
    w.v.receive(&w.payer, &w.token, &(121 * UNIT), &r(&w));
    w.e.ledger().set_timestamp(APR_1_2027 + 10);
    w.v.receive(&w.payer, &w.token, &(242 * UNIT), &r(&w));
    let q1 = 2027 * 4;
    assert_eq!(w.v.period(&q1, &w.token).reserved, 41 * UNIT);
    assert_eq!(w.v.period(&(q1 + 1), &w.token).reserved, 82 * UNIT);
}

#[test]
fn money_out_needs_the_owner() {
    let e = Env::default();
    e.ledger().set_timestamp(FEB_10_2027);
    let owner = Address::generate(&e);
    let token = e
        .register_stellar_asset_contract_v2(Address::generate(&e))
        .address();
    let id = e.register(
        ReserveVault,
        (
            owner,
            spain(&e),
            Address::generate(&e),
            NOTICE,
            PeriodKind::Quarter,
            crate::dues_after(&e, DUE_OFFSET),
            vec![&e, token.clone()],
        ),
    );
    let v = ReserveVaultClient::new(&e, &id);
    // No authorization mocked: owner-only calls fail.
    assert!(v
        .try_pay_tax(&(2027 * 4), &token, &symbol_short!("vat"), &1)
        .is_err());
    assert!(v.try_propose_destination(&Address::generate(&e)).is_err());
}

fn registry(w: &W, notice: u64) -> kyros_rate_registry::RateRegistryClient<'static> {
    let id = w.e.register(
        kyros_rate_registry::RateRegistry,
        (Address::generate(&w.e), notice),
    );
    let r = kyros_rate_registry::RateRegistryClient::new(&w.e, &id);
    r.seed(&symbol_short!("ES"), &symbol_short!("standard"), &2100);
    r
}

#[test]
fn a_vault_that_follows_the_registry_changes_vat_on_the_legal_date_without_a_signature() {
    let w = world();
    let reg = registry(&w, NOTICE);
    let (es, std) = (symbol_short!("ES"), symbol_short!("standard"));
    w.v.follow(&reg.address, &es, &std, &2500);
    assert_eq!(w.v.feed().unwrap().country, es);
    // The law changes: 22% from a date published 30 days ahead.
    let date = FEB_10_2027 + 30 * 86_400;
    reg.publish(&es, &std, &date, &2200);
    assert_eq!(w.v.quote(&(1_210 * UNIT)).vat, 210 * UNIT);
    w.e.ledger().set_timestamp(date);
    // No call from the owner: payments now use 22%, and the user's 20% income-tax reserve is untouched.
    let before = bal(&w, &w.owner);
    let s = w.v.receive(&w.payer, &w.token, &(1_220 * UNIT), &r(&w));
    assert_eq!(s.vat, 220 * UNIT);
    assert_eq!(s.parts.get(0).unwrap(), 200 * UNIT);
    assert_eq!(bal(&w, &w.owner) - before, 800 * UNIT);
    assert_eq!(w.v.config().rule.vat_bps, 2200);
}

#[test]
fn following_is_bounded_and_can_stop_at_any_time() {
    let w = world();
    let (es, std) = (symbol_short!("ES"), symbol_short!("standard"));
    // A registry with less notice than the vault is refused.
    let fast = registry(&w, NOTICE - 1);
    assert_eq!(
        w.v.try_follow(&fast.address, &es, &std, &2500),
        Err(Ok(VaultError::RegistryNoticeTooShort))
    );
    let reg = registry(&w, NOTICE);
    // Following must change nothing today.
    assert_eq!(
        w.v.try_follow(
            &reg.address,
            &symbol_short!("ES"),
            &symbol_short!("reduced"),
            &2500
        ),
        Err(Ok(VaultError::UnknownRate))
    );
    assert_eq!(
        w.v.try_follow(&reg.address, &es, &std, &2000),
        Err(Ok(VaultError::RateMismatch))
    );
    w.v.follow(&reg.address, &es, &std, &2300);
    // A rate above the owner's ceiling is ignored: the vault keeps its own 21%.
    let date = FEB_10_2027 + 30 * 86_400;
    reg.publish(&es, &std, &date, &9000);
    w.e.ledger().set_timestamp(date);
    assert_eq!(w.v.quote(&(1_210 * UNIT)).vat, 210 * UNIT);
    // A legal change within the ceiling applies, and unfollowing keeps it as the vault's own.
    reg.publish(&es, &std, &(date + NOTICE), &2200);
    w.e.ledger().set_timestamp(date + NOTICE);
    assert_eq!(w.v.unfollow(), 2200);
    assert_eq!(w.v.feed(), None);
    reg.publish(&es, &std, &(date + 2 * NOTICE), &2300);
    w.e.ledger().set_timestamp(date + 2 * NOTICE);
    assert_eq!(w.v.config().rule.vat_bps, 2200);
    assert_eq!(w.v.try_unfollow(), Err(Ok(VaultError::NotFollowing)));
}

// ---- Reserve in the tax's currency, yield and anchors ----

mod mocks {
    use kyros_types::{Asset, PriceData};
    use soroban_sdk::{contract, contractimpl, token, Address, Env, Map};

    /// A SEP-40 oracle whose prices the test sets.
    #[contract]
    pub struct Oracle;

    #[contractimpl]
    impl Oracle {
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

    /// Pays `num/den` of `token_out` per `token_in` from its own balance.
    #[contract]
    pub struct Swapper;

    #[contractimpl]
    impl Swapper {
        pub fn set_rate(e: Env, num: i128, den: i128) {
            e.storage().instance().set(&0u32, &(num, den));
        }
        pub fn swap(
            e: Env,
            _token_in: Address,
            token_out: Address,
            amount_in: i128,
            min_out: i128,
            to: Address,
        ) -> i128 {
            let (num, den): (i128, i128) = e.storage().instance().get(&0u32).unwrap();
            let out = amount_in * num / den;
            // A real swapper refuses below min_out; this one returns what it has, so the vault's own check is tested.
            let _ = min_out;
            token::Client::new(&e, &token_out).transfer(&e.current_contract_address(), &to, &out);
            out
        }
    }

    /// A yield strategy for one owner: it holds the tokens; the test mints "interest" to it.
    #[contract]
    pub struct Yield;

    #[contractimpl]
    impl Yield {
        pub fn __constructor(e: Env, owner: Address, asset: Address) {
            e.storage().instance().set(&0u32, &(owner, asset));
        }
        pub fn owner(e: Env) -> Address {
            let (o, _): (Address, Address) = e.storage().instance().get(&0u32).unwrap();
            o
        }
        pub fn asset(e: Env) -> Address {
            let (_, a): (Address, Address) = e.storage().instance().get(&0u32).unwrap();
            a
        }
        pub fn deposit(e: Env, _amount: i128) {
            Self::owner(e).require_auth();
        }
        pub fn withdraw(e: Env, amount: i128) -> i128 {
            let owner = Self::owner(e.clone());
            owner.require_auth();
            let t = token::Client::new(&e, &Self::asset(e.clone()));
            let out = amount.min(t.balance(&e.current_contract_address()));
            t.transfer(&e.current_contract_address(), &owner, &out);
            out
        }
        pub fn balance(e: Env) -> i128 {
            token::Client::new(&e, &Self::asset(e.clone())).balance(&e.current_contract_address())
        }
    }
}

use kyros_types::Asset;
use soroban_sdk::testutils::MuxedAddress as _;

const HOUR: u64 = 3_600;
/// 1 EUR = 1.16 USD, with the oracle's 14 decimals.
const EUR_USD: i128 = 116_000_000_000_000;
const ONE: i128 = 100_000_000_000_000;

struct E2 {
    w: W,
    eurc: Address,
    oracle: mocks::OracleClient<'static>,
    swapper: mocks::SwapperClient<'static>,
}

/// A vault that accepts USDC (`w.token`) and EURC, with a fiat oracle and a swapper funded with EURC.
fn euro_world() -> E2 {
    let e = Env::default();
    e.mock_all_auths();
    e.ledger().set_timestamp(FEB_10_2027);
    let usdc = e
        .register_stellar_asset_contract_v2(Address::generate(&e))
        .address();
    let eurc = e
        .register_stellar_asset_contract_v2(Address::generate(&e))
        .address();
    let owner = Address::generate(&e);
    let payer = Address::generate(&e);
    let tax = Address::generate(&e);
    StellarAssetClient::new(&e, &usdc).mint(&payer, &(10_000 * UNIT));
    let id = e.register(
        ReserveVault,
        (
            owner.clone(),
            spain(&e),
            tax.clone(),
            NOTICE,
            PeriodKind::Quarter,
            crate::dues_after(&e, DUE_OFFSET),
            vec![&e, usdc.clone(), eurc.clone()],
        ),
    );
    let oracle = mocks::OracleClient::new(&e, &e.register(mocks::Oracle, ()));
    let swapper = mocks::SwapperClient::new(&e, &e.register(mocks::Swapper, ()));
    StellarAssetClient::new(&e, &eurc).mint(&swapper.address, &(10_000 * UNIT));
    let v = ReserveVaultClient::new(&e, &id);
    E2 {
        w: W {
            e,
            v,
            token: usdc,
            owner,
            payer,
            tax,
        },
        eurc,
        oracle,
        swapper,
    }
}

fn usd_to_eur(x: &E2) -> Conversion {
    Conversion {
        from_token: x.w.token.clone(),
        to_token: x.eurc.clone(),
        swapper: x.swapper.address.clone(),
        oracle: x.oracle.address.clone(),
        from_price: Asset::Other(symbol_short!("USD")),
        to_price: Asset::Other(symbol_short!("EUR")),
        max_slippage_bps: 100,
        max_age_secs: HOUR,
    }
}

fn prices(x: &E2, at: u64) {
    x.oracle.set(&Asset::Other(symbol_short!("USD")), &ONE, &at);
    x.oracle
        .set(&Asset::Other(symbol_short!("EUR")), &EUR_USD, &at);
}

fn eur(x: &E2, a: &Address) -> i128 {
    TokenClient::new(&x.w.e, &x.eurc).balance(a)
}

#[test]
fn reserve_received_in_dollars_is_kept_in_euros_after_the_notice() {
    let x = euro_world();
    let w = &x.w;
    w.v.receive(&w.payer, &w.token, &(1_210 * UNIT), &r(w));
    let q = w.v.current_period();
    assert_eq!(w.v.try_convert(&q), Err(Ok(VaultError::NoConversion)));
    // A token the vault does not take is refused.
    let mut bad = usd_to_eur(&x);
    bad.to_token = Address::generate(&w.e);
    assert_eq!(
        w.v.try_propose_conversion(&bad),
        Err(Ok(VaultError::InvalidConversion))
    );
    assert_eq!(
        w.v.propose_conversion(&usd_to_eur(&x)),
        FEB_10_2027 + NOTICE
    );
    assert_eq!(w.v.try_convert(&q), Err(Ok(VaultError::NoConversion)));
    w.e.ledger().set_timestamp(FEB_10_2027 + NOTICE);
    prices(&x, FEB_10_2027 + NOTICE - 60);
    // The pool gives 0.86 EUR per dollar; the oracle says 1/1.16 = 0.8621, so 0.24% below: within the 1% tolerance.
    x.swapper.set_rate(&86, &100);
    let out = w.v.convert(&q);
    assert_eq!(out, 3_526_000_000); // 410 USDC -> 352.6 EURC
    let usd = w.v.period(&q, &w.token);
    assert_eq!(usd.buckets.get(symbol_short!("vat")).unwrap(), 0);
    assert_eq!(usd.converted, 410 * UNIT);
    let eu = w.v.period(&q, &x.eurc);
    // VAT 210/410 and income tax 200/410 of what came out.
    assert_eq!(
        eu.buckets.get(symbol_short!("irpf")).unwrap(),
        1_720_000_000
    );
    assert_eq!(eu.buckets.get(symbol_short!("vat")).unwrap(), 1_806_000_000);
    assert_eq!(eu.reserved, out);
    assert_eq!(eur(&x, &w.v.address), out);
    assert_eq!(w.v.position(&x.eurc).held, out);
    assert_eq!(w.v.position(&w.token).held, 0);
    // The tax is then paid in euros.
    w.v.pay_tax(&q, &x.eurc, &symbol_short!("vat"), &1_806_000_000);
    assert_eq!(eur(&x, &w.tax), 1_806_000_000);
    assert_eq!(w.v.try_convert(&q), Err(Ok(VaultError::NothingToConvert)));
}

#[test]
fn a_bad_swap_or_a_stale_price_converts_nothing() {
    let x = euro_world();
    let w = &x.w;
    w.v.receive(&w.payer, &w.token, &(1_210 * UNIT), &r(w));
    let q = w.v.current_period();
    w.v.propose_conversion(&usd_to_eur(&x));
    w.e.ledger().set_timestamp(FEB_10_2027 + NOTICE);
    x.swapper.set_rate(&80, &100);
    assert_eq!(w.v.try_convert(&q), Err(Ok(VaultError::PriceUnavailable)));
    prices(&x, FEB_10_2027 + NOTICE - 2 * HOUR);
    assert_eq!(w.v.try_convert(&q), Err(Ok(VaultError::PriceUnavailable)));
    prices(&x, FEB_10_2027 + NOTICE);
    // 0.80 per dollar is 7% below the oracle: refused, and nothing moved.
    assert_eq!(w.v.try_convert(&q), Err(Ok(VaultError::SwapBelowFloor)));
    assert_eq!(bal(w, &w.v.address), 410 * UNIT);
    assert_eq!(w.v.period(&q, &w.token).converted, 0);
    // The owner can stop converting at once.
    w.v.stop_conversion();
    assert_eq!(w.v.conversion(), None);
    assert_eq!(w.v.try_convert(&q), Err(Ok(VaultError::NoConversion)));
}

fn yield_for(x: &E2, owner: &Address, asset: &Address) -> mocks::YieldClient<'static> {
    let id = x.w.e.register(mocks::Yield, (owner.clone(), asset.clone()));
    mocks::YieldClient::new(&x.w.e, &id)
}

#[test]
fn part_of_the_reserve_earns_yield_and_the_buckets_keep_their_amounts() {
    let x = euro_world();
    let w = &x.w;
    w.v.receive(&w.payer, &w.token, &(1_210 * UNIT), &r(w));
    let q = w.v.current_period();
    // A strategy that works for someone else is refused.
    let foreign = yield_for(&x, &Address::generate(&w.e), &w.token);
    assert_eq!(
        w.v.try_propose_strategy(&foreign.address, &5_000),
        Err(Ok(VaultError::InvalidStrategy))
    );
    let y = yield_for(&x, &w.v.address, &w.token);
    w.v.propose_strategy(&y.address, &5_000);
    assert_eq!(w.v.try_invest(), Err(Ok(VaultError::NoStrategy)));
    w.e.ledger().set_timestamp(FEB_10_2027 + NOTICE);
    // Half of the 410 reserve goes to work.
    assert_eq!(w.v.invest(), 205 * UNIT);
    assert_eq!(w.v.invest(), 0);
    let p = w.v.position(&w.token);
    assert_eq!(
        (p.held, p.liquid, p.invested, p.surplus),
        (410 * UNIT, 205 * UNIT, 205 * UNIT, 0)
    );
    // The strategy earns 5 USDC.
    StellarAssetClient::new(&w.e, &w.token).mint(&y.address, &(5 * UNIT));
    assert_eq!(w.v.position(&w.token).surplus, 5 * UNIT);
    let before = bal(w, &w.owner);
    assert_eq!(w.v.harvest(&w.token), 5 * UNIT);
    assert_eq!(bal(w, &w.owner) - before, 5 * UNIT);
    assert_eq!(w.v.position(&w.token).surplus, 0);
    // Paying more than is liquid takes the rest from the strategy.
    w.v.pay_tax(&q, &w.token, &symbol_short!("vat"), &(210 * UNIT));
    w.v.pay_tax(&q, &w.token, &symbol_short!("irpf"), &(200 * UNIT));
    assert_eq!(bal(w, &w.tax), 410 * UNIT);
    assert_eq!(w.v.position(&w.token).held, 0);
    // One strategy at a time; stopping brings everything home.
    assert_eq!(
        w.v.try_propose_strategy(&y.address, &5_000),
        Err(Ok(VaultError::StrategyInUse))
    );
    w.v.stop_strategy();
    assert_eq!(w.v.strategy(), None);
    assert_eq!(w.v.try_stop_strategy(), Err(Ok(VaultError::NoStrategy)));
}

#[test]
fn release_and_stop_bring_invested_reserve_back() {
    let x = euro_world();
    let w = &x.w;
    w.v.receive(&w.payer, &w.token, &(1_210 * UNIT), &r(w));
    let q = w.v.current_period();
    let y = yield_for(&x, &w.v.address, &w.token);
    w.v.propose_strategy(&y.address, &10_000);
    w.e.ledger().set_timestamp(FEB_10_2027 + NOTICE);
    assert_eq!(w.v.invest(), 410 * UNIT);
    assert_eq!(bal(w, &w.v.address), 0);
    w.e.ledger().set_timestamp(APR_1_2027 + DUE_OFFSET);
    assert_eq!(w.v.release(&q, &w.token), 410 * UNIT);
    assert_eq!(bal(w, &w.owner), 1_210 * UNIT);
    // Interest earned after the release is still the owner's.
    StellarAssetClient::new(&w.e, &w.token).mint(&y.address, &(2 * UNIT));
    assert_eq!(w.v.stop_strategy(), 2 * UNIT);
    assert_eq!(w.v.harvest(&w.token), 2 * UNIT);
}

/// Puts a classic account on the test ledger, so it can hold a trustline.
fn create_account(e: &Env, address: &Address) {
    use soroban_sdk::xdr;
    extern crate alloc;
    let account_id = match xdr::ScAddress::from(address) {
        xdr::ScAddress::Account(a) => a,
        _ => panic!("not an account"),
    };
    let key = xdr::LedgerKey::Account(xdr::LedgerKeyAccount {
        account_id: account_id.clone(),
    });
    let entry = xdr::LedgerEntry {
        data: xdr::LedgerEntryData::Account(xdr::AccountEntry {
            account_id,
            balance: 0,
            flags: 0,
            home_domain: Default::default(),
            inflation_dest: None,
            num_sub_entries: 0,
            seq_num: xdr::SequenceNumber(0),
            thresholds: xdr::Thresholds([1; 4]),
            signers: xdr::VecM::default(),
            ext: xdr::AccountEntryExt::V0,
        }),
        last_modified_ledger_seq: 0,
        ext: xdr::LedgerEntryExt::V0,
    };
    e.host()
        .add_ledger_entry(&alloc::rc::Rc::new(key), &alloc::rc::Rc::new(entry), None)
        .unwrap();
}

#[test]
fn an_anchor_payment_carries_its_memo_and_goes_only_to_the_destination() {
    let x = euro_world();
    let w = &x.w;
    w.v.receive(&w.payer, &w.token, &(1_210 * UNIT), &r(w));
    let q = w.v.current_period();
    // The anchor's account becomes the destination after the notice.
    let anchor = MuxedAddress::generate(&w.e).address();
    create_account(&w.e, &anchor);
    StellarAssetClient::new(&w.e, &w.token).trust(&anchor);
    w.v.propose_destination(&anchor);
    w.e.ledger().set_timestamp(FEB_10_2027 + NOTICE);
    let with_memo = MuxedAddress::new(anchor.clone(), 4_242);
    w.v.pay_tax_to(
        &q,
        &w.token,
        &symbol_short!("vat"),
        &(210 * UNIT),
        &with_memo,
    );
    assert_eq!(bal(w, &anchor), 210 * UNIT);
    let elsewhere = MuxedAddress::new(MuxedAddress::generate(&w.e).address(), 4_242);
    assert_eq!(
        w.v.try_pay_tax_to(&q, &w.token, &symbol_short!("irpf"), &UNIT, &elsewhere),
        Err(Ok(VaultError::WrongDestination))
    );
}

#[test]
fn an_invoice_with_irpf_withheld_splits_exactly() {
    let w = world();
    // Invoice: base 1,000, VAT 21% (210), client withholds 15% IRPF (150) and pays 1,060.
    // The client's withholding already prepays income tax, so the reserve keeps 5% more.
    let reference = BytesN::from_array(&w.e, &[9; 32]);
    let terms = InvoiceTerms {
        vat_bps: 2100,
        withholding_bps: 1500,
        buckets: vec![
            &w.e,
            Bucket {
                name: symbol_short!("irpf"),
                bps: 500,
            },
        ],
    };
    w.v.expect_invoice(&reference, &terms);
    assert_eq!(w.v.invoice(&reference), Some(terms));
    let s = w.v.receive(&w.payer, &w.token, &(1_060 * UNIT), &reference);
    assert_eq!(
        (s.base, s.vat, s.reserve, s.net),
        (1_000 * UNIT, 210 * UNIT, 260 * UNIT, 800 * UNIT)
    );
    let q = w.v.current_period();
    let p = w.v.period(&q, &w.token);
    assert_eq!(p.buckets.get(symbol_short!("vat")).unwrap(), 210 * UNIT);
    assert_eq!(p.buckets.get(symbol_short!("irpf")).unwrap(), 50 * UNIT);
    // A payment with another reference still follows the rule.
    let s2 = w.v.receive(&w.payer, &w.token, &(1_210 * UNIT), &r(&w));
    assert_eq!((s2.vat, s2.reserve), (210 * UNIT, 410 * UNIT));
    // A client abroad: no VAT on the invoice, nothing withheld.
    let abroad = BytesN::from_array(&w.e, &[8; 32]);
    w.v.expect_invoice(
        &abroad,
        &InvoiceTerms {
            vat_bps: 0,
            withholding_bps: 0,
            buckets: vec![
                &w.e,
                Bucket {
                    name: symbol_short!("irpf"),
                    bps: 2000,
                },
            ],
        },
    );
    let s3 = w.v.receive(&w.payer, &w.token, &(1_000 * UNIT), &abroad);
    assert_eq!((s3.vat, s3.reserve, s3.net), (0, 200 * UNIT, 800 * UNIT));
    // Withholding plus buckets over the base is refused; forgetting works once.
    assert_eq!(
        w.v.try_expect_invoice(
            &abroad,
            &InvoiceTerms {
                vat_bps: 2100,
                withholding_bps: 1500,
                buckets: vec![
                    &w.e,
                    Bucket {
                        name: symbol_short!("irpf"),
                        bps: 9000,
                    },
                ],
            }
        ),
        Err(Ok(VaultError::InvalidTerms))
    );
    w.v.forget_invoice(&abroad);
    assert_eq!(
        w.v.try_forget_invoice(&abroad),
        Err(Ok(VaultError::UnknownInvoice))
    );
}

/// Spain: VAT due on the 20th after each quarter (30 January for the fourth),
/// the income-tax reserve on 30 June of the next year (the annual return).
fn spanish_dues(e: &Env) -> Dues {
    let mut buckets = Map::new(e);
    buckets.set(
        Symbol::new(e, "vat"),
        Due::MonthDay(kyros_types::MonthDay {
            months: 0,
            day: 20,
            exception_month: 12,
            exception_months: 0,
            exception_day: 30,
        }),
    );
    Dues {
        default: Due::YearDate(kyros_types::YearDate {
            fy_start_month: 1,
            fy_start_day: 1,
            month: 6,
            day: 30,
            years_after: 1,
        }),
        buckets,
        // Saturdays and Sundays; no holiday list.
        closed: 0b110_0000,
        holidays: Holidays::None,
    }
}

#[test]
fn each_tax_falls_due_on_its_own_date() {
    let w = world();
    let id = w.e.register(
        ReserveVault,
        (
            w.owner.clone(),
            spain(&w.e),
            w.tax.clone(),
            NOTICE,
            PeriodKind::Quarter,
            spanish_dues(&w.e),
            vec![&w.e, w.token.clone()],
        ),
    );
    let v = ReserveVaultClient::new(&w.e, &id);
    v.receive(&w.payer, &w.token, &(1_210 * UNIT), &r(&w));
    let q = v.current_period();
    // 2027-04-21 00:00 UTC: the end of 20 April, Q1 VAT's last day.
    const APR_21_2027: u64 = 1_808_265_600;
    // 2028-07-01 00:00 UTC: the end of 30 June 2028, when the 2027 return is paid.
    const JUL_1_2028: u64 = 1_846_022_400;
    assert_eq!(v.bucket_due_date(&q, &symbol_short!("vat")), APR_21_2027);
    assert_eq!(v.bucket_due_date(&q, &symbol_short!("irpf")), JUL_1_2028);
    assert_eq!(v.due_date(&q), JUL_1_2028);
    // The VAT is paid on time; the income-tax reserve stays locked after the VAT date.
    v.pay_tax(&q, &w.token, &symbol_short!("vat"), &(210 * UNIT));
    w.e.ledger().set_timestamp(APR_21_2027);
    assert_eq!(v.try_release(&q, &w.token), Err(Ok(VaultError::NotDue)));
    // Unpaid VAT left over after its date can be released, and only that.
    let mut v2_dues = spanish_dues(&w.e);
    v2_dues.default = Due::YearDate(kyros_types::YearDate {
        fy_start_month: 1,
        fy_start_day: 1,
        month: 6,
        day: 30,
        years_after: 1,
    });
    w.e.ledger().set_timestamp(FEB_10_2027);
    let v2 = ReserveVaultClient::new(
        &w.e,
        &w.e.register(
            ReserveVault,
            (
                w.owner.clone(),
                spain(&w.e),
                w.tax.clone(),
                NOTICE,
                PeriodKind::Quarter,
                v2_dues,
                vec![&w.e, w.token.clone()],
            ),
        ),
    );
    v2.receive(&w.payer, &w.token, &(1_210 * UNIT), &r(&w));
    v2.pay_tax(&q, &w.token, &symbol_short!("vat"), &(200 * UNIT));
    w.e.ledger().set_timestamp(APR_21_2027);
    assert_eq!(v2.release(&q, &w.token), 10 * UNIT);
    assert_eq!(
        v2.period(&q, &w.token)
            .buckets
            .get(symbol_short!("irpf"))
            .unwrap(),
        200 * UNIT
    );
    // A year and a quarter later the income-tax reserve is free too.
    w.e.ledger().set_timestamp(JUL_1_2028 - 1);
    assert_eq!(v2.try_release(&q, &w.token), Err(Ok(VaultError::NotDue)));
    w.e.ledger().set_timestamp(JUL_1_2028);
    assert_eq!(v2.release(&q, &w.token), 200 * UNIT);
}

#[test]
fn unusable_periods_and_due_rules_are_refused() {
    let w = world();
    let bad_due = Dues {
        default: Due::YearDate(kyros_types::YearDate {
            fy_start_month: 1,
            fy_start_day: 1,
            month: 13,
            day: 1,
            years_after: 1,
        }),
        buckets: Map::new(&w.e),
        closed: 0,
        holidays: Holidays::None,
    };
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        w.e.register(
            ReserveVault,
            (
                w.owner.clone(),
                spain(&w.e),
                w.tax.clone(),
                NOTICE,
                PeriodKind::Quarter,
                bad_due.clone(),
                vec![&w.e, w.token.clone()],
            ),
        )
    }))
    .is_err());
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        w.e.register(
            ReserveVault,
            (
                w.owner.clone(),
                spain(&w.e),
                w.tax.clone(),
                NOTICE,
                PeriodKind::Months(5),
                crate::dues_after(&w.e, 0),
                vec![&w.e, w.token.clone()],
            ),
        )
    }))
    .is_err());
}

fn vault_with(w: &W, dues: Dues) -> ReserveVaultClient<'static> {
    ReserveVaultClient::new(
        &w.e,
        &w.e.register(
            ReserveVault,
            (
                w.owner.clone(),
                spain(&w.e),
                w.tax.clone(),
                NOTICE,
                PeriodKind::Quarter,
                dues,
                vec![&w.e, w.token.clone()],
            ),
        ),
    )
}

fn registry_with(w: &W, country: &str, year: u32, days: soroban_sdk::Vec<u32>) -> Address {
    let id = w.e.register(
        kyros_rate_registry::RateRegistry,
        (Address::generate(&w.e), NOTICE),
    );
    kyros_rate_registry::RateRegistryClient::new(&w.e, &id).set_holidays(
        &Symbol::new(&w.e, country),
        &year,
        &days,
    );
    id
}

/// 2026-11-10 12:00 UTC: inside Q4 2026.
const NOV_10_2026: u64 = 1_794_312_000;
/// 2027-04-20 as a day number (a Tuesday).
const APR_20_2027_DAY: u32 = 20_928;
const APR_21_2027: u64 = 1_808_265_600;

#[test]
fn a_deadline_on_a_weekend_or_holiday_moves_to_the_next_open_day() {
    let w = world();
    // Q4 2026 VAT is due on 30 January 2027, a Saturday: the lock lasts until Monday 1 February.
    w.e.ledger().set_timestamp(NOV_10_2026);
    let v = vault_with(&w, spanish_dues(&w.e));
    v.receive(&w.payer, &w.token, &(1_210 * UNIT), &r(&w));
    let q4 = v.current_period();
    const FEB_2_2027: u64 = 1_801_526_400;
    assert_eq!(v.bucket_due_date(&q4, &symbol_short!("vat")), FEB_2_2027);
    w.e.ledger().set_timestamp(1_801_353_600); // the end of Sunday 31 January
    assert_eq!(v.try_release(&q4, &w.token), Err(Ok(VaultError::NotDue)));
    w.e.ledger().set_timestamp(FEB_2_2027);
    assert_eq!(v.release(&q4, &w.token), 210 * UNIT);

    // A public holiday published in the registry moves Q1 VAT (20 April 2027) to the 21st.
    w.e.ledger().set_timestamp(FEB_10_2027);
    let mut dues = spanish_dues(&w.e);
    dues.holidays = Holidays::Registry(HolidaySource {
        registry: registry_with(&w, "ES", 2027, vec![&w.e, APR_20_2027_DAY]),
        country: Symbol::new(&w.e, "ES"),
    });
    let v = vault_with(&w, dues);
    let q1 = v.current_period();
    assert_eq!(
        v.bucket_due_date(&q1, &symbol_short!("vat")),
        APR_21_2027 + 86_400
    );

    // A registry cannot keep a reserve locked more than two weeks past the legal date.
    let mut long: soroban_sdk::Vec<u32> = Vec::new(&w.e);
    for d in 0..20 {
        long.push_back(APR_20_2027_DAY + d);
    }
    let mut dues = spanish_dues(&w.e);
    dues.holidays = Holidays::Registry(HolidaySource {
        registry: registry_with(&w, "ES", 2027, long),
        country: Symbol::new(&w.e, "ES"),
    });
    let v = vault_with(&w, dues);
    assert_eq!(
        v.bucket_due_date(&q1, &symbol_short!("vat")),
        APR_21_2027 + 14 * 86_400
    );
}

#[test]
fn the_tax_office_date_can_be_set_later_at_once_and_earlier_only_with_notice() {
    let w = world();
    let v = vault_with(&w, spanish_dues(&w.e));
    v.receive(&w.payer, &w.token, &(1_210 * UNIT), &r(&w));
    let q1 = v.current_period();
    let irpf = symbol_short!("irpf");
    const JUL_1_2028: u64 = 1_846_022_400;
    assert_eq!(v.bucket_due_date(&q1, &irpf), JUL_1_2028);
    // The notice says 1 September 2028: later, so it applies at once.
    v.set_due(&irpf, &q1, &(q1 + 3), &21_428);
    assert_eq!(v.bucket_due_date(&q1, &irpf), 1_851_465_600);
    assert_eq!(v.bucket_due_date(&(q1 + 3), &irpf), 1_851_465_600);
    // VAT keeps its own date.
    assert_eq!(v.bucket_due_date(&q1, &symbol_short!("vat")), APR_21_2027);
    // Close to the date, an earlier one would open the lock within the notice: refused.
    w.e.ledger().set_timestamp(1_835_395_200); // 2028-02-28
    assert_eq!(
        v.try_set_due(&irpf, &q1, &q1, &21_244), // 1 March 2028
        Err(Ok(VaultError::DueTooSoon))
    );
    // One at least the notice away is fine (Friday 10 March 2028).
    v.set_due(&irpf, &q1, &q1, &21_253);
    assert_eq!(v.bucket_due_date(&q1, &irpf), 1_836_345_600);
    // Ranges are bounded and a date decades away is refused.
    assert_eq!(
        v.try_set_due(&irpf, &q1, &(q1 + 40), &21_428),
        Err(Ok(VaultError::TooMany))
    );
    assert_eq!(
        v.try_set_due(&irpf, &q1, &q1, &40_000),
        Err(Ok(VaultError::InvalidDue))
    );
}

#[test]
fn a_scheduled_payment_goes_out_on_its_date_and_only_to_the_destination() {
    let w = world();
    let v = vault_with(&w, spanish_dues(&w.e));
    v.receive(&w.payer, &w.token, &(1_210 * UNIT), &r(&w));
    let q1 = v.current_period();
    let at = APR_21_2027 - 5 * 86_400;
    let items = vec![
        &w.e,
        Payment {
            period: q1,
            token: w.token.clone(),
            bucket: symbol_short!("vat"),
            amount: 210 * UNIT,
        },
        Payment {
            period: q1,
            token: w.token.clone(),
            bucket: symbol_short!("irpf"),
            amount: 500 * UNIT, // more than the bucket holds: pays what it holds
        },
    ];
    // Only to the tax destination.
    assert_eq!(
        v.try_schedule(&at, &items, &MuxedAddress::from(&w.owner)),
        Err(Ok(VaultError::WrongDestination))
    );
    let id = v.schedule(&at, &items, &MuxedAddress::from(&w.tax));
    assert_eq!(v.scheduled_ids(), vec![&w.e, id]);
    assert_eq!(v.try_run_scheduled(&id), Err(Ok(VaultError::NotYet)));
    // Anyone can run it once the date comes (here, no owner signature is mocked for it).
    w.e.ledger().set_timestamp(at);
    w.e.set_auths(&[]);
    assert_eq!(v.run_scheduled(&id), 410 * UNIT);
    let t = TokenClient::new(&w.e, &w.token);
    assert_eq!(t.balance(&w.tax), 410 * UNIT);
    let p = v.period(&q1, &w.token);
    assert_eq!(
        p.paid_buckets.get(symbol_short!("irpf")).unwrap(),
        200 * UNIT
    );
    assert!(v.scheduled_ids().is_empty());
    assert_eq!(
        v.try_run_scheduled(&id),
        Err(Ok(VaultError::UnknownPayment))
    );
    // A payment can be cancelled by the owner before it runs.
    w.e.mock_all_auths();
    let id2 = v.schedule(&(at + 86_400), &items, &MuxedAddress::from(&w.tax));
    v.cancel_scheduled(&id2);
    assert!(v.scheduled(&id2).is_none());
}

#[test]
fn periods_record_income_and_what_clients_withheld() {
    let w = world();
    let v = vault_with(&w, spanish_dues(&w.e));
    v.receive(&w.payer, &w.token, &(1_210 * UNIT), &r(&w));
    let q1 = v.current_period();
    let p = v.period(&q1, &w.token);
    assert_eq!(p.income, 1_000 * UNIT);
    assert_eq!(p.withheld, 0);
    // An invoice of 1,000 + 21% VAT with 15% IRPF withheld: the client pays 1,060.
    let inv = BytesN::from_array(&w.e, &[9; 32]);
    v.expect_invoice(
        &inv,
        &InvoiceTerms {
            vat_bps: 2100,
            withholding_bps: 1500,
            buckets: vec![
                &w.e,
                Bucket {
                    name: symbol_short!("irpf"),
                    bps: 500,
                },
            ],
        },
    );
    v.receive(&w.payer, &w.token, &(1_060 * UNIT), &inv);
    let p = v.period(&q1, &w.token);
    assert_eq!(p.income, 2_000 * UNIT);
    assert_eq!(p.withheld, 150 * UNIT);
}

#[test]
fn a_client_abroad_splits_by_its_own_terms_and_tax_not_owed_comes_back_after_notice() {
    let w = world();
    let client = Address::generate(&w.e);
    StellarAssetClient::new(&w.e, &w.token).mint(&client, &(5_000 * UNIT));
    let abroad = InvoiceTerms {
        vat_bps: 0,
        withholding_bps: 0,
        buckets: vec![
            &w.e,
            Bucket {
                name: symbol_short!("irpf"),
                bps: 2000,
            },
        ],
    };
    w.v.expect_payer(&client, &abroad);
    assert_eq!(w.v.payer(&client), Some(abroad));
    // The client abroad pays without invoice terms: no VAT, income tax as usual.
    let s = w.v.receive(&client, &w.token, &(1_000 * UNIT), &r(&w));
    assert_eq!((s.vat, s.reserve, s.net), (0, 200 * UNIT, 800 * UNIT));
    // Anyone else still follows the rule.
    let s2 = w.v.receive(&w.payer, &w.token, &(1_210 * UNIT), &r(&w));
    assert_eq!(s2.vat, 210 * UNIT);
    let q = w.v.current_period();
    let vat = symbol_short!("vat");
    // That 210 was not owed (say the second payer was abroad too): take it back, with notice.
    assert_eq!(
        w.v.try_propose_correction(&q, &w.token, &vat, &(211 * UNIT)),
        Err(Ok(VaultError::ExceedsReserve))
    );
    assert_eq!(
        w.v.try_propose_correction(&q, &w.token, &symbol_short!("nope"), &1),
        Err(Ok(VaultError::UnknownBucket))
    );
    let id = w.v.propose_correction(&q, &w.token, &vat, &(210 * UNIT));
    assert_eq!(w.v.correction_ids(), vec![&w.e, id]);
    assert_eq!(w.v.correction(&id).unwrap().ready_at, FEB_10_2027 + NOTICE);
    assert_eq!(w.v.try_apply_correction(&id), Err(Ok(VaultError::NotYet)));
    // After the notice anyone can apply it; the money goes to the owner.
    w.e.ledger().set_timestamp(FEB_10_2027 + NOTICE);
    let before = bal(&w, &w.owner);
    w.e.set_auths(&[]);
    assert_eq!(w.v.apply_correction(&id), 210 * UNIT);
    assert_eq!(bal(&w, &w.owner), before + 210 * UNIT);
    let p = w.v.period(&q, &w.token);
    assert_eq!(p.buckets.get(vat.clone()).unwrap(), 0);
    assert_eq!(p.released, 210 * UNIT);
    assert_eq!(w.v.correction(&id), None);
    assert_eq!(
        w.v.try_apply_correction(&id),
        Err(Ok(VaultError::UnknownCorrection))
    );
    // The owner can cancel a correction before it applies, and forget a payer once.
    w.e.mock_all_auths();
    let id2 =
        w.v.propose_correction(&q, &w.token, &symbol_short!("irpf"), &UNIT);
    w.v.cancel_correction(&id2);
    assert_eq!(w.v.correction_ids().len(), 0);
    assert_eq!(
        w.v.try_cancel_correction(&id2),
        Err(Ok(VaultError::UnknownCorrection))
    );
    w.v.forget_payer(&client);
    assert_eq!(w.v.payer(&client), None);
    assert_eq!(
        w.v.try_forget_payer(&client),
        Err(Ok(VaultError::UnknownPayer))
    );
}
