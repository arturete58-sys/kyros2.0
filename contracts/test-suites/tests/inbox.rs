//! A user's Inbox: only the owner moves it, only to their own vault and
//! only after notice; anyone sweeps, and a sweep pays only the split; random
//! sequences conserve every unit. Threats N1-N4 in docs/threat-model.md.
#![allow(clippy::arithmetic_side_effects)] // test code: amounts are small and known
use arbitrary::{Arbitrary, Unstructured};
use kyros_inbox::{Inbox, InboxClient, InboxError};
use kyros_test_suites::scenarios::inbox::{Op, Run};
use kyros_test_suites::*;
use proptest::prelude::*;
use soroban_sdk::testutils::Address as _;
use soroban_sdk::Address;

fn inbox(w: &World) -> InboxClient<'static> {
    InboxClient::new(&w.e, &w.e.register(Inbox, (w.v.address.clone(),)))
}

/// N1. Sweeping needs no signature, and pays only the owner (net) and the
/// vault (reserve). Sweeping again pays nothing twice.
#[test]
fn anyone_sweeps_and_only_the_split_is_paid() {
    let w = World::new();
    let i = inbox(&w);
    w.mint(&i.address, 121 * UNIT);
    w.e.set_auths(&[]);
    let s = i.sweep(&w.token);
    assert_eq!((s.net, s.reserve), (80 * UNIT, 41 * UNIT));
    assert_eq!(w.balance(&w.owner), 80 * UNIT);
    assert_eq!(w.balance(&w.v.address), 41 * UNIT);
    assert_eq!(i.try_sweep(&w.token), Err(Ok(InboxError::NothingToSweep)));
}

/// N2. Moving the Inbox needs the owner's signature, and only to a vault of
/// the same owner; a move applies after the vault's notice and can be
/// cancelled until then.
#[test]
fn only_the_owner_moves_it_to_their_own_vault_after_notice() {
    let run = Run::new();
    let (e, i) = (&run.e, &run.inbox);
    // No signature: refused.
    e.set_auths(&[]);
    assert!(i.try_propose_vault(&run.vaults[1].address).is_err());
    e.mock_all_auths();
    // Someone else's vault: refused even with every signature.
    assert_eq!(
        i.try_propose_vault(&run.stranger_vault),
        Err(Ok(InboxError::NotSameOwner))
    );
    // The owner's second vault: only after the notice.
    i.propose_vault(&run.vaults[1].address);
    assert_eq!(i.vault(), run.vaults[0].address);
    i.cancel_move();
    i.propose_vault(&run.vaults[1].address);
    use soroban_sdk::testutils::Ledger as _;
    e.ledger().set_timestamp(FEB_10_2027 + NOTICE);
    assert_eq!(i.vault(), run.vaults[1].address);
    assert_eq!(i.try_cancel_move(), Err(Ok(InboxError::AlreadyMoved)));
}

/// N3. A token the vault does not take is returned only to the owner's
/// payout address, never to whoever asks; the accepted token is never
/// "returned", only split.
#[test]
fn junk_goes_back_to_the_owner_only() {
    let w = World::new();
    let i = inbox(&w);
    let junk =
        w.e.register_stellar_asset_contract_v2(Address::generate(&w.e))
            .address();
    soroban_sdk::token::StellarAssetClient::new(&w.e, &junk).mint(&i.address, &(5 * UNIT));
    w.mint(&i.address, 121 * UNIT);
    w.e.set_auths(&[]);
    assert_eq!(i.return_unaccepted(&junk), 5 * UNIT);
    assert_eq!(
        soroban_sdk::token::Client::new(&w.e, &junk).balance(&w.owner),
        5 * UNIT
    );
    assert_eq!(
        i.try_return_unaccepted(&w.token),
        Err(Ok(InboxError::TokenAccepted))
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

    /// N4. Random payments, junk, sweeps, returns and moves (including an
    /// attempt to move to someone else's vault): every unit is accounted for.
    #[test]
    fn every_unit_is_accounted_for(bytes in prop::collection::vec(any::<u8>(), 0..1_024)) {
        let mut run = Run::new();
        for op in ops(&bytes) {
            run.apply(&op);
        }
    }
}
