//! Hostile counterparties: contracts the vault calls that try to re-enter
//! it, a strategy that lies about its balance, and a currency with 18
//! decimals. Threats S5-S6 and E7-E8 in docs/threat-model.md.
//!
//! Soroban refuses to re-enter a contract that is already on the call stack;
//! these tests pin that down for every external call the vault makes while
//! it is in the middle of moving money, so a future SDK or host change that
//! weakened it would fail here first.
#![allow(clippy::arithmetic_side_effects)] // test code: amounts are small and known
use kyros_reserve_vault::{Conversion, ReserveVault, ReserveVaultClient, VaultError};
use kyros_test_suites::*;
use kyros_types::{Asset, PeriodKind};
use soroban_sdk::{
    symbol_short,
    testutils::{Address as _, Ledger},
    token::StellarAssetClient,
    vec, Address, Env,
};

/// S5. A strategy that, asked for money, calls back into the vault to pay
/// the tax again: the host refuses the re-entry, the payment waits
/// (`Illiquid`), and nothing moves.
#[test]
fn a_strategy_cannot_re_enter_the_vault() {
    let w = World::new();
    w.pay(1_210 * UNIT);
    let q = w.v.current_period();
    let y = ReentrantYieldClient::new(
        &w.e,
        &w.e.register(ReentrantYield, (w.v.address.clone(), w.token.clone())),
    );
    w.v.propose_strategy(&y.address, &10_000);
    w.at(FEB_10_2027 + NOTICE);
    assert_eq!(w.v.invest(), 410 * UNIT);
    y.arm(&w.v.address, &w.token, &Reenter::PayTax(q));
    let before = w.snapshot(q);
    assert_eq!(
        w.v.try_pay_tax(&q, &w.token, &w.vat(), &(210 * UNIT)),
        Err(Ok(VaultError::Illiquid))
    );
    assert_eq!(w.snapshot(q), before);
    assert_eq!(w.balance(&w.tax), 0);
}

/// S5. A token with transfer hooks that calls back into the vault in the
/// middle of a payment: the whole payment is refused, the books unchanged.
#[test]
fn a_token_with_hooks_cannot_re_enter_the_vault() {
    let e = Env::default();
    e.mock_all_auths();
    e.ledger().set_timestamp(FEB_10_2027);
    let token = e.register(Token, (7u32,));
    let w = World::with_token(e, token);
    w.pay(1_210 * UNIT);
    let q = w.v.current_period();
    TokenClient::new(&w.e, &w.token).arm(&w.v.address, &w.token, &Reenter::Receive(UNIT));
    let before = w.snapshot(q);
    assert!(w
        .v
        .try_receive(&w.payer, &w.token, &(121 * UNIT), &w.reference(2))
        .is_err());
    assert_eq!(w.snapshot(q), before);
}

/// S5. A swapper that calls back into the vault to release the reserve
/// before paying: the conversion fails whole.
#[test]
fn a_swapper_cannot_re_enter_the_vault() {
    let (w, eurc, oracle) = euro_vault();
    let s = ReentrantSwapperClient::new(&w.e, &w.e.register(ReentrantSwapper, ()));
    w.v.propose_conversion(&usd_to_eur(&w, &eurc, &oracle, &s.address));
    w.at(FEB_10_2027 + NOTICE);
    prices(&w, &oracle);
    w.pay(1_210 * UNIT);
    let q = w.v.current_period();
    s.arm(&w.v.address, &w.token, &Reenter::Release(q));
    let before = w.snapshot(q);
    assert!(w.v.try_convert(&q).is_err());
    assert_eq!(w.snapshot(q), before);
}

/// S6. A strategy that claims to hold i128::MAX: reading the position or
/// harvesting fails with `MathOverflow` instead of trapping, and payments,
/// which never trust that figure, keep working.
#[test]
fn a_strategy_lying_about_its_balance_breaks_no_payment() {
    let w = World::new();
    w.pay(1_210 * UNIT);
    let q = w.v.current_period();
    let liar = w.e.register(
        LyingYield,
        (w.v.address.clone(), w.token.clone(), i128::MAX),
    );
    w.v.propose_strategy(&liar, &5_000);
    w.at(FEB_10_2027 + NOTICE);
    assert_eq!(
        w.v.try_position(&w.token),
        Err(Ok(VaultError::MathOverflow))
    );
    assert_eq!(w.v.try_harvest(&w.token), Err(Ok(VaultError::MathOverflow)));
    w.v.pay_tax(&q, &w.token, &w.vat(), &(210 * UNIT));
    w.pay(121 * UNIT);
    assert_eq!(w.balance(&w.tax), 210 * UNIT);
    // And it can be removed at once.
    w.v.stop_strategy();
    assert_eq!(w.v.strategy(), None);
}

