//! Authorization: every call that moves the reserve or changes the vault
//! needs the owner's signature, a signature for other arguments does not
//! count, and the calls anyone may make can only pay the tax destination or
//! the owner. Threats S1-S4 in docs/threat-model.md.
#![allow(clippy::arithmetic_side_effects)] // test code: amounts are small and known
use kyros_reserve_vault::{Payment, VaultError};
use kyros_test_suites::*;
use kyros_types::{Bucket, Fixed, InvoiceTerms};
use soroban_sdk::{
    testutils::{Address as _, MockAuth, MockAuthInvoke},
    vec, Address, IntoVal, MuxedAddress, Symbol,
};

/// A vault with a paid invoice, then no signatures at all.
fn unsigned() -> (World, u32) {
    let w = World::new();
    w.pay(1_210 * UNIT);
    let q = w.v.current_period();
    w.e.set_auths(&[]);
    (w, q)
}

/// S1. With no signature, nothing that moves the reserve or changes the
/// vault goes through, and the books do not move.
#[test]
fn every_owner_call_needs_the_owner() {
    let (w, q) = unsigned();
    let e = &w.e;
    let before = w.snapshot(q);
    let other = Address::generate(e);
    let r = w.reference(7);
    let terms = InvoiceTerms {
        vat_bps: 0,
        withholding_bps: 0,
        buckets: vec![e],
    };
    let one = vec![
        e,
        Payment {
            period: q,
            token: w.token.clone(),
            bucket: w.vat(),
            amount: 1,
        },
    ];
    let to: MuxedAddress = w.tax.clone().into();
    // Each call returns Err(Err(_)): the host refused the missing signature.
    let refused = [
        w.v.try_pay_tax(&q, &w.token, &w.vat(), &1).is_err(),
        w.v.try_pay_tax_to(&q, &w.token, &w.vat(), &1, &to).is_err(),
        w.v.try_harvest(&w.token).is_err(),
        w.v.try_propose_rule(&spain(e)).is_err(),
        w.v.try_propose_rule_at(&spain(e), &0).is_err(),
        w.v.try_propose_destination(&other).is_err(),
        w.v.try_propose_payout(&w.owner).is_err(),
        w.v.try_propose_fixed(&vec![
            e,
            Fixed {
                bucket: Symbol::new(e, "fee"),
                token: w.token.clone(),
                amount: 1,
            },
        ])
        .is_err(),
        w.v.try_propose_token(&w.token).is_err(),
        w.v.try_propose_correction(&q, &w.token, &w.vat(), &1)
            .is_err(),
        w.v.try_schedule(&0, &one, &to).is_err(),
        w.v.try_set_due(&w.vat(), &q, &q, &0).is_err(),
        w.v.try_expect_invoice(&r, &terms).is_err(),
        w.v.try_expect_payer(&other, &terms).is_err(),
        w.v.try_cancel().is_err(),
        w.v.try_stop_strategy().is_err(),
        w.v.try_stop_conversion().is_err(),
        w.v.try_unfollow().is_err(),
        w.v.try_release(&q, &w.token).is_err(),
    ];
    assert!(refused.iter().all(|x| *x), "{refused:?}");
    // The host's refusal, not a contract error: no check ran ahead of the signature.
    assert!(matches!(
        w.v.try_pay_tax(&q, &w.token, &w.vat(), &1),
        Err(Err(_))
    ));
    assert!(matches!(w.v.try_propose_destination(&other), Err(Err(_))));
    assert_eq!(w.snapshot(q), before);
    assert_eq!(w.v.pending_destination(), None);
    assert_eq!(w.v.scheduled_ids().len(), 0);
}

