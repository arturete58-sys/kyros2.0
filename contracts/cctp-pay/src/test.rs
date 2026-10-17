extern crate std;
use super::*;
use kyros_reserve_vault::{ReserveVault, ReserveVaultClient};
use kyros_types::{Bucket, InvoiceTerms, PeriodKind};
use soroban_sdk::{
    contract, contractimpl,
    testutils::{Address as _, Events, Ledger},
    token::{StellarAssetClient, TokenClient},
    vec, Env, Symbol,
};

const UNIT: i128 = 10_000_000;
const BASE_DOMAIN: u32 = 6;

/// Stands in for Circle's MessageTransmitter: checks the caller rule and the
/// nonce, then mints the burned amount (6 decimals) as 7-decimal USDC to the
/// mint recipient, like the real TokenMessengerMinter.
#[contract]
pub struct MockTransmitter;

#[contractimpl]
impl MockTransmitter {
    pub fn __constructor(e: Env, usdc: Address) {
        e.storage().instance().set(&Symbol::new(&e, "usdc"), &usdc);
    }
    pub fn receive_message(e: Env, caller: Address, message: Bytes, _attestation: Bytes) -> bool {
        caller.require_auth();
        let dc = read_32(&e, &message, MSG_DESTINATION_CALLER);
        if dc != BytesN::from_array(&e, &[0; 32]) && dc != contract_id(&e, &caller) {
            panic!("wrong destination caller");
        }
        let nonce = read_32(&e, &message, 12);
        if e.storage().persistent().has(&nonce) {
            panic!("nonce already used");
        }
        e.storage().persistent().set(&nonce, &true);
        let body = message.slice(MSG_BODY..message.len());
        let to = Address::from_payload(
            &e,
            AddressPayload::ContractIdHash(read_32(&e, &body, BURN_MINT_RECIPIENT)),
        );
        let amount = i128::from(read_u32(&e, &body, 96)) - i128::from(read_u32(&e, &body, 192));
        let usdc: Address = e
            .storage()
            .instance()
            .get(&Symbol::new(&e, "usdc"))
            .unwrap();
        StellarAssetClient::new(&e, &usdc).mint(&to, &(amount * 10));
        true
    }
}

/// Stands in for Circle's TokenMessengerMinter: knows Base's USDC.
#[contract]
pub struct MockMinter;

#[contractimpl]
impl MockMinter {
    pub fn __constructor(e: Env, usdc: Address) {
        e.storage().instance().set(&Symbol::new(&e, "usdc"), &usdc);
    }
    pub fn get_local_token(
        e: Env,
        remote_domain: u32,
        remote_token: BytesN<32>,
    ) -> Option<Address> {
        if remote_domain == BASE_DOMAIN && remote_token == BytesN::from_array(&e, &[0xBA; 32]) {
            e.storage().instance().get(&Symbol::new(&e, "usdc"))
        } else {
            None
        }
    }
}

struct W {
    e: Env,
    pay: CctpPayClient<'static>,
    vault: ReserveVaultClient<'static>,
    minter: Address,
    usdc: Address,
    owner: Address,
}

fn world() -> W {
    let e = Env::default();
    e.mock_all_auths();
    e.ledger().set_timestamp(1_802_260_800);
    let usdc = e
        .register_stellar_asset_contract_v2(Address::generate(&e))
        .address();
    let transmitter = e.register(MockTransmitter, (usdc.clone(),));
    // The transmitter mints, so it is the USDC admin.
    StellarAssetClient::new(&e, &usdc).set_admin(&transmitter);
    let minter = e.register(MockMinter, (usdc.clone(),));
    let owner = Address::generate(&e);
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
                0u64,
                vec![&e, usdc.clone()],
            ),
        ),
    );
    let pay = CctpPayClient::new(&e, &e.register(CctpPay, (transmitter, minter.clone())));
    W {
        e,
        pay,
        vault,
        minter,
        usdc,
        owner,
    }
}

