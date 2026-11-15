//! Shared kit for the adversarial and property-based suites in `tests/`.
//!
//! Everything here is test-only: honest mocks of the protocols a vault talks
//! to (a SEP-41 token with any number of decimals, a SEP-40 oracle, a
//! swapper, a yield strategy) and hostile ones (a strategy that lies about its
//! balance, contracts that try to re-enter the vault). The suites build on a
//! Spanish vault (21% VAT, 20% income tax, quarterly, due 30 days after the
//! quarter) like the one deployed on testnet.
//!
//! The threat model these tests check is in `docs/threat-model.md`.
#![no_std]
#![allow(clippy::arithmetic_side_effects)] // test code: amounts are small and known
extern crate std;

pub mod scenarios;

use kyros_reserve_vault::{ReserveVault, ReserveVaultClient};
use kyros_types::{Asset, Bucket, PeriodKind, PriceData, Rule};
use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short,
    testutils::{Address as _, Ledger},
    token::{self, StellarAssetClient},
    vec, Address, BytesN, Env, Map, Symbol, Vec,
};

/// 2027-02-10 12:00 UTC: inside Q1 2027.
pub const FEB_10_2027: u64 = 1_802_260_800;
/// 2027-04-01 00:00 UTC: Q1 2027 ends.
pub const APR_1_2027: u64 = 1_806_537_600;
/// Q1's buckets are due 30 days after it ends (1 May 2027).
pub const DUE_OFFSET: u64 = 30 * 86_400;
/// A week's notice for every change.
pub const NOTICE: u64 = 7 * 86_400;
/// One unit of a 7-decimal Stellar asset.
pub const UNIT: i128 = 10_000_000;
pub const DAY: u64 = 86_400;