/// E7. A large reserve converted into a currency with 18 decimals: the
/// oracle floor multiplies far past i128 (amount x price x 10^11) before
/// dividing. Taken in 256 bits it is exact, and the swap goes through.
#[test]
fn a_large_reserve_converts_into_an_18_decimal_currency() {
    let e = Env::default();
    e.mock_all_auths();
    e.cost_estimate().budget().reset_unlimited();
    e.ledger().set_timestamp(FEB_10_2027);
    let usdc = e
        .register_stellar_asset_contract_v2(Address::generate(&e))
        .address();
    let eur18 = e.register(Token, (18u32,));
    let owner = Address::generate(&e);
    let payer = Address::generate(&e);
    let v = ReserveVaultClient::new(
        &e,
        &e.register(
            ReserveVault,
            (
                owner.clone(),
                spain(&e),
                Address::generate(&e),
                NOTICE,
                PeriodKind::Quarter,
                kyros_reserve_vault::dues_after(&e, DUE_OFFSET),
                vec![&e, usdc.clone(), eur18.clone()],
            ),
        ),
    );
    let oracle = OracleClient::new(&e, &e.register(Oracle, ()));
    let swapper = SwapperClient::new(&e, &e.register(Swapper, ()));
    // 1 EUR = 1.16 USD; 1 USDC unit (7 decimals) buys 10^11 / 1.16 EUR units.
    swapper.set_rate(&(100_000_000_000 * 100), &116);
    TokenClient::new(&e, &eur18).mint(&swapper.address, &(i128::MAX / 2));
    v.propose_conversion(&Conversion {
        from_token: usdc.clone(),
        to_token: eur18.clone(),
        swapper: swapper.address.clone(),
        oracle: oracle.address.clone(),
        from_price: Asset::Other(symbol_short!("USD")),
        to_price: Asset::Other(symbol_short!("EUR")),
        max_slippage_bps: 100,
        max_age_secs: 3_600,
    });
    let t = FEB_10_2027 + NOTICE;
    e.ledger().set_timestamp(t);
    oracle.set(
        &Asset::Other(symbol_short!("USD")),
        &100_000_000_000_000,
        &t,
    );
    oracle.set(
        &Asset::Other(symbol_short!("EUR")),
        &116_000_000_000_000,
        &t,
    );
    // 12.1 million dollars of invoices: 4.1 million of reserve.
    let gross = 12_100_000 * UNIT;
    StellarAssetClient::new(&e, &usdc).mint(&payer, &gross);
    v.receive(
        &payer,
        &usdc,
        &gross,
        &soroban_sdk::BytesN::from_array(&e, &[1; 32]),
    );
    let q = v.current_period();
    let out = v.convert(&q);
    // 4,100,000 USD at 1.16 is 3,534,482.758... EUR, in 18 decimals.
    assert_eq!(out, 3_534_482_758_620_689_655_172_413);
    let p = v.period(&q, &eur18);
    assert_eq!(
        p.buckets.get(symbol_short!("vat")).unwrap()
            + p.buckets.get(symbol_short!("irpf")).unwrap(),
        out
    );
    assert_eq!(v.position(&eur18).held, out);
    assert_eq!(v.position(&usdc).held, 0);
}

// ---- A vault taking dollars and euros ----

fn euro_vault() -> (World, soroban_sdk::Address, OracleClient<'static>) {
    let w = World::new();
    let eurc =
        w.e.register_stellar_asset_contract_v2(Address::generate(&w.e))
            .address();
    let v = ReserveVaultClient::new(
        &w.e,
        &w.e.register(
            ReserveVault,
            (
                w.owner.clone(),
                spain(&w.e),
                w.tax.clone(),
                NOTICE,
                PeriodKind::Quarter,
                kyros_reserve_vault::dues_after(&w.e, DUE_OFFSET),
                vec![&w.e, w.token.clone(), eurc.clone()],
            ),
        ),
    );
    let oracle = OracleClient::new(&w.e, &w.e.register(Oracle, ()));
    let w = World { v, ..w };
    (w, eurc, oracle)
}

fn usd_to_eur(w: &World, eurc: &Address, oracle: &OracleClient, swapper: &Address) -> Conversion {
    Conversion {
        from_token: w.token.clone(),
        to_token: eurc.clone(),
        swapper: swapper.clone(),
        oracle: oracle.address.clone(),
        from_price: Asset::Other(symbol_short!("USD")),
        to_price: Asset::Other(symbol_short!("EUR")),
        max_slippage_bps: 100,
        max_age_secs: 3_600,
    }
}

