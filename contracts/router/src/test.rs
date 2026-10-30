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
    let token = e
        .register_stellar_asset_contract_v2(Address::generate(&e))
        .address();
    let owner = Address::generate(&e);
    let payer = Address::generate(&e);
    StellarAssetClient::new(&e, &token).mint(&payer, &(10_000 * UNIT));
    let rule = Rule {
        vat_bps: 2100,
        buckets: vec![
            &e,
            Bucket {
                name: Symbol::new(&e, "irpf"),
                bps: 2000,
            },
        ],
    };
    let vault = ReserveVaultClient::new(
        &e,
        &e.register(
            ReserveVault,
            (
                owner.clone(),
                rule,
                Address::generate(&e),
                86_400u64,
                PeriodKind::Quarter,
                kyros_reserve_vault::dues_after(&e, 0u64),
                vec![&e, token.clone()],
            ),
        ),
    );
    let inbox = InboxClient::new(&e, &e.register(Inbox, (vault.address.clone(),)));
    let router = RouterClient::new(&e, &e.register(Router, ()));
    W {
        e,
        router,
        vault,
        inbox,
        token,
        owner,
        payer,
    }
}

fn bal(w: &W, a: &Address) -> i128 {
    TokenClient::new(&w.e, &w.token).balance(a)
}

#[test]
fn the_router_splits_inside_the_payers_transaction() {
    let w = world();
    let reference = BytesN::from_array(&w.e, &[9; 32]);
    let s = w.router.pay(
        &w.payer,
        &w.vault.address,
        &w.token,
        &(1_210 * UNIT),
        &reference,
    );
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
    assert_eq!(
        w.router.quote(&w.vault.address, &(121 * UNIT)).net,
        80 * UNIT
    );
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
    assert_eq!(
        w.inbox.try_sweep(&w.token),
        Err(Ok(InboxError::NothingToSweep))
    );
    let p = w.vault.period(&w.vault.current_period(), &w.token);
    assert_eq!(p.buckets.get(symbol_short!("vat")).unwrap(), 21 * UNIT);
}

#[test]
fn tokens_the_vault_does_not_accept_go_back_to_the_owner() {
    let w = world();
    let other =
        w.e.register_stellar_asset_contract_v2(Address::generate(&w.e))
            .address();
    StellarAssetClient::new(&w.e, &other).mint(&w.inbox.address, &(5 * UNIT));
    assert_eq!(
        w.inbox.try_return_unaccepted(&w.token),
        Err(Ok(InboxError::TokenAccepted))
    );
    w.e.set_auths(&[]);
    assert_eq!(w.inbox.return_unaccepted(&other), 5 * UNIT);
    assert_eq!(TokenClient::new(&w.e, &other).balance(&w.owner), 5 * UNIT);
}

#[test]
fn a_router_payment_without_the_payers_signature_fails() {
    let w = world();
    w.e.set_auths(&[]);
    let reference = BytesN::from_array(&w.e, &[1; 32]);
    assert!(w
        .router
        .try_pay(&w.payer, &w.vault.address, &w.token, &UNIT, &reference)
        .is_err());
    assert_eq!(bal(&w, &w.owner), 0);
}

#[test]
fn moving_country_moves_the_inbox_to_a_new_vault_after_the_notice() {
    let w = world();
    // Spain (quarterly, 21% + 20%) to Germany (yearly, 19% + 30%): a new vault, same owner.
    let de = Rule {
        vat_bps: 1900,
        buckets: vec![
            &w.e,
            Bucket {
                name: Symbol::new(&w.e, "est"),
                bps: 3000,
            },
        ],
    };
    let new_vault = ReserveVaultClient::new(
        &w.e,
        &w.e.register(
            ReserveVault,
            (
                w.owner.clone(),
                de,
                Address::generate(&w.e),
                86_400u64,
                PeriodKind::Year,
                kyros_reserve_vault::dues_after(&w.e, 300 * 86_400u64),
                vec![&w.e, w.token.clone()],
            ),
        ),
    );
    // Someone else's vault is refused.
    let stranger = ReserveVaultClient::new(
        &w.e,
        &w.e.register(
            ReserveVault,
            (
                Address::generate(&w.e),
                Rule {
                    vat_bps: 0,
                    buckets: vec![&w.e],
                },
                Address::generate(&w.e),
                0u64,
                PeriodKind::Year,
                kyros_reserve_vault::dues_after(&w.e, 0u64),
                vec![&w.e, w.token.clone()],
            ),
        ),
    );
    assert_eq!(
        w.inbox.try_propose_vault(&stranger.address),
        Err(Ok(InboxError::NotSameOwner))
    );
    let ready = w.inbox.propose_vault(&new_vault.address);
    assert_eq!(ready, 1_802_260_800 + 86_400);
    // During the notice, payments to the inbox still go through the Spanish vault.
    let t = TokenClient::new(&w.e, &w.token);
    t.transfer(&w.payer, &w.inbox.address, &(121 * UNIT));
    w.inbox.sweep(&w.token);
    assert_eq!(bal(&w, &w.vault.address), 41 * UNIT);
    // After it, the same address pays into the German vault; the Spanish reserve stays where it was.
    w.e.ledger().set_timestamp(ready);
    assert_eq!(w.inbox.vault(), new_vault.address);
    assert_eq!(w.inbox.try_cancel_move(), Err(Ok(InboxError::AlreadyMoved)));
    t.transfer(&w.payer, &w.inbox.address, &(1_190 * UNIT));
    let s = w.inbox.sweep(&w.token);
    assert_eq!((s.vat, s.reserve), (190 * UNIT, 490 * UNIT));
    assert_eq!(bal(&w, &new_vault.address), 490 * UNIT);
    assert_eq!(bal(&w, &w.vault.address), 41 * UNIT);
}