/// 21% VAT, 20% income tax on the base.
pub fn spain(e: &Env) -> Rule {
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

/// A vault, its token and the people around it.
pub struct World {
    pub e: Env,
    pub v: ReserveVaultClient<'static>,
    pub token: Address,
    pub owner: Address,
    pub payer: Address,
    pub tax: Address,
}

impl World {
    /// A Spanish vault taking one Stellar asset; the payer holds 10,000.
    /// Every auth is mocked: suites that test authorization replace it.
    pub fn new() -> World {
        let e = Env::default();
        e.mock_all_auths();
        e.ledger().set_timestamp(FEB_10_2027);
        let token = e
            .register_stellar_asset_contract_v2(Address::generate(&e))
            .address();
        World::with_token(e, token)
    }

    /// A Spanish vault taking `token` (already registered in `e`).
    pub fn with_token(e: Env, token: Address) -> World {
        let owner = Address::generate(&e);
        let payer = Address::generate(&e);
        let tax = Address::generate(&e);
        let id = e.register(
            ReserveVault,
            (
                owner.clone(),
                spain(&e),
                tax.clone(),
                NOTICE,
                PeriodKind::Quarter,
                kyros_reserve_vault::dues_after(&e, DUE_OFFSET),
                vec![&e, token.clone()],
            ),
        );
        let v = ReserveVaultClient::new(&e, &id);
        let w = World {
            e,
            v,
            token,
            owner,
            payer,
            tax,
        };
        w.mint(&w.payer.clone(), 10_000 * UNIT);
        w
    }

    /// Mints `amount` of the vault's token to `to` (a Stellar asset or a [`Token`]).
    pub fn mint(&self, to: &Address, amount: i128) {
        if self.is_sac() {
            StellarAssetClient::new(&self.e, &self.token).mint(to, &amount);
        } else {
            TokenClient::new(&self.e, &self.token).mint(to, &amount);
        }
    }

    fn is_sac(&self) -> bool {
        // Our mock token answers `kind`; a Stellar asset contract does not.
        TokenClient::new(&self.e, &self.token).try_kind().is_err()
    }

    pub fn balance(&self, who: &Address) -> i128 {
        token::Client::new(&self.e, &self.token).balance(who)
    }

    /// An invoice reference.
    pub fn reference(&self, n: u8) -> BytesN<32> {
        BytesN::from_array(&self.e, &[n; 32])
    }

    /// The payer pays `gross` straight into the vault.
    pub fn pay(&self, gross: i128) -> kyros_types::Split {
        self.v
            .receive(&self.payer, &self.token, &gross, &self.reference(1))
    }

    /// Moves the ledger clock to `t` (and the sequence with it, 5 s a ledger).
    pub fn at(&self, t: u64) {
        let now = self.e.ledger().timestamp();
        let seq = self.e.ledger().sequence();
        self.e.ledger().set_timestamp(t);
        if t > now {
            self.e
                .ledger()
                .set_sequence_number(seq + ((t - now) / 5) as u32);
        }
    }

    /// Every amount of the period's books in the vault's token, as a tuple
    /// that can be compared before and after a refused call.
    pub fn snapshot(&self, period: u32) -> (i128, i128, i128, i128, i128, Map<Symbol, i128>) {
        let p = self.v.period(&period, &self.token);
        (
            self.balance(&self.v.address),
            p.reserved,
            p.paid,
            p.released,
            p.converted,
            p.buckets,
        )
    }

    /// The vault's own record of its reserve in the token.
    pub fn held(&self) -> i128 {
        self.v.position(&self.token).held
    }

    pub fn vat(&self) -> Symbol {
        symbol_short!("vat")
    }

    pub fn irpf(&self) -> Symbol {
        symbol_short!("irpf")
    }
}

impl Default for World {
    fn default() -> Self {
        World::new()
    }
}

// ---- Honest mocks ----

/// A SEP-41 token with any number of decimals: a bridged ERC-20 with 18, a
/// token with 0. `kind` tells it apart from a Stellar asset contract.
#[contract]
pub struct Token;

#[contracttype]
enum TokenKey {
    Decimals,
    Balance(Address),
}

#[contractimpl]
impl Token {
    pub fn __constructor(e: Env, decimals: u32) {
        e.storage().instance().set(&TokenKey::Decimals, &decimals);
    }
    pub fn kind(_e: Env) -> Symbol {
        symbol_short!("mock")
    }
    pub fn decimals(e: Env) -> u32 {
        e.storage().instance().get(&TokenKey::Decimals).unwrap()
    }
    pub fn mint(e: Env, to: Address, amount: i128) {
        let b = Self::balance(e.clone(), to.clone());
        e.storage()
            .persistent()
            .set(&TokenKey::Balance(to), &(b + amount));
    }
    pub fn balance(e: Env, id: Address) -> i128 {
        e.storage()
            .persistent()
            .get(&TokenKey::Balance(id))
            .unwrap_or(0)
    }
    /// Makes every later transfer call back into a vault first (a token with
    /// transfer hooks, like ERC-777).
    pub fn arm(e: Env, vault: Address, token: Address, what: Reenter) {
        e.storage().instance().set(&1u32, &(vault, token, what));
    }
    pub fn transfer(e: Env, from: Address, to: soroban_sdk::MuxedAddress, amount: i128) {
        from.require_auth();
        if e.storage().instance().has(&1u32) {
            reenter(&e);
        }
        let to = to.address();
        let fb = Self::balance(e.clone(), from.clone());
        assert!(amount >= 0 && fb >= amount, "insufficient balance");
        e.storage()
            .persistent()
            .set(&TokenKey::Balance(from), &(fb - amount));
        let tb = Self::balance(e.clone(), to.clone());
        e.storage()
            .persistent()
            .set(&TokenKey::Balance(to), &(tb + amount));
    }
}

/// A SEP-40 oracle with 14 decimals whose prices the test sets.
#[contract]
pub struct Oracle;

#[contractimpl]
impl Oracle {
    pub fn set(e: Env, asset: Asset, price: i128, timestamp: u64) {
        let mut m: Map<Asset, PriceData> =
            e.storage().instance().get(&0u32).unwrap_or(Map::new(&e));
        m.set(asset, PriceData { price, timestamp });
        e.storage().instance().set(&0u32, &m);
    }
    pub fn lastprice(e: Env, asset: Asset) -> Option<PriceData> {
        let m: Map<Asset, PriceData> = e.storage().instance().get(&0u32)?;
        m.get(asset)
    }
    pub fn decimals(_e: Env) -> u32 {
        14
    }
}

/// Pays `num/den` of `token_out` per unit of `token_in`, from its own balance.
#[contract]
pub struct Swapper;

#[contractimpl]
impl Swapper {
    pub fn set_rate(e: Env, num: i128, den: i128) {
        e.storage().instance().set(&0u32, &(num, den));
    }
    pub fn swap(
        e: Env,
        _token_in: Address,
        token_out: Address,
        amount_in: i128,
        _min_out: i128,
        to: Address,
    ) -> i128 {
        let (num, den): (i128, i128) = e.storage().instance().get(&0u32).unwrap();
        let out = kyros_types::mul_div_floor(&e, amount_in, num, den).unwrap();
        token::Client::new(&e, &token_out).transfer(&e.current_contract_address(), &to, &out);
        out
    }
}

/// A yield strategy for one vault: it holds what it is given; the test mints
/// "interest" to it, burns a "loss", or makes it fully lent.
#[contract]
pub struct Yield;

#[contracttype]
enum YieldKey {
    Owner,
    Asset,
    LentOut,
}

#[contractimpl]
impl Yield {
    pub fn __constructor(e: Env, owner: Address, asset: Address) {
        e.storage().instance().set(&YieldKey::Owner, &owner);
        e.storage().instance().set(&YieldKey::Asset, &asset);
    }
    pub fn owner(e: Env) -> Address {
        e.storage().instance().get(&YieldKey::Owner).unwrap()
    }
    pub fn asset(e: Env) -> Address {
        e.storage().instance().get(&YieldKey::Asset).unwrap()
    }
    pub fn set_lent_out(e: Env, lent_out: bool) {
        e.storage().instance().set(&YieldKey::LentOut, &lent_out);
    }
    pub fn deposit(e: Env, _amount: i128) {
        Self::owner(e).require_auth();
    }
    pub fn withdraw(e: Env, amount: i128) -> i128 {
        let owner = Self::owner(e.clone());
        owner.require_auth();
        if e.storage()
            .instance()
            .get(&YieldKey::LentOut)
            .unwrap_or(false)
        {
            panic!("fully lent");
        }
        let out = amount.min(Self::balance(e.clone()));
        token::Client::new(&e, &Self::asset(e.clone())).transfer(
            &e.current_contract_address(),
            &owner,
            &out,
        );
        out
    }
    pub fn balance(e: Env) -> i128 {
        token::Client::new(&e, &Self::asset(e.clone())).balance(&e.current_contract_address())
    }
}

// ---- Hostile mocks ----

/// A strategy that reports whatever balance the test sets, and holds nothing.
#[contract]
pub struct LyingYield;

#[contractimpl]
impl LyingYield {
    pub fn __constructor(e: Env, owner: Address, asset: Address, claims: i128) {
        e.storage().instance().set(&0u32, &(owner, asset, claims));
    }
    pub fn owner(e: Env) -> Address {
        let (o, _, _): (Address, Address, i128) = e.storage().instance().get(&0u32).unwrap();
        o
    }
    pub fn asset(e: Env) -> Address {
        let (_, a, _): (Address, Address, i128) = e.storage().instance().get(&0u32).unwrap();
        a
    }
    pub fn deposit(_e: Env, _amount: i128) {}
    pub fn withdraw(_e: Env, _amount: i128) -> i128 {
        0
    }
    pub fn balance(e: Env) -> i128 {
        let (_, _, c): (Address, Address, i128) = e.storage().instance().get(&0u32).unwrap();
        c
    }
}

/// What a re-entering contract tries to do inside the vault's call.
#[contracttype]
#[derive(Clone)]
pub enum Reenter {
    /// Pay the VAT of `period` again, to the tax destination.
    PayTax(u32),
    /// Release `period` to the owner.
    Release(u32),
    /// Book a payment of `gross` from itself.
    Receive(i128),
}

fn reenter(e: &Env) {
    let (vault, token, what): (Address, Address, Reenter) =
        e.storage().instance().get(&1u32).unwrap();
    let v = ReserveVaultClient::new(e, &vault);
    match what {
        Reenter::PayTax(p) => v.pay_tax(&p, &token, &symbol_short!("vat"), &1),
        Reenter::Release(p) => {
            v.release(&p, &token);
        }
        Reenter::Receive(g) => {
            v.receive(
                &e.current_contract_address(),
                &token,
                &g,
                &BytesN::from_array(e, &[9; 32]),
            );
        }
    }
}

/// A strategy whose `withdraw` calls back into the vault.
#[contract]
pub struct ReentrantYield;

#[contractimpl]
impl ReentrantYield {
    pub fn __constructor(e: Env, owner: Address, asset: Address) {
        e.storage().instance().set(&0u32, &(owner, asset));
    }
    pub fn arm(e: Env, vault: Address, token: Address, what: Reenter) {
        e.storage().instance().set(&1u32, &(vault, token, what));
    }
    pub fn owner(e: Env) -> Address {
        let (o, _): (Address, Address) = e.storage().instance().get(&0u32).unwrap();
        o
    }
    pub fn asset(e: Env) -> Address {
        let (_, a): (Address, Address) = e.storage().instance().get(&0u32).unwrap();
        a
    }
    pub fn deposit(_e: Env, _amount: i128) {}
    pub fn withdraw(e: Env, _amount: i128) -> i128 {
        reenter(&e);
        0
    }
    pub fn balance(e: Env) -> i128 {
        token::Client::new(&e, &Self::asset(e.clone())).balance(&e.current_contract_address())
    }
}

/// A swapper whose `swap` calls back into the vault before paying.
#[contract]
pub struct ReentrantSwapper;

#[contractimpl]
impl ReentrantSwapper {
    pub fn arm(e: Env, vault: Address, token: Address, what: Reenter) {
        e.storage().instance().set(&1u32, &(vault, token, what));
    }
    pub fn swap(
        e: Env,
        _token_in: Address,
        _token_out: Address,
        _amount_in: i128,
        _min_out: i128,
        _to: Address,
    ) -> i128 {
        reenter(&e);
        0
    }
}

/// Every symbol in a map, for comparing books.
pub fn keys(m: &Map<Symbol, i128>) -> Vec<Symbol> {
    m.keys()
}

/// A contract posing as a vault: its `receive` pulls twice the payment from
/// the payer, to itself.
#[contract]
pub struct GreedyVault;

#[contractimpl]
impl GreedyVault {
    pub fn receive(
        e: Env,
        from: Address,
        token: Address,
        gross: i128,
        _reference: BytesN<32>,
    ) -> kyros_types::Split {
        token::Client::new(&e, &token).transfer(&from, e.current_contract_address(), &(gross * 2));
        kyros_types::Split {
            gross,
            base: gross,
            vat: 0,
            parts: Vec::new(&e),
            fixed: 0,
            reserve: gross,
            net: 0,
        }
    }
}

/// Cases for a property test: `default`, or `KYROS_PROPTEST_CASES` when set
/// (mutation testing runs the suites once per mutant, with fewer cases).
pub fn cases(default: u32) -> u32 {
    std::env::var("KYROS_PROPTEST_CASES")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}
