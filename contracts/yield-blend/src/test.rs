//! Runs the strategy against the Blend v2 contracts (pool, factory,
//! backstop, emitter, Comet), set up the way Blend's own test fixture does,
//! with a borrower paying interest so the supply earns.
extern crate std;
use super::*;
use kyros_reserve_vault::{ReserveVault, ReserveVaultClient};
use kyros_types::{Asset, Bucket, PeriodKind, PriceData, Rule};
use soroban_sdk::{
    contract, contractimpl, symbol_short,
    testutils::{Address as _, BytesN as _, Ledger},
    token::{StellarAssetClient, TokenClient},
    BytesN, String, Vec,
};

mod backstop {
    soroban_sdk::contractimport!(file = "../vendor/blend/backstop.wasm");
}
mod emitter {
    soroban_sdk::contractimport!(file = "../vendor/blend/emitter.wasm");
}
mod pool_factory {
    soroban_sdk::contractimport!(file = "../vendor/blend/pool_factory.wasm");
}
mod comet {
    soroban_sdk::contractimport!(file = "../vendor/blend/comet.wasm");
}

const UNIT: i128 = 10_000_000;
const FEB_10_2027: u64 = 1_802_260_800;
const YEAR: u64 = 365 * 86_400;

/// Every asset at $1, 7 decimals.
#[contract]
pub struct Prices;

#[contractimpl]
impl Prices {
    pub fn lastprice(e: Env, _asset: Asset) -> Option<PriceData> {
        Some(PriceData {
            price: UNIT,
            timestamp: e.ledger().timestamp(),
        })
    }
    pub fn decimals(_e: Env) -> u32 {
        7
    }
}

fn reserve_config(index: u32) -> pool::ReserveConfig {
    // Blend's "good enough for tests" reserve: 75% collateral factor, 75% target utilization.
    pool::ReserveConfig {
        decimals: 7,
        c_factor: 0_7500000,
        l_factor: 0_7500000,
        util: 0_7500000,
        max_util: 0_9500000,
        r_base: 0_0100000,
        r_one: 0_0500000,
        r_two: 0_5000000,
        r_three: 1_5000000,
        reactivity: 0_0000020,
        index,
        supply_cap: 100_000_000_0000000,
        enabled: true,
    }
}

struct B {
    e: Env,
    usdc: Address,
    xlm: Address,
    pool: pool::Client<'static>,
    lender: Address,
}

/// Blend deployed as in `blend-contract-sdk`'s `BlendFixture`, plus one active
/// pool with USDC and XLM reserves.
fn blend() -> B {
    let e = Env::default();
    e.mock_all_auths();
    e.cost_estimate().budget().reset_unlimited();
    e.ledger().set_timestamp(FEB_10_2027);
    e.ledger().set_sequence_number(100);
    let deployer = Address::generate(&e);
    let blnd = e
        .register_stellar_asset_contract_v2(deployer.clone())
        .address();
    let usdc = e
        .register_stellar_asset_contract_v2(deployer.clone())
        .address();
    let xlm = e
        .register_stellar_asset_contract_v2(deployer.clone())
        .address();

    let emitter_id = e.register(emitter::WASM, ());
    let backstop_id = Address::generate(&e);
    let factory_id = Address::generate(&e);
    let comet_id = e.register(comet::WASM, ());
    StellarAssetClient::new(&e, &blnd).mint(&deployer, &(1_000_0000000 * 2001));
    StellarAssetClient::new(&e, &usdc).mint(&deployer, &(25_0000000 * 2001));
    let comet_client = comet::Client::new(&e, &comet_id);
    comet_client.init(
        &deployer,
        &soroban_sdk::vec![&e, blnd.clone(), usdc.clone()],
        &soroban_sdk::vec![&e, 0_8000000, 0_2000000],
        &soroban_sdk::vec![&e, 1_000_0000000, 25_0000000],
        &0_0030000,
    );
    comet_client.join_pool(
        &199_900_0000000,
        &soroban_sdk::vec![&e, 1_000_0000000 * 2000, 25_0000000 * 2000],
        &deployer,
    );
    StellarAssetClient::new(&e, &blnd).set_admin(&emitter_id);
    emitter::Client::new(&e, &emitter_id).initialize(&blnd, &backstop_id, &comet_id);
    e.register_at(
        &backstop_id,
        backstop::WASM,
        (
            comet_id,
            emitter_id,
            blnd.clone(),
            usdc.clone(),
            factory_id.clone(),
            Vec::<(Address, i128)>::new(&e),
        ),
    );
    let pool_hash = e.deployer().upload_contract_wasm(pool::WASM);
    e.register_at(
        &factory_id,
        pool_factory::WASM,
        (pool_factory::PoolInitMeta {
            backstop: backstop_id.clone(),
            blnd_id: blnd,
            pool_hash,
        },),
    );
    let oracle = e.register(Prices, ());
    let pool_id = pool_factory::Client::new(&e, &factory_id).deploy(
        &deployer,
        &String::from_str(&e, "kyros-test"),
        &BytesN::<32>::random(&e),
        &oracle,
        &0_1000000,
        &4,
        &1_0000000,
    );
    let pool = pool::Client::new(&e, &pool_id);
    pool.queue_set_reserve(&usdc, &reserve_config(0));
    pool.set_reserve(&usdc);
    pool.queue_set_reserve(&xlm, &reserve_config(1));
    pool.set_reserve(&xlm);
    backstop::Client::new(&e, &backstop_id).deposit(&deployer, &pool_id, &50_000_0000000);
    pool.set_status(&3);
    pool.update_status();
    // Other lenders: 100,000 USDC already in the pool.
    let lender = Address::generate(&e);
    StellarAssetClient::new(&e, &usdc).mint(&lender, &(100_000 * UNIT));
    pool.submit(
        &lender,
        &lender,
        &lender,
        &soroban_sdk::vec![
            &e,
            pool::Request {
                request_type: 0,
                address: usdc.clone(),
                amount: 100_000 * UNIT
            }
        ],
    );
    B {
        e,
        usdc,
        xlm,
        pool,
        lender,
    }
}

