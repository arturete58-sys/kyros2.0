//! Survivors of mutation testing, killed: each test pins a behaviour that a
//! single changed operator in the vault would break without any other test
//! noticing. Most are about the notice period: a ready change must apply,
//! and one that is not ready must not, whatever else the owner proposes in
//! the meantime.
#![allow(clippy::arithmetic_side_effects)] // test code: amounts are small and known
use kyros_inbox::{Inbox, InboxClient};
use kyros_reserve_vault::{Conversion, Dues, ReserveVault, ReserveVaultClient};
use kyros_test_suites::*;
use kyros_types::{Asset, Bucket, Due, Fixed, InvoiceTerms, PeriodKind};
use soroban_sdk::{
    symbol_short,
    testutils::{Address as _, Events as _},
    vec, Address, Map, Symbol,
};

/// A rule change waiting its notice is not applied by another proposal
/// made in the meantime (each proposal first applies what is ready).
#[test]
fn a_pending_rule_is_not_applied_early_by_another_proposal() {
    let w = World::new();
    let mut higher = spain(&w.e);
    higher.vat_bps = 2_200;
    w.v.propose_rule(&higher);
    w.at(FEB_10_2027 + NOTICE - 1);
    w.v.propose_payout(&w.owner);
    assert_eq!(w.v.quote(&(12_100 * UNIT)).vat, 2_100 * UNIT);
    assert_eq!(w.v.config().rule.vat_bps, 2_100);
    // Once ready, the next proposal applies it.
    w.at(FEB_10_2027 + NOTICE);
    w.v.propose_payout(&w.owner);
    assert_eq!(w.v.config().rule.vat_bps, 2_200);
}

/// The same for a new payout address.
#[test]
fn a_pending_payout_is_not_applied_early_by_another_proposal() {
    let w = World::new();
    let other = Address::generate(&w.e);
    w.v.propose_payout(&other);
    w.at(FEB_10_2027 + NOTICE - 1);
    w.v.propose_rule(&spain(&w.e));
    assert_eq!(w.v.payout(), w.owner);
    w.at(FEB_10_2027 + NOTICE);
    w.v.propose_rule(&spain(&w.e));
    assert_eq!(w.v.config().payout, other);
}

fn conversion_vault() -> (World, Address, OracleClient<'static>) {
    let w = World::new();
    let eurc =
        w.e.register_stellar_asset_contract_v2(Address::generate(&w.e))
            .address();
    let v = ReserveVaultClient::new(
        &w.e,
        &w.e.register(
            ReserveVault,
            (
                w.owner.clone(),
                spain(&w.e),
                w.tax.clone(),
                NOTICE,
                PeriodKind::Quarter,
                kyros_reserve_vault::dues_after(&w.e, DUE_OFFSET),
                vec![&w.e, w.token.clone(), eurc.clone()],
            ),
        ),
    );
    let oracle = OracleClient::new(&w.e, &w.e.register(Oracle, ()));
    (World { v, ..w }, eurc, oracle)
}

fn swapper(w: &World, eurc: &Address) -> SwapperClient<'static> {
    let s = SwapperClient::new(&w.e, &w.e.register(Swapper, ()));
    s.set_rate(&100, &116);
    soroban_sdk::token::StellarAssetClient::new(&w.e, eurc).mint(&s.address, &(10_000 * UNIT));
    s
}

fn conversion(w: &World, eurc: &Address, oracle: &OracleClient, swapper: &Address) -> Conversion {
    Conversion {
        from_token: w.token.clone(),
        to_token: eurc.clone(),
        swapper: swapper.clone(),
        oracle: oracle.address.clone(),
        from_price: Asset::Other(symbol_short!("USD")),
        to_price: Asset::Other(symbol_short!("EUR")),
        max_slippage_bps: 100,
        max_age_secs: 3_600,
    }
}

/// A conversion replacing the one in force waits its notice: a conversion
/// run before then uses the old swapper; once ready, the new one is moved
/// into place and nothing is left pending.
#[test]
fn a_replacement_conversion_waits_its_notice_and_then_takes_its_place() {
    let (w, eurc, oracle) = conversion_vault();
    let (a, b) = (swapper(&w, &eurc), swapper(&w, &eurc));
    w.v.propose_conversion(&conversion(&w, &eurc, &oracle, &a.address));
    w.at(FEB_10_2027 + NOTICE);
    let price = |t: u64| {
        oracle.set(
            &Asset::Other(symbol_short!("USD")),
            &100_000_000_000_000,
            &t,
        );
        oracle.set(
            &Asset::Other(symbol_short!("EUR")),
            &116_000_000_000_000,
            &t,
        );
    };
    w.v.propose_conversion(&conversion(&w, &eurc, &oracle, &b.address));
    w.pay(1_210 * UNIT);
    let q = w.v.current_period();
    price(FEB_10_2027 + NOTICE);
    w.v.convert(&q);
    // Converted through `a`: `b` still holds all its euros.
    assert_eq!(w.v.conversion().unwrap().swapper, a.address);
    let eur = soroban_sdk::token::Client::new(&w.e, &eurc);
    assert_eq!(eur.balance(&b.address), 10_000 * UNIT);
    assert!(eur.balance(&a.address) < 10_000 * UNIT);
    // After `b`'s notice, the next conversion moves it into place.
    w.at(FEB_10_2027 + 2 * NOTICE);
    w.pay(1_210 * UNIT);
    price(FEB_10_2027 + 2 * NOTICE);
    w.v.convert(&q);
    assert_eq!(w.v.conversion().unwrap().swapper, b.address);
    assert_eq!(w.v.pending_conversion(), None);
}