fn prices(w: &World, oracle: &OracleClient) {
    let t = w.e.ledger().timestamp();
    oracle.set(
        &Asset::Other(symbol_short!("USD")),
        &100_000_000_000_000,
        &t,
    );
    oracle.set(
        &Asset::Other(symbol_short!("EUR")),
        &116_000_000_000_000,
        &t,
    );
}

/// S7. A vault deployed with 0 notice (bypassing client-side SDK checks on-chain)
/// allows the owner to immediately extract 100% of the locked reserve before the due date.
#[test]
fn a_zero_notice_vault_bypasses_the_lock_invariant_instantly() {
    let e = Env::default();
    e.mock_all_auths();
    e.ledger().set_timestamp(FEB_10_2027);
    let token = e
        .register_stellar_asset_contract_v2(Address::generate(&e))
        .address();
    let owner = Address::generate(&e);
    let payer = Address::generate(&e);
    let tax = Address::generate(&e);

    // Deploy directly on Soroban with notice_secs = 0 (missing MIN_NOTICE_SECS constraint on-chain)
    let id = e.register(
        ReserveVault,
        (
            owner.clone(),
            spain(&e),
            tax.clone(),
            0u64,
            PeriodKind::Quarter,
            kyros_reserve_vault::dues_after(&e, DUE_OFFSET),
            vec![&e, token.clone()],
        ),
    );
    let v = ReserveVaultClient::new(&e, &id);
    let tc = StellarAssetClient::new(&e, &token);
    tc.mint(&payer, &(10_000 * UNIT));

    // Payment arrives and reserves tax
    v.receive(
        &payer,
        &token,
        &(1_210 * UNIT),
        &soroban_sdk::BytesN::from_array(&e, &[1u8; 32]),
    );
    let q = v.current_period();
    let p = v.period(&q, &token);
    assert_eq!(p.reserved, 410 * UNIT);

    // Path 1: Propose correction with 0 notice takes funds back immediately at block 0
    let c_id = v.propose_correction(&q, &token, &symbol_short!("vat"), &(210 * UNIT));
    let released = v.apply_correction(&c_id);
    assert_eq!(released, 210 * UNIT);

    // Path 2: Propose destination with 0 notice switches tax destination to owner immediately
    v.propose_destination(&owner);
    v.apply_pending();
    assert_eq!(v.config().tax_destination, owner);

    // Now owner calls pay_tax directly to own wallet, draining the remaining IRPF
    v.pay_tax(&q, &token, &symbol_short!("irpf"), &(200 * UNIT));

    // Both buckets are completely emptied at block 0, months before APR_1_2027 due date
    let p_after = v.period(&q, &token);
    assert_eq!(p_after.buckets.get(symbol_short!("vat")).unwrap(), 0);
    assert_eq!(p_after.buckets.get(symbol_short!("irpf")).unwrap(), 0);
}

/// S8. State drift in EarliestSet: When set_due pushes a date forward (tax office extension),
/// EarliestSet remains stuck at the old early date, permanently blocking yield investment.
#[test]
fn set_due_forward_extension_leaves_stale_earliest_set() {
    let w = World::new();
    w.pay(1_210 * UNIT);
    let q = w.v.current_period();

    // 1. Initial due dates are months away (APR_1_2027 + DUE_OFFSET)
    assert_eq!(w.v.due_soon(&w.token), 0);

    // 2. set_due sets an early date for IRPF only (8 days away, within the 14-day INVEST_HORIZON_SECS)
    let today_day = (FEB_10_2027 / DAY) as u32;
    w.v.set_due(&symbol_short!("irpf"), &q, &q, &(today_day + 8));

    // Notice: EarliestSet is per-period, so setting IRPF early taints ALL buckets (VAT + IRPF = 410)
    assert_eq!(w.v.due_soon(&w.token), 410 * UNIT);

    // 3. Tax office grants a 6-month extension! Owner calls set_due for 180 days in the future
    w.v.set_due(&symbol_short!("irpf"), &q, &q, &(today_day + 180));

    // Bucket due date is indeed updated to 180 days away
    assert!(w.v.bucket_due_date(&q, &symbol_short!("irpf")) > FEB_10_2027 + 100 * DAY);

    // BUG VERIFICATION: due_soon SHOULD be 0 because both taxes are far away (APR_1_2027 / +180d).
    // But EarliestSet was not updated on forward shift, so due_soon still reports 410 units forever!
    let reported_soon = w.v.due_soon(&w.token);
    assert_eq!(reported_soon, 410 * UNIT);
}


