//! Kyros Router: one shared, stateless entry point for integrated payers.
//!
//! `pay` splits a payment inside the payer's own transaction: the payer signs
//! once, the vault sends the net amount to its owner and keeps the reserve,
//! and either everything happens or nothing does. Wallets, invoice links and
//! x402 integrations call this one contract whatever vault they pay.
//!
//! No admin, no storage.
#![no_std]
use kyros_types::{Split, VaultClient};
use soroban_sdk::{contract, contractevent, contractimpl, Address, BytesN, Env};

#[contractevent(topics = ["kyros_router", "paid"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Paid {
    #[topic]
    pub vault: Address,
    #[topic]
    pub reference: BytesN<32>,
    pub from: Address,
    pub token: Address,
    pub gross: i128,
    pub net: i128,
    pub reserve: i128,
}

#[contract]
pub struct Router;

#[contractimpl]
impl Router {
    /// Pays `gross` of `token` from `from` to the owner of `vault`, split by the
    /// vault's rule. `reference` is the invoice reference (e.g. a hash of the
    /// invoice number), echoed in the events for reconciliation.
    pub fn pay(
        e: Env,
        from: Address,
        vault: Address,
        token: Address,
        gross: i128,
        reference: BytesN<32>,
    ) -> Split {
        from.require_auth();
        let s = VaultClient::new(&e, &vault).receive(&from, &token, &gross, &reference);
        Paid {
            vault,
            reference,
            from,
            token,
            gross,
            net: s.net,
            reserve: s.reserve,
        }
        .publish(&e);
        s
    }

    /// The split `vault` would apply to `gross` now.
    pub fn quote(e: Env, vault: Address, gross: i128) -> Split {
        VaultClient::new(&e, &vault).quote(&gross)
    }
}

#[cfg(test)]
mod test;