#[test]
fn a_move_can_be_cancelled_during_the_notice() {
    let w = world();
    let other = ReserveVaultClient::new(
        &w.e,
        &w.e.register(
            ReserveVault,
            (
                w.owner.clone(),
                Rule {
                    vat_bps: 500,
                    buckets: vec![&w.e],
                },
                Address::generate(&w.e),
                0u64,
                PeriodKind::Quarter,
                kyros_reserve_vault::dues_after(&w.e, 0u64),
                vec![&w.e, w.token.clone()],
            ),
        ),
    );
    w.inbox.propose_vault(&other.address);
    w.inbox.cancel_move();
    w.e.ledger().set_timestamp(1_802_260_800 + 2 * 86_400);
    assert_eq!(w.inbox.vault(), w.vault.address);
    assert_eq!(
        w.inbox.try_cancel_move(),
        Err(Ok(InboxError::NoPendingMove))
    );
}

#[test]
fn a_platform_pays_many_freelancers_in_one_call() {
    let w = world();
    let rule = Rule {
        vat_bps: 0,
        buckets: vec![
            &w.e,
            Bucket {
                name: Symbol::new(&w.e, "income"),
                bps: 1500,
            },
        ],
    };
    let other_owner = Address::generate(&w.e);
    let other = ReserveVaultClient::new(
        &w.e,
        &w.e.register(
            ReserveVault,
            (
                other_owner.clone(),
                rule,
                Address::generate(&w.e),
                86_400u64,
                PeriodKind::Quarter,
                kyros_reserve_vault::dues_after(&w.e, 0u64),
                vec![&w.e, w.token.clone()],
            ),
        ),
    );
    let r = BytesN::from_array(&w.e, &[1; 32]);
    let splits = w.router.pay_many(
        &w.payer,
        &w.token,
        &vec![
            &w.e,
            Payout {
                vault: w.vault.address.clone(),
                gross: 1_210 * UNIT,
                reference: r.clone(),
            },
            Payout {
                vault: other.address.clone(),
                gross: 1_000 * UNIT,
                reference: r,
            },
        ],
    );
    // One authorization from the platform covers the whole run.
    assert_eq!(w.e.auths().len(), 1);
    assert_eq!(splits.len(), 2);
    assert_eq!(bal(&w, &w.owner), 800 * UNIT);
    assert_eq!(bal(&w, &other_owner), 850 * UNIT);
    assert_eq!(bal(&w, &other.address), 150 * UNIT);
    assert_eq!(bal(&w, &w.payer), (10_000 - 2_210) * UNIT);
}

#[test]
fn a_batch_is_all_or_nothing() {
    let w = world();
    let stranger =
        w.e.register_stellar_asset_contract_v2(Address::generate(&w.e))
            .address();
    let picky = w.e.register(
        ReserveVault,
        (
            Address::generate(&w.e),
            Rule {
                vat_bps: 0,
                buckets: vec![&w.e],
            },
            Address::generate(&w.e),
            86_400u64,
            PeriodKind::Quarter,
            kyros_reserve_vault::dues_after(&w.e, 0u64),
            vec![&w.e, stranger],
        ),
    );
    let r = BytesN::from_array(&w.e, &[1; 32]);
    let res = w.router.try_pay_many(
        &w.payer,
        &w.token,
        &vec![
            &w.e,
            Payout {
                vault: w.vault.address.clone(),
                gross: 121 * UNIT,
                reference: r.clone(),
            },
            Payout {
                vault: picky,
                gross: 100 * UNIT,
                reference: r,
            },
        ],
    );
    assert!(res.is_err());
    assert_eq!(bal(&w, &w.payer), 10_000 * UNIT);
}

