//! Stateful property tests: random sequences of everything that can happen
//! to a vault (payments, deposits, tax payments, releases, corrections,
//! donations, a yield strategy earning, lending out and being rebalanced,
//! time passing), checking after every step that the protocol's invariants
//! hold, whether the step succeeded or was refused. proptest shrinks any
//! failure to the shortest sequence that breaks an invariant.
//!
//! The scenario and its invariants live in `kyros_test_suites::scenarios::vault`
//! (shared with the nightly fuzzer). Invariants (docs/threat-model.md):
//!
//! - I1 `held` is the sum of every bucket of every period.
//! - I2 Each period balances: reserved = buckets + paid + released + converted.
//! - I3 Solvent: the vault and its strategy hold at least `held`.
//! - I4 A refused call changes nothing.
//! - I5 The tax destination receives exactly what the books say was paid.
//! - I6 The owner receives exactly the net of each payment, plus what was
//!   released, corrected or harvested: nothing else leaves to anyone.
//! - I7 Nothing is released before its bucket's due date.
//! - I8 After `invest`, the strategy holds no more than its share of the
//!   reserve not due soon (unless it cannot pay out).
#![allow(clippy::arithmetic_side_effects)] // test code: amounts are small and known
use kyros_test_suites::scenarios::vault::{Op, Run};
use kyros_test_suites::*;
use proptest::prelude::*;

fn amount() -> impl Strategy<Value = i128> {
    prop_oneof![1i128..=10, 1i128..=2_000 * UNIT, Just(0i128), Just(-1i128),]
}

fn op() -> impl Strategy<Value = Op> {
    prop_oneof![
        4 => amount().prop_map(Op::Pay),
        1 => (any::<bool>(), amount()).prop_map(|(vat, amount)| Op::Deposit { vat, amount }),
        2 => (0usize..4, any::<bool>(), amount()).prop_map(|(period, vat, amount)| Op::PayTax { period, vat, amount }),
        2 => (0usize..4).prop_map(|period| Op::Release { period }),
        1 => (0usize..4, amount()).prop_map(|(period, amount)| Op::Correct { period, amount }),
        1 => Just(Op::ApplyCorrections),
        1 => (1i128..=500 * UNIT).prop_map(Op::Donate),
        1 => (1i128..=50 * UNIT).prop_map(Op::Earn),
        2 => Just(Op::Invest),
        1 => Just(Op::Harvest),
        1 => any::<bool>().prop_map(Op::Lend),
        2 => (0u64..=45).prop_map(Op::Days),
    ]
}

proptest! {
    #![proptest_config(ProptestConfig {
        cases: cases(48),
        max_shrink_iters: 2_000,
        // Failures are kept as named regression tests below, not in files.
        failure_persistence: None,
        ..ProptestConfig::default()
    })]

    #[test]
    fn the_books_hold_under_any_sequence_of_operations(ops in prop::collection::vec(op(), 1..40)) {
        let mut run = Run::new();
        for o in &ops {
            run.apply(o);
        }
    }
}

/// Found by the property test above (shrunk from a random run): a few units
/// of reserve, one quarter due within the horizon. `invest` brought back
/// only what was due soon, leaving the strategy one unit above its share.
/// It now keeps a single rule, the share, which also keeps what is due soon
/// in the vault.
#[test]
fn regression_reserve_coming_due_leaves_the_strategy_within_its_share() {
    let mut run = Run::new();
    for o in [
        Op::Days(5),
        Op::Days(21),
        Op::Days(32),
        Op::Days(43),
        Op::Pay(7),
        Op::Days(40),
        Op::Pay(1),
        Op::Invest,
        Op::Days(16),
        Op::Invest,
    ] {
        run.apply(&o);
    }
}
