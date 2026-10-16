//! Kyros swapper over Soroswap: implements the `SwapApi` a Reserve Vault
//! uses to keep its reserve in the tax's currency (USDC to EURC).
//!
//! The vault sends `amount_in` to this contract and calls `swap`; the
//! contract swaps through the Soroswap router (direct pair) and sends the
//! output to `to`. It holds nothing between calls and has no admin. The
//! vault checks the result against its own oracle floor, so a bad route can
//! only make the swap fail, never take reserve.
#![no_std]
use soroban_sdk::{
    auth::{ContractContext, InvokerContractAuthEntry, SubContractInvocation},
    contract, contractclient, contracterror, contractimpl, contracttype, token, vec, Address, Env,
    IntoVal, Symbol, Vec,
};

/// The part of the Soroswap router this contract calls.
#[contractclient(name = "RouterClient")]
pub trait SoroswapRouter {
    fn router_pair_for(e: Env, token_a: Address, token_b: Address) -> Address;
    fn swap_exact_tokens_for_tokens(
        e: Env,
        amount_in: i128,
        amount_out_min: i128,
        path: Vec<Address>,
        to: Address,
        deadline: u64,
    ) -> Vec<i128>;
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum SwapError {
    InvalidAmount = 1,
}

#[contracttype]
#[derive(Clone)]
enum Key {
    Router,
}

#[contract]
pub struct SoroswapSwapper;

#[contractimpl]
impl SoroswapSwapper {
    pub fn __constructor(e: Env, router: Address) {
        e.storage().instance().set(&Key::Router, &router);
    }

    pub fn router(e: Env) -> Address {
        e.storage().instance().get(&Key::Router).unwrap()
    }

    /// Swaps `amount_in` of `token_in` (already sent here) for at least
    /// `min_out` of `token_out`, sent to `to`. Returns the amount sent.
    pub fn swap(
        e: Env,
        token_in: Address,
        token_out: Address,
        amount_in: i128,
        min_out: i128,
        to: Address,
    ) -> Result<i128, SwapError> {
        if amount_in <= 0 || min_out < 0 {
            return Err(SwapError::InvalidAmount);
        }
        let me = e.current_contract_address();
        let router = RouterClient::new(&e, &Self::router(e.clone()));
        let pair = router.router_pair_for(&token_in, &token_out);
        // The router moves `amount_in` from this contract to the pair: authorize exactly that transfer.
        e.authorize_as_current_contract(vec![
            &e,
            InvokerContractAuthEntry::Contract(SubContractInvocation {
                context: ContractContext {
                    contract: token_in.clone(),
                    fn_name: Symbol::new(&e, "transfer"),
                    args: (me.clone(), pair, amount_in).into_val(&e),
                },
                sub_invocations: vec![&e],
            }),
        ]);
        let amounts = router.swap_exact_tokens_for_tokens(
            &amount_in,
            &min_out,
            &vec![&e, token_in, token_out.clone()],
            &me,
            // The router needs a deadline strictly after now; the swap happens in this call.
            &(e.ledger().timestamp() + 1),
        );
        let out = amounts.last().unwrap();
        token::Client::new(&e, &token_out).transfer(&me, &to, &out);
        Ok(out)
    }
}

#[cfg(test)]
mod test;
