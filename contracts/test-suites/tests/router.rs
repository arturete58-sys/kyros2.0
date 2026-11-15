//! The Router: signatures cover exact transfers, a fake vault cannot pull
//! more than the payer signed, runs are all or nothing, and random payments
//! and runs conserve every unit. Threats R1-R4 in docs/threat-model.md.
#![allow(clippy::arithmetic_side_effects)] // test code: amounts are small and known
use arbitrary::{Arbitrary, Unstructured};
use kyros_router::{Payout, Router, RouterClient};
use kyros_test_suites::scenarios::router::{Op, Run};
use kyros_test_suites::*;
use proptest::prelude::*;
use soroban_sdk::{
    testutils::{Address as _, MockAuth, MockAuthInvoke},
    vec, Address, IntoVal,
};

fn router(w: &World) -> RouterClient<'static> {
    RouterClient::new(&w.e, &w.e.register(Router, ()))
}

/// R1. The payer signs one tree: the Router call, the vault's `receive`,
/// and the two exact transfers of the split. That tree pays once, and it
/// does not cover a different amount.
#[test]
fn the_payer_signs_exact_transfers_and_nothing_else() {
    let w = World::new();
    let r = router(&w);
    w.e.set_auths(&[]);
    let gross = 1_210 * UNIT;
    let reference = w.reference(1);
    let pay_args = (
        w.payer.clone(),
        w.v.address.clone(),
        w.token.clone(),
        gross,
        reference.clone(),
    );
    let receive_args = (w.payer.clone(), w.token.clone(), gross, reference.clone());
    let net = (w.payer.clone(), w.owner.clone(), 800 * UNIT);
    let reserve = (w.payer.clone(), w.v.address.clone(), 410 * UNIT);
    let transfers = [
        MockAuthInvoke {
            contract: &w.token,
            fn_name: "transfer",
            args: net.into_val(&w.e),
            sub_invokes: &[],
        },
        MockAuthInvoke {
            contract: &w.token,
            fn_name: "transfer",
            args: reserve.into_val(&w.e),
            sub_invokes: &[],
        },
    ];
    let receive = [MockAuthInvoke {
        contract: &w.v.address,
        fn_name: "receive",
        args: receive_args.into_val(&w.e),
        sub_invokes: &transfers,
    }];
    let tree = MockAuth {
        address: &w.payer,
        invoke: &MockAuthInvoke {
            contract: &r.address,
            fn_name: "pay",
            args: pay_args.into_val(&w.e),
            sub_invokes: &receive,
        },
    };
    // A different amount is not what was signed.
    w.e.mock_auths(std::slice::from_ref(&tree));
    assert!(r
        .try_pay(&w.payer, &w.v.address, &w.token, &(gross + 1), &reference)
        .is_err());
    // The exact payment goes through.
    w.e.mock_auths(&[tree]);
    let s = r.pay(&w.payer, &w.v.address, &w.token, &gross, &reference);
    assert_eq!((s.net, s.reserve), (800 * UNIT, 410 * UNIT));
    assert_eq!(w.balance(&w.payer), 10_000 * UNIT - gross);
}

/// R2. A contract posing as a vault tries to pull twice the payment: the
/// payer signed a transfer of the payment only, so nothing moves.
#[test]
fn a_fake_vault_cannot_pull_more_than_the_payer_signed() {
    let w = World::new();
    let r = router(&w);
    let greedy = w.e.register(GreedyVault, ());
    w.e.set_auths(&[]);
    let gross = 100 * UNIT;
    let reference = w.reference(2);
    let signed = [MockAuthInvoke {
        contract: &w.token,
        fn_name: "transfer",
        args: (w.payer.clone(), greedy.clone(), gross).into_val(&w.e),
        sub_invokes: &[],
    }];
    let receive = [MockAuthInvoke {
        contract: &greedy,
        fn_name: "receive",
        args: (w.payer.clone(), w.token.clone(), gross, reference.clone()).into_val(&w.e),
        sub_invokes: &signed,
    }];
    w.e.mock_auths(&[MockAuth {
        address: &w.payer,
        invoke: &MockAuthInvoke {
            contract: &r.address,
            fn_name: "pay",
            args: (
                w.payer.clone(),
                greedy.clone(),
                w.token.clone(),
                gross,
                reference.clone(),
            )
                .into_val(&w.e),
            sub_invokes: &receive,
        },
    }]);
    let before = w.balance(&w.payer);
    assert!(r
        .try_pay(&w.payer, &greedy, &w.token, &gross, &reference)
        .is_err());
    assert_eq!(w.balance(&w.payer), before);
    assert_eq!(w.balance(&greedy), 0);
}

/// R3. A run with one payout to an address that is not a vault moves
/// nothing at all.
#[test]
fn a_run_to_a_non_vault_moves_nothing() {
    let w = World::new();
    let r = router(&w);
    let stranger = Address::generate(&w.e);
    let payouts = vec![
        &w.e,
        Payout {
            vault: w.v.address.clone(),
            gross: 121 * UNIT,
            reference: w.reference(1),
        },
        Payout {
            vault: stranger,
            gross: 121 * UNIT,
            reference: w.reference(2),
        },
    ];
    let before = (
        w.balance(&w.payer),
        w.balance(&w.owner),
        w.balance(&w.v.address),
    );
    assert!(r.try_pay_many(&w.payer, &w.token, &payouts).is_err());
    assert_eq!(
        (
            w.balance(&w.payer),
            w.balance(&w.owner),
            w.balance(&w.v.address)
        ),
        before
    );
}

fn ops(bytes: &[u8]) -> std::vec::Vec<Op> {
    let mut u = Unstructured::new(bytes);
    let mut v = std::vec::Vec::new();
    while !u.is_empty() && v.len() < 30 {
        match Op::arbitrary(&mut u) {
            Ok(op) => v.push(op),
            Err(_) => break,
        }
    }
    v
}

proptest! {
    #![proptest_config(ProptestConfig { cases: cases(40), failure_persistence: None, ..ProptestConfig::default() })]

    /// R4. Random payments and runs over three vaults (one refuses the
    /// token): every unit is accounted for, refused calls move nothing, and
    /// the Router never holds funds.
    #[test]
    fn every_unit_is_accounted_for(bytes in prop::collection::vec(any::<u8>(), 0..1_024)) {
        let mut run = Run::new();
        for op in ops(&bytes) {
            run.apply(&op);
        }
    }
}
