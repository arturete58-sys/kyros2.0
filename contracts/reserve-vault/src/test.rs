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
            DUE_OFFSET,
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
            DUE_OFFSET,
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
