//! Kyros yield strategy over a Blend v2 pool: implements the `YieldApi` a
//! Reserve Vault uses to lend part of its reserve.
//!
//! One instance per vault: `owner` is the vault, and only the owner can
//! deposit or withdraw. The instance supplies the asset to the pool as a
//! plain (non-collateral) supply position held in its own name, so it never
//! borrows and cannot be liquidated, and withdrawals go straight back to the
//! vault. No admin, no fees.
//!
//! Risks the owner takes: the pool's bad debt (covered first by its
//! backstop), and a pool so fully lent out that a withdrawal has to wait.
#![no_std]
use kyros_types::{TTL_EXTEND_TO, TTL_THRESHOLD};
use soroban_sdk::{
    auth::{ContractContext, InvokerContractAuthEntry, SubContractInvocation},
    contract, contracterror, contractimpl, contracttype, token, vec, Address, Env, IntoVal, Symbol,
};

soroban_sdk::contractmeta!(
    key = "Description",
    val = "Kyros yield strategy over a Blend v2 pool, one per vault."
);
soroban_sdk::contractmeta!(
    key = "Source",
    val = "https://github.com/arturete58-sys/kyros2.0"
);

/// Types and client of the Blend v2 pool, from its published interface.
#[allow(clippy::too_many_arguments)]
pub mod pool {
    soroban_sdk::contractimport!(file = "../vendor/blend/pool.wasm");
}

/// Blend request types used here.
const SUPPLY: u32 = 0;
const WITHDRAW: u32 = 1;
/// Blend's b_rate has 12 decimals.
const SCALAR_12: i128 = 1_000_000_000_000;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum YieldError {
    /// The amount must be positive.
    InvalidAmount = 1,
}

#[contracttype]
#[derive(Clone)]
enum Key {
    Setup,
}

#[contracttype]
#[derive(Clone)]
struct Setup {
    owner: Address,
    pool: Address,
    asset: Address,
}

fn setup(e: &Env) -> Setup {
    e.storage().instance().get(&Key::Setup).unwrap()
}

/// Extends this instance only: the shared wasm's rent is paid once for all
/// instances (anyone can extend it), not by each vault's strategy.
fn bump(e: &Env) {
    e.deployer().extend_ttl_for_contract_instance(
        e.current_contract_address(),
        TTL_THRESHOLD,
        TTL_EXTEND_TO,
    );
}

#[contract]
pub struct BlendYield;

#[contractimpl]
impl BlendYield {
    /// `owner` is the vault this instance works for; `pool` the Blend v2
    /// pool and `asset` the token it lends there.
    pub fn __constructor(e: Env, owner: Address, pool: Address, asset: Address) {
        e.storage()
            .instance()
            .set(&Key::Setup, &Setup { owner, pool, asset });
    }

    /// The vault this instance works for: the only one that can move funds.
    pub fn owner(e: Env) -> Address {
        setup(&e).owner
    }

    /// The token this instance lends.
    pub fn asset(e: Env) -> Address {
        setup(&e).asset
    }

    /// The Blend v2 pool it lends to.
    pub fn pool(e: Env) -> Address {
        setup(&e).pool
    }

    /// Supplies `amount` of the asset (already sent here by the owner) to the pool.
    pub fn deposit(e: Env, amount: i128) -> Result<(), YieldError> {
        let s = setup(&e);
        s.owner.require_auth();
        if amount <= 0 {
            return Err(YieldError::InvalidAmount);
        }
        let me = e.current_contract_address();
        // The pool pulls `amount` from this contract: authorize exactly that transfer.
        e.authorize_as_current_contract(vec![
            &e,
            InvokerContractAuthEntry::Contract(SubContractInvocation {
                context: ContractContext {
                    contract: s.asset.clone(),
                    fn_name: Symbol::new(&e, "transfer"),
                    args: (me.clone(), s.pool.clone(), amount).into_val(&e),
                },
                sub_invocations: vec![&e],
            }),
        ]);
        pool::Client::new(&e, &s.pool).submit(
            &me,
            &me,
            &me,
            &vec![
                &e,
                pool::Request {
                    request_type: SUPPLY,
                    address: s.asset,
                    amount,
                },
            ],
        );
        bump(&e);
        Ok(())
    }

    /// Withdraws up to `amount` straight to the owner (the pool pays out at
    /// most the whole position); returns what arrived.
    pub fn withdraw(e: Env, amount: i128) -> Result<i128, YieldError> {
        let s = setup(&e);
        s.owner.require_auth();
        if amount <= 0 {
            return Err(YieldError::InvalidAmount);
        }
        let me = e.current_contract_address();
        let t = token::Client::new(&e, &s.asset);
        let before = t.balance(&s.owner);
        pool::Client::new(&e, &s.pool).submit(
            &me,
            &me,
            &s.owner,
            &vec![
                &e,
                pool::Request {
                    request_type: WITHDRAW,
                    address: s.asset.clone(),
                    amount,
                },
            ],
        );
        bump(&e);
        Ok(t.balance(&s.owner) - before)
    }

    /// The asset the position is worth now: supply b-tokens times the pool's b_rate.
    pub fn balance(e: Env) -> i128 {
        let s = setup(&e);
        let p = pool::Client::new(&e, &s.pool);
        let reserve = p.get_reserve(&s.asset);
        let b = p
            .get_positions(&e.current_contract_address())
            .supply
            .get(reserve.config.index)
            .unwrap_or(0);
        b * reserve.data.b_rate / SCALAR_12
    }
}

#[cfg(test)]
mod test;
