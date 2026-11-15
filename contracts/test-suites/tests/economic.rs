//! Economic and accounting attacks: donations, dust, the edges of i128, zero
//! and negative amounts, and overdrafts. Threats E1-E6 in docs/threat-model.md.
#![allow(clippy::arithmetic_side_effects)] // test code: amounts are small and known
use kyros_reserve_vault::VaultError;
use kyros_test_suites::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    Address,
};

/// E1. Tokens sent straight to the vault (a "donation", the first step of a
/// share-inflation attack) are not reserve: the books, the split of the next
/// payment and what can be paid or released do not change. There are no
/// shares to inflate; only the owner can take the surplus, with `harvest`.
#[test]
fn a_donation_changes_no_books_and_only_the_owner_can_take_it() {
    let w = World::new();
    let attacker = Address::generate(&w.e);
    w.mint(&attacker, 5_000 * UNIT);
    // Before the first payment and after it.
    soroban_sdk::token::Client::new(&w.e, &w.token).transfer(
        &attacker,
        &w.v.address,
        &(1_000 * UNIT),
    );
    let s = w.pay(1_210 * UNIT);
    assert_eq!((s.vat, s.parts.get(0).unwrap()), (210 * UNIT, 200 * UNIT));
    soroban_sdk::token::Client::new(&w.e, &w.token).transfer(
        &attacker,
        &w.v.address,
        &(1_000 * UNIT),
    );
    let q = w.v.current_period();
    let p = w.v.period(&q, &w.token);
    assert_eq!(p.reserved, 410 * UNIT);
    assert_eq!(w.held(), 410 * UNIT);
    assert_eq!(w.balance(&w.v.address), 2_410 * UNIT);
    // The VAT bucket still pays at most its 210.
    assert_eq!(
        w.v.try_pay_tax(&q, &w.token, &w.vat(), &(211 * UNIT)),
        Err(Ok(VaultError::ExceedsReserve))
    );
    // Release before the due date is still refused, donation or not.
    assert_eq!(w.v.try_release(&q, &w.token), Err(Ok(VaultError::NotDue)));
    // The surplus goes to the owner's payout address, never to the donor.
    let before = w.balance(&w.owner);
    assert_eq!(w.v.harvest(&w.token), 2_000 * UNIT);
    assert_eq!(w.balance(&w.owner) - before, 2_000 * UNIT);
    assert_eq!(w.balance(&attacker), 3_000 * UNIT);
    assert_eq!(w.balance(&w.v.address), 410 * UNIT);
}

/// E2. Dust: splitting a payment into one-unit pieces cannot dodge the tax.
/// VAT is what the base leaves, so it is never rounded down: each one-unit
/// payment books one unit of VAT. Other buckets round down by less than one
/// unit per payment. The payer pays every fee, and the books add up exactly.
#[test]
fn dust_payments_cannot_drain_or_unbalance_the_reserve() {
    let w = World::new();
    w.e.cost_estimate().budget().reset_unlimited();
    let q = w.v.current_period();
    let n = 2_000i128;
    let mut net = 0;
    for _ in 0..n {
        let s = w.pay(1);
        assert_eq!(s.net + s.reserve, 1);
        net += s.net;
    }
    let p = w.v.period(&q, &w.token);
    // Exactly: VAT on 1 unit is 1 - floor(1 * 10000 / 12100) = 1 (VAT is never
    // rounded down); income tax on a base of 0 is 0.
    assert_eq!(p.buckets.get(w.vat()).unwrap(), n);
    assert_eq!(p.buckets.get(w.irpf()).unwrap(), 0);
    assert_eq!(net, 0);
    assert_eq!(p.reserved, w.held());
    assert_eq!(w.balance(&w.v.address), w.held());
}