#[test]
fn an_inbox_for_clients_abroad_sweeps_by_its_own_terms() {
    let w = world();
    // A second inbox for clients abroad: the vault books its payments without VAT.
    let abroad = InboxClient::new(&w.e, &w.e.register(Inbox, (w.vault.address.clone(),)));
    w.vault.expect_payer(
        &abroad.address,
        &kyros_types::InvoiceTerms {
            vat_bps: 0,
            withholding_bps: 0,
            buckets: vec![
                &w.e,
                Bucket {
                    name: Symbol::new(&w.e, "irpf"),
                    bps: 2000,
                },
            ],
        },
    );
    TokenClient::new(&w.e, &w.token).transfer(&w.payer, &abroad.address, &(1_000 * UNIT));
    // The inbox authorizes exactly the split the vault will make for it, with no mocked auths.
    w.e.set_auths(&[]);
    let s = abroad.sweep(&w.token);
    assert_eq!((s.vat, s.net, s.reserve), (0, 800 * UNIT, 200 * UNIT));
    assert_eq!(bal(&w, &w.owner), 800 * UNIT);
    // The usual inbox still reserves VAT.
    w.e.mock_all_auths();
    TokenClient::new(&w.e, &w.token).transfer(&w.payer, &w.inbox.address, &(121 * UNIT));
    w.e.set_auths(&[]);
    assert_eq!(w.inbox.sweep(&w.token).vat, 21 * UNIT);
}

#[test]
fn an_inbox_pays_the_payout_address_and_fills_the_fixed_amount_first() {
    let w = world();
    let bank = Address::generate(&w.e);
    w.vault.propose_payout(&bank);
    w.vault.propose_fixed(&vec![
        &w.e,
        kyros_types::Fixed {
            bucket: Symbol::new(&w.e, "fee"),
            token: w.token.clone(),
            amount: 100 * UNIT,
        },
    ]);
    w.e.ledger().set_timestamp(1_802_260_800 + 86_400);
    TokenClient::new(&w.e, &w.token).transfer(&w.payer, &w.inbox.address, &(242 * UNIT));
    // The inbox authorizes exactly what the vault does, fixed amount included, with no mocked auths.
    w.e.set_auths(&[]);
    let s = w.inbox.sweep(&w.token);
    // 242 = 200 base + 42 VAT; 40 income-tax reserve; 160 net, of which 100 go to the fee.
    assert_eq!(
        (s.vat, s.fixed, s.net, s.reserve),
        (42 * UNIT, 100 * UNIT, 60 * UNIT, 182 * UNIT)
    );
    assert_eq!(bal(&w, &bank), 60 * UNIT);
    assert_eq!(bal(&w, &w.owner), 0);
    // Once the period's fee is set aside, payments split as usual.
    w.e.mock_all_auths();
    TokenClient::new(&w.e, &w.token).transfer(&w.payer, &w.inbox.address, &(121 * UNIT));
    w.e.set_auths(&[]);
    let s = w.inbox.sweep(&w.token);
    assert_eq!((s.fixed, s.net), (0, 80 * UNIT));
    assert_eq!(bal(&w, &bank), 140 * UNIT);
}

#[test]
fn an_inbox_sweeps_a_currency_the_vault_added_after_the_notice() {
    let w = world();
    let cbdc =
        w.e.register_stellar_asset_contract_v2(Address::generate(&w.e))
            .address();
    StellarAssetClient::new(&w.e, &cbdc).mint(&w.payer, &(1_000 * UNIT));
    TokenClient::new(&w.e, &cbdc).transfer(&w.payer, &w.inbox.address, &(121 * UNIT));
    // Not accepted yet: the inbox keeps it (it can only ever go to the owner or the vault).
    assert!(w.inbox.try_sweep(&cbdc).is_err());
    w.vault.propose_token(&cbdc);
    w.e.ledger().set_timestamp(1_802_260_800 + 86_400);
    w.e.set_auths(&[]);
    let s = w.inbox.sweep(&cbdc);
    assert_eq!((s.net, s.reserve), (80 * UNIT, 41 * UNIT));
    assert_eq!(TokenClient::new(&w.e, &cbdc).balance(&w.owner), 80 * UNIT);
}
