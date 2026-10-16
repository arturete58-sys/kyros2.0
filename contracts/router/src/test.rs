extern crate std;
use super::*;
use kyros_inbox::{Inbox, InboxClient, InboxError};
use kyros_reserve_vault::{ReserveVault, ReserveVaultClient};
use kyros_types::{Bucket, PeriodKind, Rule};
use soroban_sdk::{
    symbol_short,
    testutils::{Address as _, Events, Ledger},
    token::{StellarAssetClient, TokenClient},
    vec, Env, Symbol,
};

const UNIT: i128 = 10_000_000;

struct W {
    e: Env,
    router: RouterClient<'static>,
    vault: ReserveVaultClient<'static>,
    inbox: InboxClient<'static>,
    token: Address,
    owner: Address,
    payer: Address,
}

fn world() -> W {
    let e = Env::default();
    e.mock_all_auths();
    e.ledger().set_timestamp(1_802_260_800);
    let token = e.register_stellar_asset_contract_v2(Address::generate(&e)).address();
    let owner = Address::generate(&e);
    let payer = Address::generate(&e);
    StellarAssetClient::new(&e, &token).mint(&payer, &(10_000 * UNIT));
    let rule = Rule { vat_bps: 2100, buckets: vec![&e, Bucket { name: Symbol::new(&e, "irpf"), bps: 2000 }] };
    let vault = ReserveVaultClient::new(
        &e,
        &e.register(ReserveVault, (owner.clone(), rule, Address::generate(&e), 86_400u64, PeriodKind::Quarter, 0u64, vec![&e, token.clone()])),
    );
    let inbox = InboxClient::new(&e, &e.register(Inbox, (vault.address.clone(),)));
    let router = RouterClient::new(&e, &e.register(Router, ()));
    W { e, router, vault, inbox, token, owner, payer }
}

fn bal(w: &W, a: &Address) -> i128 {
    TokenClient::new(&w.e, &w.token).balance(a)
}

#[test]
fn the_router_splits_inside_the_payers_transaction() {
    let w = world();
    let reference = BytesN::from_array(&w.e, &[9; 32]);
    let s = w.router.pay(&w.payer, &w.vault.address, &w.token, &(1_210 * UNIT), &reference);
    // The payer authorized one tree: the router call, and through it both transfers.
    let auths = w.e.auths();
    assert_eq!(auths.len(), 1);
    assert_eq!(auths[0].0, w.payer);
    // One router event, and it carries the invoice reference.
    let evs = w.e.events().all().filter_by_contract(&w.router.address);
    let list = evs.events();
    assert_eq!(list.len(), 1);
    let soroban_sdk::xdr::ContractEventBody::V0(body) = &list[0].body;
    let want: soroban_sdk::xdr::ScVal = (&reference).try_into().unwrap();
    assert_eq!(body.topics[3], want);
    assert_eq!((s.net, s.reserve), (800 * UNIT, 410 * UNIT));
    assert_eq!(bal(&w, &w.owner), 800 * UNIT);
    assert_eq!(bal(&w, &w.vault.address), 410 * UNIT);
    assert_eq!(bal(&w, &w.payer), (10_000 - 1_210) * UNIT);
}

#[test]
fn the_router_quotes_the_vault_rule() {
    let w = world();
    assert_eq!(w.router.quote(&w.vault.address, &(121 * UNIT)).net, 80 * UNIT);
}

#[test]
fn anyone_can_sweep_an_inbox_and_only_the_owner_and_vault_are_paid() {
    let w = world();
    // A plain SEP-41 transfer to the inbox address: no Kyros integration.
    TokenClient::new(&w.e, &w.token).transfer(&w.payer, &w.inbox.address, &(121 * UNIT));
    // From here no authorization is mocked: sweep is permissionless, and the
    // inbox contract authorizes the vault's two transfers itself.
    w.e.set_auths(&[]);
    let s = w.inbox.sweep(&w.token);
    assert_eq!((s.net, s.reserve), (80 * UNIT, 41 * UNIT));
    assert_eq!(bal(&w, &w.owner), 80 * UNIT);
    assert_eq!(bal(&w, &w.vault.address), 41 * UNIT);
    assert_eq!(bal(&w, &w.inbox.address), 0);
    assert_eq!(w.inbox.sweeps(), 1);
    assert_eq!(w.inbox.try_sweep(&w.token), Err(Ok(InboxError::NothingToSweep)));
    let p = w.vault.period(&w.vault.current_period(), &w.token);
    assert_eq!(p.buckets.get(symbol_short!("vat")).unwrap(), 21 * UNIT);
}

#[test]
fn tokens_the_vault_does_not_accept_go_back_to_the_owner() {
    let w = world();
    let other = w.e.register_stellar_asset_contract_v2(Address::generate(&w.e)).address();
    StellarAssetClient::new(&w.e, &other).mint(&w.inbox.address, &(5 * UNIT));
    assert_eq!(w.inbox.try_return_unaccepted(&w.token), Err(Ok(InboxError::TokenAccepted)));
    w.e.set_auths(&[]);
    assert_eq!(w.inbox.return_unaccepted(&other), 5 * UNIT);
    assert_eq!(TokenClient::new(&w.e, &other).balance(&w.owner), 5 * UNIT);
}

#[test]
fn a_router_payment_without_the_payers_signature_fails() {
    let w = world();
    w.e.set_auths(&[]);
    let reference = BytesN::from_array(&w.e, &[1; 32]);
    assert!(w.router.try_pay(&w.payer, &w.vault.address, &w.token, &UNIT, &reference).is_err());
    assert_eq!(bal(&w, &w.owner), 0);
}