/// A CCTP V2 message for a burn of `amount` (6 decimals) on Base.
fn message(
    w: &W,
    nonce: u8,
    amount: u32,
    fee: u32,
    mint_to: &Address,
    caller: Option<&Address>,
    hook: &Bytes,
) -> Bytes {
    let e = &w.e;
    let mut m = Bytes::new(e);
    m.extend_from_array(&CCTP_VERSION.to_be_bytes());
    m.extend_from_array(&BASE_DOMAIN.to_be_bytes());
    m.extend_from_array(&27u32.to_be_bytes());
    m.extend_from_array(&[nonce; 32]);
    m.extend_from_array(&[0x5E; 32]); // sender: Base's TokenMessenger
    m.append(&contract_id(e, &w.minter).into());
    match caller {
        Some(c) => m.append(&contract_id(e, c).into()),
        None => m.extend_from_array(&[0; 32]),
    }
    m.extend_from_array(&1000u32.to_be_bytes());
    m.extend_from_array(&1000u32.to_be_bytes());
    // Burn message.
    m.extend_from_array(&CCTP_VERSION.to_be_bytes());
    m.extend_from_array(&[0xBA; 32]); // Base USDC
    m.append(&contract_id(e, mint_to).into());
    let mut amt = [0u8; 32];
    amt[28..].copy_from_slice(&amount.to_be_bytes());
    m.extend_from_array(&amt);
    let mut payer = [0u8; 32];
    payer[12..].copy_from_slice(&[0xC1; 20]); // the client's EVM address
    m.extend_from_array(&payer);
    m.extend_from_array(&[0; 32]); // max fee
    let mut fe = [0u8; 32];
    fe[28..].copy_from_slice(&fee.to_be_bytes());
    m.extend_from_array(&fe);
    m.extend_from_array(&[0; 32]); // expiration block
    m.append(hook);
    m
}

fn hook(w: &W, vault: &Address, reference: [u8; 32]) -> Bytes {
    let e = &w.e;
    let mut h = Bytes::from_array(e, &[0; 24]);
    h.extend_from_array(&HOOK_VERSION.to_be_bytes());
    h.extend_from_array(&64u32.to_be_bytes());
    h.append(&contract_id(e, vault).into());
    h.extend_from_array(&reference);
    h
}

fn bal(w: &W, a: &Address) -> i128 {
    TokenClient::new(&w.e, &w.usdc).balance(a)
}

#[test]
fn a_payment_from_base_is_minted_and_split_in_one_call() {
    let w = world();
    let h = hook(&w, &w.vault.address, [0; 32]);
    let m = message(
        &w,
        1,
        1_210_000_000,
        0,
        &w.pay.address,
        Some(&w.pay.address),
        &h,
    );
    // No authorization mocked from here: the relayer needs none, and the
    // receiver authorizes only the vault's two transfers.
    w.e.set_auths(&[]);
    let s = w.pay.mint_and_pay(&m, &Bytes::new(&w.e));
    // One Kyros event, read before any other call replaces the event list.
    let evs = w.e.events().all().filter_by_contract(&w.pay.address);
    assert_eq!(evs.events().len(), 1);
    assert_eq!(
        (s.gross, s.net, s.reserve),
        (1_210 * UNIT, 800 * UNIT, 410 * UNIT)
    );
    assert_eq!(bal(&w, &w.owner), 800 * UNIT);
    assert_eq!(bal(&w, &w.vault.address), 410 * UNIT);
    assert_eq!(bal(&w, &w.pay.address), 0);
}

