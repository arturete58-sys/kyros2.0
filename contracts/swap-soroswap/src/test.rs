//! Runs the swapper against the Soroswap contracts deployed on mainnet, and a
//! Reserve Vault converting its USDC reserve to EURC through it.
extern crate std;
use super::*;
use kyros_reserve_vault::{Conversion, ReserveVault, ReserveVaultClient};
use kyros_types::{Asset, Bucket, PeriodKind, PriceData, Rule};
use soroban_sdk::{
    contract, contractimpl, symbol_short,
    testutils::{Address as _, Ledger},
    token::{StellarAssetClient, TokenClient},
    BytesN,
};

mod factory {
    soroban_sdk::contractimport!(file = "../vendor/soroswap/soroswap_factory.optimized.wasm");
}
mod router {
    soroban_sdk::contractimport!(file = "../vendor/soroswap/soroswap_router.optimized.wasm");
}
mod pair {
    soroban_sdk::contractimport!(file = "../vendor/soroswap/soroswap_pair.optimized.wasm");
}

const UNIT: i128 = 10_000_000;
const FEB_10_2027: u64 = 1_802_260_800;

/// USDC and EURC with a Soroswap pool of 1,160,000 USDC / 1,000,000 EURC (1 EUR = 1.16 USD).
struct S {
    e: Env,
    usdc: Address,
    eurc: Address,
    router: Address,
}

fn soroswap() -> S {
    let e = Env::default();
    e.mock_all_auths();
    e.cost_estimate().budget().reset_unlimited();
    e.ledger().set_timestamp(FEB_10_2027);
    let usdc = e
        .register_stellar_asset_contract_v2(Address::generate(&e))
        .address();
    let eurc = e
        .register_stellar_asset_contract_v2(Address::generate(&e))
        .address();
    let pair_hash = e.deployer().upload_contract_wasm(pair::WASM);
    let f = factory::Client::new(&e, &e.register(factory::WASM, ()));
    f.initialize(&Address::generate(&e), &pair_hash);
    let r = router::Client::new(&e, &e.register(router::WASM, ()));
    r.initialize(&f.address);
    let lp = Address::generate(&e);
    StellarAssetClient::new(&e, &usdc).mint(&lp, &(1_160_000 * UNIT));
    StellarAssetClient::new(&e, &eurc).mint(&lp, &(1_000_000 * UNIT));
    r.add_liquidity(
        &usdc,
        &eurc,
        &(1_160_000 * UNIT),
        &(1_000_000 * UNIT),
        &0,
        &0,
        &lp,
        &(FEB_10_2027 + 60),
    );
    S {
        e,
        usdc,
        eurc,
        router: r.address,
    }
}

#[test]
fn swaps_through_the_soroswap_pool() {
    let s = soroswap();
    let sw = SoroswapSwapperClient::new(&s.e, &s.e.register(SoroswapSwapper, (s.router.clone(),)));
    let caller = Address::generate(&s.e);
    StellarAssetClient::new(&s.e, &s.usdc).mint(&sw.address, &(116 * UNIT));
    let out = sw.swap(&s.usdc, &s.eurc, &(116 * UNIT), &(99 * UNIT), &caller);
    // 116 USDC at 1.16 less the 0.3% pool fee and a sliver of price impact.
    assert!(out > 99 * UNIT && out < 100 * UNIT, "{out}");
    assert_eq!(TokenClient::new(&s.e, &s.eurc).balance(&caller), out);
    assert_eq!(TokenClient::new(&s.e, &s.usdc).balance(&sw.address), 0);
    assert_eq!(TokenClient::new(&s.e, &s.eurc).balance(&sw.address), 0);
    // Asking for more than the pool gives fails and moves nothing.
    StellarAssetClient::new(&s.e, &s.usdc).mint(&sw.address, &(116 * UNIT));
    assert!(sw
        .try_swap(&s.usdc, &s.eurc, &(116 * UNIT), &(101 * UNIT), &caller)
        .is_err());
}

/// A fiat SEP-40 oracle in USD with 14 decimals, like Reflector's.
#[contract]
pub struct Fx;

#[contractimpl]
impl Fx {
    pub fn lastprice(e: Env, asset: Asset) -> Option<PriceData> {
        let price = match asset {
            Asset::Other(s) if s == symbol_short!("USD") => 100_000_000_000_000,
            Asset::Other(s) if s == symbol_short!("EUR") => 116_000_000_000_000,
            _ => return None,
        };
        Some(PriceData {
            price,
            timestamp: e.ledger().timestamp(),
        })
    }
    pub fn decimals(_e: Env) -> u32 {
        14
    }
}

#[test]
fn a_vault_keeps_its_reserve_in_euros_through_soroswap() {
    let s = soroswap();
    let e = &s.e;
    let owner = Address::generate(e);
    let payer = Address::generate(e);
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
    let notice = 7 * 86_400;
    let v = ReserveVaultClient::new(
        e,
        &e.register(
            ReserveVault,
            (
                owner.clone(),
                rule,
                Address::generate(e),
                notice,
                PeriodKind::Quarter,
                30 * 86_400u64,
                soroban_sdk::vec![e, s.usdc.clone(), s.eurc.clone()],
            ),
        ),
    );
    let sw = e.register(SoroswapSwapper, (s.router.clone(),));
    let fx = e.register(Fx, ());
    v.propose_conversion(&Conversion {
        from_token: s.usdc.clone(),
        to_token: s.eurc.clone(),
        swapper: sw,
        oracle: fx,
        from_price: Asset::Other(symbol_short!("USD")),
        to_price: Asset::Other(symbol_short!("EUR")),
        max_slippage_bps: 100,
        max_age_secs: 3_600,
    });
    e.ledger().set_timestamp(FEB_10_2027 + notice);
    StellarAssetClient::new(e, &s.usdc).mint(&payer, &(1_210 * UNIT));
    v.receive(
        &payer,
        &s.usdc,
        &(1_210 * UNIT),
        &BytesN::from_array(e, &[1; 32]),
    );
    let q = v.current_period();
    let out = v.convert(&q);
    // 410 USDC is 353.45 EUR at the oracle price; the pool fee leaves a little less.
    assert!(out > 3_499_000_000 && out < 3_535_000_000, "{out}");
    let p = v.period(&q, &s.eurc);
    assert_eq!(
        p.buckets.get(symbol_short!("vat")).unwrap()
            + p.buckets.get(symbol_short!("irpf")).unwrap(),
        out
    );
    assert_eq!(TokenClient::new(e, &s.eurc).balance(&v.address), out);
    assert_eq!(TokenClient::new(e, &s.usdc).balance(&v.address), 0);
}