/// E3. The largest amount i128 can hold splits exactly (products are taken
/// in 256 bits), and an amount that would overflow the books is refused
/// with a readable code before any token moves; nothing changes.
#[test]
fn the_largest_payment_splits_and_an_overflowing_one_is_refused_cleanly() {
    let e = soroban_sdk::Env::default();
    e.mock_all_auths();
    e.cost_estimate().budget().reset_unlimited();
    e.ledger().set_timestamp(FEB_10_2027);
    // A SEP-41 token whose balances may use the whole i128 range.
    let token = e.register(Token, (7u32,));
    let w = World::with_token(e, token);
    w.mint(&w.payer, i128::MAX - 10_000 * UNIT);
    let q = w.v.current_period();
    let quote = w.v.quote(&i128::MAX);
    let s = w.pay(i128::MAX);
    assert_eq!(s, quote);
    assert_eq!(s.net + s.reserve, i128::MAX);
    assert_eq!(w.held(), s.reserve);
    assert_eq!(w.balance(&w.v.address), s.reserve);
    // A deposit that would take the VAT bucket past i128::MAX.
    let other = Address::generate(&w.e);
    w.mint(&other, i128::MAX);
    let before = w.snapshot(q);
    assert_eq!(
        w.v.try_deposit(&other, &w.token, &q, &w.vat(), &i128::MAX),
        Err(Ok(VaultError::MathOverflow))
    );
    assert_eq!(w.snapshot(q), before);
    assert_eq!(w.balance(&other), i128::MAX);
}

/// E4. Zero and negative amounts are refused everywhere money moves.
#[test]
fn zero_and_negative_amounts_are_refused_everywhere() {
    let w = World::new();
    w.pay(1_210 * UNIT);
    let q = w.v.current_period();
    for bad in [0i128, -1, i128::MIN] {
        assert_eq!(
            w.v.try_receive(&w.payer, &w.token, &bad, &w.reference(1)),
            Err(Ok(VaultError::InvalidAmount))
        );
        assert_eq!(
            w.v.try_deposit(&w.payer, &w.token, &q, &w.vat(), &bad),
            Err(Ok(VaultError::InvalidAmount))
        );
        assert_eq!(
            w.v.try_pay_tax(&q, &w.token, &w.vat(), &bad),
            Err(Ok(VaultError::InvalidAmount))
        );
        assert_eq!(
            w.v.try_propose_correction(&q, &w.token, &w.vat(), &bad),
            Err(Ok(VaultError::InvalidAmount))
        );
    }
}

/// E5. No bucket pays more than it holds, however the request is split, and
/// one bucket can never pay out another's reserve.
#[test]
fn no_bucket_pays_more_than_it_holds() {
    let w = World::new();
    w.pay(1_210 * UNIT);
    let q = w.v.current_period();
    w.v.pay_tax(&q, &w.token, &w.vat(), &(200 * UNIT));
    assert_eq!(
        w.v.try_pay_tax(&q, &w.token, &w.vat(), &(10 * UNIT + 1)),
        Err(Ok(VaultError::ExceedsReserve))
    );
    w.v.pay_tax(&q, &w.token, &w.vat(), &(10 * UNIT));
    assert_eq!(
        w.v.try_pay_tax(&q, &w.token, &w.vat(), &1),
        Err(Ok(VaultError::ExceedsReserve))
    );
    // The income-tax bucket is untouched.
    let p = w.v.period(&q, &w.token);
    assert_eq!(p.buckets.get(w.irpf()).unwrap(), 200 * UNIT);
    assert_eq!(p.paid, 210 * UNIT);
    assert_eq!(w.balance(&w.tax), 210 * UNIT);
}

/// E6. A notice period beyond a year is refused at creation
/// (`InvalidNotice` = 42), so every date the vault computes from it stays
/// far inside u64.
#[test]
#[should_panic(expected = "Error(Contract, #42)")]
fn an_unbounded_notice_is_refused() {
    let w = World::new();
    w.e.register(
        kyros_reserve_vault::ReserveVault,
        (
            w.owner.clone(),
            spain(&w.e),
            w.tax.clone(),
            u64::MAX,
            kyros_types::PeriodKind::Quarter,
            kyros_reserve_vault::dues_after(&w.e, DUE_OFFSET),
            soroban_sdk::vec![&w.e, w.token.clone()],
        ),
    );
}