/// A borrower puts up XLM and borrows `amount` USDC, so suppliers earn interest.
fn borrow(b: &B, amount: i128) {
    let who = Address::generate(&b.e);
    StellarAssetClient::new(&b.e, &b.xlm).mint(&who, &(amount * 3));
    b.pool.submit(
        &who,
        &who,
        &who,
        &soroban_sdk::vec![
            &b.e,
            pool::Request {
                request_type: 2,
                address: b.xlm.clone(),
                amount: amount * 3
            },
            pool::Request {
                request_type: 4,
                address: b.usdc.clone(),
                amount
            },
        ],
    );
}

#[test]
fn supplies_to_blend_and_earns() {
    let b = blend();
    let owner = Address::generate(&b.e);
    let y = BlendYieldClient::new(
        &b.e,
        &b.e.register(
            BlendYield,
            (owner.clone(), b.pool.address.clone(), b.usdc.clone()),
        ),
    );
    StellarAssetClient::new(&b.e, &b.usdc).mint(&y.address, &(1_000 * UNIT));
    y.deposit(&(1_000 * UNIT));
    assert_eq!(TokenClient::new(&b.e, &b.usdc).balance(&y.address), 0);
    let start = y.balance();
    assert!(start >= 999 * UNIT && start <= 1_000 * UNIT, "{start}");
    borrow(&b, 75_000 * UNIT);
    b.e.ledger().set_timestamp(FEB_10_2027 + YEAR);
    b.e.ledger().set_sequence_number(100 + 6_307_200);
    let later = y.balance();
    assert!(
        later > 1_010 * UNIT,
        "a year at 75% utilization should earn: {later}"
    );
    // Withdrawals go to the owner; asking for more than the position gives back all of it.
    let got = y.withdraw(&(100 * UNIT));
    assert_eq!(got, 100 * UNIT);
    let got_rest = y.withdraw(&(10_000 * UNIT));
    assert!(got_rest >= later - 100 * UNIT - 1, "{got_rest}");
    assert_eq!(
        TokenClient::new(&b.e, &b.usdc).balance(&owner),
        got + got_rest
    );
    assert_eq!(y.balance(), 0);
}

