#![allow(clippy::arithmetic_side_effects)] // test code: amounts are small and known
extern crate std;
use super::*;
use kyros_reserve_vault::{ReserveVault, ReserveVaultClient};
use kyros_types::{Bucket, InvoiceTerms, PeriodKind, Rule};
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

/// A contract posing as a vault: its quote claims more than the payment, and
/// its `receive` takes that much from the payer for its owner.
#[contract]
pub struct GreedyVault;

#[contractimpl]
impl GreedyVault {
    pub fn __constructor(e: Env, thief: Address) {
        e.storage().instance().set(&0u32, &thief);
    }
    pub fn payout(e: Env) -> Address {
        e.storage().instance().get(&0u32).unwrap()
    }
    pub fn quote_in(e: Env, _from: Address, token: Address, _r: BytesN<32>, gross: i128) -> Split {
        let held = TokenClient::new(&e, &token).balance(&_from);
        Split {
            gross,
            base: gross,
            vat: 0,
            parts: vec![&e],
            fixed: 0,
            reserve: 0,
            net: held,
        }
    }
    pub fn receive(e: Env, from: Address, token: Address, gross: i128, r: BytesN<32>) -> Split {
        let s = Self::quote_in(e.clone(), from.clone(), token.clone(), r, gross);
        TokenClient::new(&e, &token).transfer(&from, Self::payout(e.clone()), &s.net);
        s
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
                kyros_reserve_vault::dues_after(&e, 0u64),
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
            kyros_reserve_vault::dues_after(&w.e, 0u64),
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

#[test]
fn a_fake_vault_cannot_take_more_than_the_payment() {
    let w = world();
    // Someone redeemed a burn with no destination caller straight at Circle's
    // transmitter: its USDC was minted here and never paid into its vault.
    let stranded = message(
        &w,
        9,
        500_000_000,
        0,
        &w.pay.address,
        None,
        &hook(&w, &w.vault.address, [0; 32]),
    );
    MockTransmitterClient::new(&w.e, &w.pay.transmitter()).receive_message(
        &Address::generate(&w.e),
        &stranded,
        &Bytes::new(&w.e),
    );
    assert_eq!(bal(&w, &w.pay.address), 500 * UNIT);
    // A small burn naming a fake vault that quotes the whole balance.
    let thief = Address::generate(&w.e);
    let fake = w.e.register(GreedyVault, (thief.clone(),));
    let m = message(
        &w,
        10,
        1_000_000,
        0,
        &w.pay.address,
        Some(&w.pay.address),
        &hook(&w, &fake, [0; 32]),
    );
    w.e.set_auths(&[]);
    assert_eq!(
        w.pay
            .try_mint_and_pay(&m, &Bytes::new(&w.e))
            .unwrap_err()
            .unwrap(),
        CctpPayError::BadSplit.into()
    );
    assert_eq!(bal(&w, &thief), 0);
}

// ---- Adversarial: cross-chain messages (threats C1-C5, docs/threat-model.md) ----

mod adversarial {
    use super::*;
    use proptest::prelude::*;

    /// Everything a refused message must leave as it was.
    fn balances(w: &W) -> (i128, i128, i128) {
        (
            bal(w, &w.owner),
            bal(w, &w.vault.address),
            bal(w, &w.pay.address),
        )
    }

    /// C1. Nonces arriving out of order each pay once, and only once:
    /// replaying any of them is refused (Circle's transmitter tracks nonces;
    /// a replay reverts the whole call, the mint included).
    #[test]
    fn nonces_out_of_order_each_pay_once() {
        let w = world();
        let h = hook(&w, &w.vault.address, [0; 32]);
        let msgs: std::vec::Vec<Bytes> = [3u8, 1, 2]
            .iter()
            .map(|n| message(&w, *n, 121_000_000, 0, &w.pay.address, None, &h))
            .collect();
        for m in &msgs {
            w.pay.mint_and_pay(m, &Bytes::new(&w.e));
        }
        let paid = balances(&w);
        assert_eq!(paid, (240 * UNIT, 123 * UNIT, 0));
        for m in &msgs {
            assert!(w.pay.try_mint_and_pay(m, &Bytes::new(&w.e)).is_err());
        }
        assert_eq!(balances(&w), paid);
    }

    /// C2. A message from a domain or for a token Circle does not map to
    /// Stellar USDC is refused before anything is minted.
    #[test]
    fn an_unknown_domain_or_token_mints_nothing() {
        let w = world();
        let h = hook(&w, &w.vault.address, [0; 32]);
        let good = message(&w, 9, 121_000_000, 0, &w.pay.address, None, &h);
        // Source domain 7 instead of Base's 6.
        let mut domain = good.clone();
        domain.set(7, 7);
        assert_eq!(
            w.pay.try_mint_and_pay(&domain, &Bytes::new(&w.e)),
            Err(Ok(soroban_sdk::Error::from_contract_error(
                CctpPayError::UnknownToken as u32
            )))
        );
        // Another burn token.
        let mut tok = good.clone();
        tok.set(MSG_BODY + BURN_TOKEN, 0xEE);
        assert_eq!(
            w.pay.try_mint_and_pay(&tok, &Bytes::new(&w.e)),
            Err(Ok(soroban_sdk::Error::from_contract_error(
                CctpPayError::UnknownToken as u32
            )))
        );
        assert_eq!(balances(&w), (0, 0, 0));
        // The genuine message still pays (nothing was consumed).
        w.pay.mint_and_pay(&good, &Bytes::new(&w.e));
        assert_eq!(balances(&w), (80 * UNIT, 41 * UNIT, 0));
    }

    /// C3. A hook naming something that is not a vault fails whole: the
    /// mint is reverted with it, and nothing is left in the receiver.
    #[test]
    fn a_hook_naming_a_non_vault_reverts_the_mint() {
        let w = world();
        let stranger = Address::generate(&w.e);
        let h = hook(&w, &stranger, [0; 32]);
        let m = message(&w, 5, 121_000_000, 0, &w.pay.address, None, &h);
        assert!(w.pay.try_mint_and_pay(&m, &Bytes::new(&w.e)).is_err());
        assert_eq!(balances(&w), (0, 0, 0));
        assert_eq!(bal(&w, &stranger), 0);
    }

    proptest! {
        #![proptest_config(ProptestConfig { cases: 256, failure_persistence: None, ..ProptestConfig::default() })]

        /// C4. Any corruption of a valid message (up to three bytes changed,
        /// or cut short) is either refused with nothing moved, or pays
        /// exactly what was minted: every unit to the owner or the vault,
        /// nothing left in the receiver.
        #[test]
        fn any_corrupted_message_is_refused_or_pays_exactly(
            flips in prop::collection::vec((0u32..400, any::<u8>()), 0..4),
            cut in prop::option::of(0u32..400),
        ) {
            let w = world();
            let h = hook(&w, &w.vault.address, [0; 32]);
            let mut m = message(&w, 11, 121_000_000, 0, &w.pay.address, None, &h);
            for (at, b) in &flips {
                if *at < m.len() {
                    m.set(*at, *b);
                }
            }
            if let Some(c) = cut {
                m = m.slice(0..c.min(m.len()));
            }
            w.e.cost_estimate().budget().reset_unlimited();
            match w.pay.try_mint_and_pay(&m, &Bytes::new(&w.e)) {
                Ok(Ok(s)) => {
                    let (owner, vault, left) = balances(&w);
                    prop_assert_eq!(left, 0);
                    prop_assert_eq!(owner + vault, s.gross);
                    prop_assert_eq!(s.net + s.reserve, s.gross);
                }
                _ => prop_assert_eq!(balances(&w), (0, 0, 0)),
            }
        }

        /// C5. Any amount and any fee Circle keeps settle exactly: the
        /// split adds up to what was minted, none of it stays behind.
        #[test]
        fn any_amount_and_fee_settle_exactly(amount in 1u32..=u32::MAX, fee in 0u32..=u32::MAX) {
            let fee = fee % amount;
            let w = world();
            let h = hook(&w, &w.vault.address, [0; 32]);
            let m = message(&w, 12, amount, fee, &w.pay.address, None, &h);
            let s = w.pay.mint_and_pay(&m, &Bytes::new(&w.e));
            let minted = i128::from(amount - fee) * 10;
            prop_assert_eq!(s.gross, minted);
            prop_assert_eq!(balances(&w), (s.net, s.reserve, 0));
        }
    }
}