/// A strategy whose notice has passed is moved into place by `invest`.
#[test]
fn a_ready_strategy_is_moved_into_place() {
    let w = World::new();
    let y = w.e.register(Yield, (w.v.address.clone(), w.token.clone()));
    w.v.propose_strategy(&y, &5_000);
    w.pay(1_210 * UNIT);
    w.at(FEB_10_2027 + NOTICE);
    w.v.invest();
    assert_eq!(w.v.strategy().unwrap().adapter, y);
    assert_eq!(w.v.pending_strategy(), None);
}

/// Every bucket the vault keeps takes deposits: the rule's, and one that
/// only has its own due date.
#[test]
fn deposits_reach_every_bucket_the_vault_keeps() {
    let w = World::new();
    let ss = Symbol::new(&w.e, "ss");
    let mut buckets = Map::new(&w.e);
    buckets.set(ss.clone(), Due::After(60 * DAY));
    let v = ReserveVaultClient::new(
        &w.e,
        &w.e.register(
            ReserveVault,
            (
                w.owner.clone(),
                spain(&w.e),
                w.tax.clone(),
                NOTICE,
                PeriodKind::Quarter,
                Dues {
                    buckets,
                    ..kyros_reserve_vault::dues_after(&w.e, DUE_OFFSET)
                },
                vec![&w.e, w.token.clone()],
            ),
        ),
    );
    let q = v.current_period();
    v.deposit(&w.payer, &w.token, &q, &w.irpf(), &UNIT);
    v.deposit(&w.payer, &w.token, &q, &ss, &UNIT);
    let p = v.period(&q, &w.token);
    assert_eq!(p.buckets.get(w.irpf()), Some(UNIT));
    assert_eq!(p.buckets.get(ss), Some(UNIT));
}

/// A bucket that exists only through a fixed amount is one of the vault's
/// buckets too: reserve can be deposited into it.
#[test]
fn a_fixed_amount_bucket_takes_deposits() {
    let w = World::new();
    let fee = Symbol::new(&w.e, "fee");
    w.v.propose_fixed(&vec![
        &w.e,
        Fixed {
            bucket: fee.clone(),
            token: w.token.clone(),
            amount: 300 * UNIT,
        },
    ]);
    w.at(FEB_10_2027 + NOTICE);
    // A payment applies the fixed amount: its 80 net go to the fee.
    w.pay(121 * UNIT);
    let q = w.v.current_period();
    w.v.deposit(&w.payer, &w.token, &q, &fee, &UNIT);
    let p = w.v.period(&q, &w.token);
    assert_eq!(p.buckets.get(fee), Some(80 * UNIT + UNIT));
}

/// A correction whose bucket was paid out meanwhile pays nothing and moves
/// no token at all.
#[test]
fn a_correction_with_nothing_left_moves_no_token() {
    let w = World::new();
    w.pay(1_210 * UNIT);
    let q = w.v.current_period();
    let id =
        w.v.propose_correction(&q, &w.token, &w.irpf(), &(200 * UNIT));
    w.v.pay_tax(&q, &w.token, &w.irpf(), &(200 * UNIT));
    w.at(FEB_10_2027 + NOTICE);
    assert_eq!(w.v.apply_correction(&id), 0);
    let token_events = w.e.events().all().filter_by_contract(&w.token);
    assert_eq!(token_events.events().len(), 0);
}

/// An Inbox authorizes exactly the transfers of the split: when the payer's
/// terms leave no reserve, or no net amount, the vault makes only the other
/// transfer, with no signature at all from anyone.
#[test]
fn a_split_with_nothing_on_one_side_makes_one_transfer() {
    for (vat, irpf, net, reserve) in [(0, 0, 121, 0), (0, 10_000, 0, 121)] {
        let w = World::new();
        let i = InboxClient::new(&w.e, &w.e.register(Inbox, (w.v.address.clone(),)));
        w.v.expect_payer(
            &i.address,
            &InvoiceTerms {
                vat_bps: vat,
                withholding_bps: 0,
                buckets: vec![
                    &w.e,
                    Bucket {
                        name: w.irpf(),
                        bps: irpf,
                    },
                ],
            },
        );
        w.mint(&i.address, 121 * UNIT);
        w.e.set_auths(&[]);
        let s = i.sweep(&w.token);
        assert_eq!((s.net, s.reserve), (net * UNIT, reserve * UNIT));
        assert_eq!(w.balance(&w.owner), net * UNIT);
        assert_eq!(w.balance(&w.v.address), reserve * UNIT);
    }
}
