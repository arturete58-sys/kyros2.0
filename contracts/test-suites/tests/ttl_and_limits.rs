//! Soroban state archival and network limits: what a vault writes lives as
//! long as the network allows, the shared wasm is not paid for by each
//! vault, and nobody can make a vault too expensive to use. Threats S7-S8 and
//! D1-D3 in docs/threat-model.md.
#![allow(clippy::arithmetic_side_effects)] // test code: amounts are small and known
use kyros_reserve_vault::{Payment, VaultError, MAX_SCHEDULED};
use kyros_test_suites::*;
use kyros_types::{InvoiceTerms, DAY_IN_LEDGERS, TTL_EXTEND_TO};
use soroban_sdk::{
    contracttype,
    testutils::{storage::Persistent as _, Address as _, Deployer as _, Ledger},
    vec, Address, MuxedAddress,
};

/// The vault's own ledger keys, rebuilt here: a `#[contracttype]` enum is
/// encoded by its variant names, so these address the vault's entries.
#[contracttype]
enum Key {
    Period(u32, soroban_sdk::Address),
    Held(soroban_sdk::Address),
    Payer(soroban_sdk::Address),
    Scheduled(u32),
    Open(soroban_sdk::Address),
}

fn ttl(w: &World, k: &Key) -> u32 {
    w.e.as_contract(&w.v.address, || w.e.storage().persistent().get_ttl(k))
}

fn ledgers(w: &World, n: u32) {
    w.e.ledger().with_mut(|l| {
        l.sequence_number += n;
        l.timestamp += n as u64 * 5;
    });
}

/// S7. Every entry a call writes is extended to the longest time the
/// network allows (`TTL_EXTEND_TO`, about six months), and so is the
/// vault's instance. The wasm, shared by every vault, is not: the keeper
/// extends it once for all.
#[test]
fn what_a_vault_writes_lives_as_long_as_the_network_allows() {
    let w = World::new();
    let code = w.e.deployer().get_contract_code_ttl(&w.v.address);
    let client = Address::generate(&w.e);
    w.v.expect_payer(
        &client,
        &InvoiceTerms {
            vat_bps: 0,
            withholding_bps: 0,
            buckets: vec![&w.e],
        },
    );
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
                amount: UNIT,
            },
        ],
        &to,
    );
    for k in [
        Key::Period(q, w.token.clone()),
        Key::Held(w.token.clone()),
        Key::Payer(client.clone()),
        Key::Scheduled(id),
        Key::Open(w.token.clone()),
    ] {
        assert_eq!(ttl(&w, &k), TTL_EXTEND_TO);
    }
    assert_eq!(
        w.e.deployer().get_contract_instance_ttl(&w.v.address),
        TTL_EXTEND_TO
    );
    assert_eq!(w.e.deployer().get_contract_code_ttl(&w.v.address), code);
}

/// S8. A vault nobody touches for almost the whole extension still works,
/// and its next use gives every entry it touches its full life again: no
/// owner action or keeper is needed for a vault in use.
#[test]
fn an_idle_vault_comes_back_to_full_life_on_its_next_use() {
    let w = World::new();
    w.pay(1_210 * UNIT);
    let q = w.v.current_period();
    // Almost six months idle (the wasm is the keeper's, so keep it alive here).
    let idle = TTL_EXTEND_TO - DAY_IN_LEDGERS;
    w.e.deployer()
        .extend_ttl(w.v.address.clone(), TTL_EXTEND_TO, TTL_EXTEND_TO);
    ledgers(&w, idle);
    assert_eq!(ttl(&w, &Key::Period(q, w.token.clone())), DAY_IN_LEDGERS);
    // The quarter's books are still there: its reserve is released.
    assert_eq!(w.v.release(&q, &w.token), 410 * UNIT);
    assert_eq!(ttl(&w, &Key::Period(q, w.token.clone())), TTL_EXTEND_TO);
    assert_eq!(ttl(&w, &Key::Held(w.token.clone())), TTL_EXTEND_TO);
}

/// D1. Nobody can make a vault more expensive to use by paying into it: the
/// thousandth payment of a period reads and writes exactly what the second
/// one did.
#[test]
fn the_cost_of_a_payment_does_not_grow_with_the_number_of_payments() {
    let w = World::new();
    w.e.cost_estimate().budget().reset_unlimited();
    let cost = |w: &World| {
        w.pay(UNIT);
        let r = w.e.cost_estimate().resources();
        (
            r.disk_read_entries + r.memory_read_entries,
            r.write_entries,
            r.write_bytes,
        )
    };
    // The period's first payment also opens it (one more entry); measure
    // from the second.
    w.pay(UNIT);
    let first = cost(&w);
    for _ in 0..1_000 {
        w.pay(1);
    }
    let later = cost(&w);
    // Same entries, and the period's book grows by nothing: same bytes.
    assert_eq!(first, later);
    // Instructions are not compared: the test host keeps every event of the
    // run and its CPU count grows with any calls, the vault's or not (1,000
    // plain transfers do the same). Entries and bytes are what the network's
    // limits and rent depend on, and they do not move.
}

/// D2. Lists the owner fills have hard caps that answer `TooMany`, never a
/// resource error halfway through a call.
#[test]
fn every_list_has_a_cap_with_a_clear_error() {
    let w = World::new();
    w.pay(1_210 * UNIT);
    let q = w.v.current_period();
    let to: MuxedAddress = w.tax.clone().into();
    let one = vec![
        &w.e,
        Payment {
            period: q,
            token: w.token.clone(),
            bucket: w.vat(),
            amount: 1,
        },
    ];
    for _ in 0..MAX_SCHEDULED {
        w.v.schedule(&(FEB_10_2027 + DAY), &one, &to);
    }
    assert_eq!(
        w.v.try_schedule(&(FEB_10_2027 + DAY), &one, &to),
        Err(Ok(VaultError::TooMany))
    );
    // Running every one of them stays within the network's limits, each in
    // its own transaction.
    w.at(FEB_10_2027 + DAY);
    for id in w.v.scheduled_ids().iter() {
        w.e.cost_estimate().budget().reset_default();
        assert_eq!(w.v.run_scheduled(&id), 1);
    }
}

/// D3. Junk sent to a user's Inbox (tokens the vault does not take, from
/// anyone) never blocks sweeping the real payments.
#[test]
fn junk_in_the_inbox_does_not_block_real_payments() {
    let w = World::new();
    let inbox = kyros_inbox::InboxClient::new(
        &w.e,
        &w.e.register(kyros_inbox::Inbox, (w.v.address.clone(),)),
    );
    let attacker = Address::generate(&w.e);
    for _ in 0..20 {
        let junk =
            w.e.register_stellar_asset_contract_v2(attacker.clone())
                .address();
        soroban_sdk::token::StellarAssetClient::new(&w.e, &junk).mint(&inbox.address, &1);
        // The vault refuses the currency; the sweep of it fails alone.
        assert!(inbox.try_sweep(&junk).is_err());
    }
    w.mint(&inbox.address, 121 * UNIT);
    w.e.cost_estimate().budget().reset_default();
    let s = inbox.sweep(&w.token);
    assert_eq!((s.net, s.reserve), (80 * UNIT, 41 * UNIT));
}