#[test]
fn the_invoice_terms_the_owner_registered_apply() {
    let w = world();
    let reference = [7u8; 32];
    w.vault.expect_invoice(
        &BytesN::from_array(&w.e, &reference),
        &InvoiceTerms {
            vat_bps: 2100,
            withholding_bps: 1500,
            buckets: vec![
                &w.e,
                Bucket {
                    name: Symbol::new(&w.e, "irpf"),
                    bps: 500,
                },
            ],
        },
    );
    // Base 1,000 + VAT 210 - withholding 150 = 1,060, less a CCTP fee of 0.10 is not what we test here.
    let m = message(
        &w,
        2,
        1_060_000_000,
        0,
        &w.pay.address,
        None,
        &hook(&w, &w.vault.address, reference),
    );
    w.e.set_auths(&[]);
    let s = w.pay.mint_and_pay(&m, &Bytes::new(&w.e));
    assert_eq!(
        (s.vat, s.reserve, s.net),
        (210 * UNIT, 260 * UNIT, 800 * UNIT)
    );
}

#[test]
fn the_fee_circle_keeps_is_not_paid_in() {
    let w = world();
    let m = message(
        &w,
        3,
        121_000_000,
        10_000,
        &w.pay.address,
        None,
        &hook(&w, &w.vault.address, [0; 32]),
    );
    let s = w.pay.mint_and_pay(&m, &Bytes::new(&w.e));
    assert_eq!(s.gross, 120_990_000 * 10);
}

#[test]
fn a_message_cannot_be_paid_twice() {
    let w = world();
    let m = message(
        &w,
        4,
        121_000_000,
        0,
        &w.pay.address,
        None,
        &hook(&w, &w.vault.address, [0; 32]),
    );
    w.pay.mint_and_pay(&m, &Bytes::new(&w.e));
    assert!(w.pay.try_mint_and_pay(&m, &Bytes::new(&w.e)).is_err());
    assert_eq!(bal(&w, &w.owner), 80 * UNIT);
}

#[test]
fn burns_that_are_not_for_kyros_are_refused() {
    let w = world();
    let other_contract = w.e.register(MockMinter, (w.usdc.clone(),));
    let h = hook(&w, &w.vault.address, [0; 32]);
    let err = |m: &Bytes| {
        w.pay
            .try_mint_and_pay(m, &Bytes::new(&w.e))
            .unwrap_err()
            .unwrap()
    };
    // Minted to someone else.
    assert_eq!(
        err(&message(&w, 5, 1_000_000, 0, &other_contract, None, &h)),
        CctpPayError::WrongMintRecipient.into()
    );
    // Only another contract may redeem it.
    assert_eq!(
        err(&message(
            &w,
            6,
            1_000_000,
            0,
            &w.pay.address,
            Some(&other_contract),
            &h
        )),
        CctpPayError::WrongCaller.into()
    );
    // Circle's forwarder format, or no hook data at all.
    let mut forward = Bytes::from_array(&w.e, &[0; 24]);
    forward.extend_from_array(&0u32.to_be_bytes());
    forward.extend_from_array(&56u32.to_be_bytes());
    assert_eq!(
        err(&message(
            &w,
            7,
            1_000_000,
            0,
            &w.pay.address,
            None,
            &forward
        )),
        CctpPayError::BadHookData.into()
    );
    assert_eq!(
        err(&message(
            &w,
            8,
            1_000_000,
            0,
            &w.pay.address,
            None,
            &Bytes::new(&w.e)
        )),
        CctpPayError::BadHookData.into()
    );
}

#[test]
fn a_vault_that_refuses_the_token_reverts_everything() {
    let w = world();
    let other_token =
        w.e.register_stellar_asset_contract_v2(Address::generate(&w.e))
            .address();
    let picky = w.e.register(
        ReserveVault,
        (
            w.owner.clone(),
            Rule {
                vat_bps: 2100,
                buckets: vec![&w.e],
            },
            Address::generate(&w.e),
            86_400u64,
            PeriodKind::Quarter,
            0u64,
            vec![&w.e, other_token],
        ),
    );
    let m = message(
        &w,
        9,
        121_000_000,
        0,
        &w.pay.address,
        None,
        &hook(&w, &picky, [0; 32]),
    );
    assert!(w.pay.try_mint_and_pay(&m, &Bytes::new(&w.e)).is_err());
    // Nothing was minted, so the attested message can still be redeemed later.
    assert_eq!(bal(&w, &w.pay.address), 0);
}