#[test]
fn a_vault_lends_half_its_reserve_through_blend_and_keeps_paying_tax() {
    let b = blend();
    let e = &b.e;
    let owner = Address::generate(e);
    let payer = Address::generate(e);
    let tax = Address::generate(e);
    let notice = 7 * 86_400;
    let rule = Rule {
        vat_bps: 2100,
        buckets: soroban_sdk::vec![
            e,
            Bucket {
                name: symbol_short!("irpf"),
                bps: 2000
            }
        ],
    };
    let v = ReserveVaultClient::new(
        e,
        &e.register(
            ReserveVault,
            (
                owner.clone(),
                rule,
                tax.clone(),
                notice,
                PeriodKind::Year,
                kyros_reserve_vault::dues_after(&e, 30 * 86_400u64),
                soroban_sdk::vec![e, b.usdc.clone()],
            ),
        ),
    );
    let y = e.register(
        BlendYield,
        (v.address.clone(), b.pool.address.clone(), b.usdc.clone()),
    );
    v.propose_strategy(&y, &5_000);
    e.ledger().set_timestamp(FEB_10_2027 + notice);
    StellarAssetClient::new(e, &b.usdc).mint(&payer, &(12_100 * UNIT));
    v.receive(
        &payer,
        &b.usdc,
        &(12_100 * UNIT),
        &BytesN::from_array(e, &[2; 32]),
    );
    let year = v.current_period();
    assert_eq!(v.invest(), 2_050 * UNIT);
    borrow(&b, 75_000 * UNIT);
    e.ledger()
        .set_timestamp(FEB_10_2027 + notice + 300 * 86_400);
    e.ledger().set_sequence_number(100 + 5_184_000);
    let p = v.position(&b.usdc);
    assert_eq!(p.held, 4_100 * UNIT);
    assert!(p.surplus > 0, "the Blend supply earned nothing: {:?}", p);
    // Paying all the VAT and income tax needs the part lent to Blend back.
    v.pay_tax(&year, &b.usdc, &symbol_short!("vat"), &(2_100 * UNIT));
    v.pay_tax(&year, &b.usdc, &symbol_short!("irpf"), &(2_000 * UNIT));
    assert_eq!(TokenClient::new(e, &b.usdc).balance(&tax), 4_100 * UNIT);
    // What is left in Blend is the owner's interest.
    let before = TokenClient::new(e, &b.usdc).balance(&owner);
    let earned = v.harvest(&b.usdc);
    assert!(earned > 0);
    assert_eq!(
        TokenClient::new(e, &b.usdc).balance(&owner) - before,
        earned
    );
}

#[test]
fn a_fully_lent_pool_makes_the_payment_wait_and_says_why() {
    let b = blend();
    let e = &b.e;
    let owner = Address::generate(e);
    let y = BlendYieldClient::new(
        e,
        &e.register(
            BlendYield,
            (owner.clone(), b.pool.address.clone(), b.usdc.clone()),
        ),
    );
    StellarAssetClient::new(e, &b.usdc).mint(&y.address, &(1_000 * UNIT));
    y.deposit(&(1_000 * UNIT));
    // Borrowers take 95% of the pool, then the other lender takes most of the cash that is left:
    // 600 USDC remain, not enough to give back our 1,000.
    borrow(&b, 95_900 * UNIT);
    b.pool.submit(
        &b.lender,
        &b.lender,
        &b.lender,
        &soroban_sdk::vec![
            e,
            pool::Request {
                request_type: 1,
                address: b.usdc.clone(),
                amount: 4_500 * UNIT
            }
        ],
    );
    assert!(y.try_withdraw(&(10_000 * UNIT)).is_err());
    // A smaller withdrawal still goes through.
    assert_eq!(y.withdraw(&(100 * UNIT)), 100 * UNIT);
}

#[test]
fn a_vault_payment_waits_with_a_clear_error_when_the_pool_has_no_cash() {
    let b = blend();
    let e = &b.e;
    let owner = Address::generate(e);
    let payer = Address::generate(e);
    let notice = 7 * 86_400;
    let rule = Rule {
        vat_bps: 2100,
        buckets: soroban_sdk::vec![e],
    };
    let v = ReserveVaultClient::new(
        e,
        &e.register(
            ReserveVault,
            (
                owner,
                rule,
                Address::generate(e),
                notice,
                PeriodKind::Year,
                kyros_reserve_vault::dues_after(&e, 30 * 86_400u64),
                soroban_sdk::vec![e, b.usdc.clone()],
            ),
        ),
    );
    let y = e.register(
        BlendYield,
        (v.address.clone(), b.pool.address.clone(), b.usdc.clone()),
    );
    v.propose_strategy(&y, &10_000);
    e.ledger().set_timestamp(FEB_10_2027 + notice);
    StellarAssetClient::new(e, &b.usdc).mint(&payer, &(1_210 * UNIT));
    v.receive(
        &payer,
        &b.usdc,
        &(1_210 * UNIT),
        &BytesN::from_array(e, &[3; 32]),
    );
    assert_eq!(v.invest(), 210 * UNIT);
    borrow(&b, 95_000 * UNIT);
    b.pool.submit(
        &b.lender,
        &b.lender,
        &b.lender,
        &soroban_sdk::vec![
            e,
            pool::Request {
                request_type: 1,
                address: b.usdc.clone(),
                amount: 5_100 * UNIT
            }
        ],
    );
    let year = v.current_period();
    assert_eq!(
        v.try_pay_tax(&year, &b.usdc, &symbol_short!("vat"), &(210 * UNIT)),
        Err(Ok(kyros_reserve_vault::VaultError::Illiquid))
    );
}