/// S2. A signature from someone else, even for the exact call, is not the
/// owner's: an attacker who signs `propose_destination` (to send the tax to
/// themselves) changes nothing.
#[test]
fn someone_elses_signature_does_not_count() {
    let (w, _) = unsigned();
    let attacker = Address::generate(&w.e);
    w.e.mock_auths(&[MockAuth {
        address: &attacker,
        invoke: &MockAuthInvoke {
            contract: &w.v.address,
            fn_name: "propose_destination",
            args: (attacker.clone(),).into_val(&w.e),
            sub_invokes: &[],
        },
    }]);
    assert!(w.v.try_propose_destination(&attacker).is_err());
    assert_eq!(w.v.pending_destination(), None);
}

/// S3. The payer's signature is for one amount: a call asking for more (a
/// compromised Router, a malicious frontend) fails, and nothing is taken.
#[test]
fn a_payer_signature_covers_only_the_amount_signed() {
    let w = World::new();
    w.e.set_auths(&[]);
    let r = w.reference(3);
    w.e.mock_auths(&[MockAuth {
        address: &w.payer,
        invoke: &MockAuthInvoke {
            contract: &w.v.address,
            fn_name: "receive",
            args: (w.payer.clone(), w.token.clone(), 100 * UNIT, r.clone()).into_val(&w.e),
            sub_invokes: &[],
        },
    }]);
    let before = w.balance(&w.payer);
    assert!(w
        .v
        .try_receive(&w.payer, &w.token, &(1_000 * UNIT), &r)
        .is_err());
    assert_eq!(w.balance(&w.payer), before);
}

/// S4. The calls anyone may make (a keeper does) need no signature, and can
/// only send money where the owner already decided: the tax destination, or
/// the owner after the notice.
#[test]
fn calls_anyone_may_make_pay_only_where_the_owner_decided() {
    let w = World::new();
    w.pay(1_210 * UNIT);
    let q = w.v.current_period();
    let to: MuxedAddress = w.tax.clone().into();
    let id = w.v.schedule(
        &(FEB_10_2027 + DAY),
        &vec![
            &w.e,
            Payment {
                period: q,
                token: w.token.clone(),
                bucket: w.vat(),
                amount: 50 * UNIT,
            },
        ],
        &to,
    );
    let c =
        w.v.propose_correction(&q, &w.token, &w.irpf(), &(20 * UNIT));
    w.at(FEB_10_2027 + NOTICE);
    w.e.set_auths(&[]);
    let keeper = Address::generate(&w.e);
    let (tax, owner) = (w.balance(&w.tax), w.balance(&w.owner));
    assert_eq!(w.v.run_scheduled(&id), 50 * UNIT);
    assert_eq!(w.v.apply_correction(&c), 20 * UNIT);
    assert_eq!(w.balance(&w.tax) - tax, 50 * UNIT);
    assert_eq!(w.balance(&w.owner) - owner, 20 * UNIT);
    assert_eq!(w.balance(&keeper), 0);
    // Running either again pays nothing more.
    assert_eq!(
        w.v.try_run_scheduled(&id),
        Err(Ok(VaultError::UnknownPayment))
    );
    assert_eq!(
        w.v.try_apply_correction(&c),
        Err(Ok(VaultError::UnknownCorrection))
    );
}

/// S3. A payer cannot lower its own tax by registering terms for itself:
/// `expect_payer` is the owner's, and the payer's signature does not count.
#[test]
fn a_payer_cannot_choose_its_own_terms() {
    let w = World::new();
    w.e.set_auths(&[]);
    let no_vat = InvoiceTerms {
        vat_bps: 0,
        withholding_bps: 0,
        buckets: vec![
            &w.e,
            Bucket {
                name: w.irpf(),
                bps: 0,
            },
        ],
    };
    w.e.mock_auths(&[MockAuth {
        address: &w.payer,
        invoke: &MockAuthInvoke {
            contract: &w.v.address,
            fn_name: "expect_payer",
            args: (w.payer.clone(), no_vat.clone()).into_val(&w.e),
            sub_invokes: &[],
        },
    }]);
    assert!(w.v.try_expect_payer(&w.payer, &no_vat).is_err());
    assert_eq!(w.v.payer(&w.payer), None);
}
