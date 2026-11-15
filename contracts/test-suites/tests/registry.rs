//! The Rate Registry and a vault following it: rates at the edges, changes
//! that apply exactly on their date, a ceiling the vault keeps, the
//! publisher's exclusive rights, and a history that never changes. Threats
//! G1-G5 in docs/threat-model.md.
#![allow(clippy::arithmetic_side_effects)] // test code: amounts are small and known
use arbitrary::{Arbitrary, Unstructured};
use kyros_rate_registry::RegistryError;
use kyros_test_suites::scenarios::registry::{Op, Run, REGISTRY_NOTICE};
use kyros_test_suites::*;
use proptest::prelude::*;
use soroban_sdk::{symbol_short, testutils::Ledger, Address};

fn es() -> (soroban_sdk::Symbol, soroban_sdk::Symbol) {
    (symbol_short!("ES"), symbol_short!("standard"))
}

/// G1. 0% and 100% are rates like any other; 100.01% is refused.
#[test]
fn rates_at_the_edges() {
    let run = Run::new();
    let (c, n) = es();
    let from = FEB_10_2027 + REGISTRY_NOTICE;
    run.reg.publish(&c, &n, &from, &0);
    run.reg.publish(&c, &n, &(from + DAY), &10_000);
    assert_eq!(
        run.reg.try_publish(&c, &n, &(from + 2 * DAY), &10_001),
        Err(Ok(RegistryError::InvalidRate))
    );
    assert_eq!(
        run.reg.try_seed(&symbol_short!("FR"), &n, &10_001),
        Err(Ok(RegistryError::InvalidRate))
    );
}

/// G2. A change applies on its date, to the second, in the vault that
/// follows the registry, with no signature from anyone: the last payment
/// before it books the old VAT, the first one at it the new.
#[test]
fn a_change_applies_exactly_on_its_date() {
    let run = Run::new();
    let w = &run.w;
    let (c, n) = es();
    let at = FEB_10_2027 + REGISTRY_NOTICE + 3_600;
    run.reg.publish(&c, &n, &at, &2_200);
    w.mint(&w.payer, 50_000 * UNIT);
    w.e.ledger().set_timestamp(at - 1);
    assert_eq!(w.pay(12_100 * UNIT).vat, 2_100 * UNIT);
    w.e.ledger().set_timestamp(at);
    let s = w.pay(12_200 * UNIT);
    assert_eq!(s.vat, 2_200 * UNIT);
}

/// G3. A rate above the vault's ceiling (here, 100%) is ignored: the vault
/// keeps its own VAT, and follows again when the rate comes back under it.
#[test]
fn a_rate_above_the_ceiling_is_ignored() {
    let run = Run::new();
    let w = &run.w;
    let (c, n) = es();
    let at = FEB_10_2027 + REGISTRY_NOTICE;
    run.reg.publish(&c, &n, &at, &10_000);
    run.reg.publish(&c, &n, &(at + DAY), &2_000);
    w.e.ledger().set_timestamp(at);
    assert_eq!(w.v.quote(&(12_100 * UNIT)).vat, 2_100 * UNIT);
    w.e.ledger().set_timestamp(at + DAY);
    assert_eq!(w.v.quote(&(12_000 * UNIT)).vat, 2_000 * UNIT);
}

/// G4. Only the publisher writes, and a rate in force cannot be withdrawn.
#[test]
fn only_the_publisher_writes_and_history_is_final() {
    let run = Run::new();
    let (c, n) = es();
    let from = FEB_10_2027 + REGISTRY_NOTICE;
    run.w.e.set_auths(&[]);
    assert!(run.reg.try_publish(&c, &n, &from, &2_200).is_err());
    assert!(run.reg.try_seed(&symbol_short!("FR"), &n, &2_000).is_err());
    assert!(run.reg.try_withdraw(&c, &n, &from).is_err());
    assert!(run
        .reg
        .try_set_admin(&<Address as soroban_sdk::testutils::Address>::generate(
            &run.w.e
        ))
        .is_err());
    run.w.e.mock_all_auths();
    run.reg.publish(&c, &n, &from, &2_200);
    run.w.e.ledger().set_timestamp(from);
    assert_eq!(
        run.reg.try_withdraw(&c, &n, &from),
        Err(Ok(RegistryError::AlreadyInForce))
    );
}

fn ops(bytes: &[u8]) -> std::vec::Vec<Op> {
    let mut u = Unstructured::new(bytes);
    let mut v = std::vec::Vec::new();
    while !u.is_empty() && v.len() < 40 {
        match Op::arbitrary(&mut u) {
            Ok(op) => v.push(op),
            Err(_) => break,
        }
    }
    v
}

proptest! {
    #![proptest_config(ProptestConfig { cases: cases(40), failure_persistence: None, ..ProptestConfig::default() })]

    /// G5. Random publications (0%, 100%, out of range, too soon),
    /// withdrawals and time: history stays final, the notice holds, and the
    /// following vault applies exactly the right VAT at every moment.
    #[test]
    fn the_registry_holds_under_any_sequence(bytes in prop::collection::vec(any::<u8>(), 0..1_024)) {
        let mut run = Run::new();
        for op in ops(&bytes) {
            run.apply(&op);
        }
    }
}
