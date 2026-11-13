//! Kyros Router: one shared, stateless entry point for integrated payers.
//!
//! `pay` splits a payment inside the payer's own transaction: the payer signs
//! once, the vault sends the net amount to its owner and keeps the reserve,
//! and either everything happens or nothing does. Wallets, invoice links and
//! x402 integrations call this one contract whatever vault they pay.
//! `pay_many` does the same for a whole payout run (payroll, bounties,
//! grants): one signature, every payment split by its own vault.
//!
//! No admin, no storage.
#![no_std]
use kyros_types::{Split, VaultClient};
use soroban_sdk::{contract, contractevent, contractimpl, contracttype, Address, BytesN, Env, Vec};

soroban_sdk::contractmeta!(
    key = "Description",
    val = "Kyros Router: splits a payment in the payer's own transaction; stateless."
);
soroban_sdk::contractmeta!(
    key = "Source",
    val = "https://github.com/arturete58-sys/kyros2.0"
);

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

/// One payment of a batch: `gross` of the batch's token into `vault`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Payout {
    pub vault: Address,
    pub gross: i128,
    pub reference: BytesN<32>,
}

#[contract]
pub struct Router;

/// Pays one payment through its vault and publishes `Paid`.
fn pay_one(e: &Env, from: &Address, token: &Address, p: Payout) -> Split {
    let s = VaultClient::new(e, &p.vault).receive(from, token, &p.gross, &p.reference);
    Paid {
        vault: p.vault,
        reference: p.reference,
        from: from.clone(),
        token: token.clone(),
        gross: p.gross,
        net: s.net,
        reserve: s.reserve,
    }
    .publish(e);
    s
}

#[contractimpl]
impl Router {
    /// Pays `gross` of `token` from `from` through `vault`: the net amount to
    /// the vault's payout address, the reserve to the vault, split by the
    /// vault's terms for this payer and reference. `reference` is the invoice
    /// reference (sha256 of the invoice number), echoed in the events for
    /// reconciliation.
    pub fn pay(
        e: Env,
        from: Address,
        vault: Address,
        token: Address,
        gross: i128,
        reference: BytesN<32>,
    ) -> Split {
        from.require_auth();
        pay_one(
            &e,
            &from,
            &token,
            Payout {
                vault,
                gross,
                reference,
            },
        )
    }

    /// A platform pays many people at once (a payroll run, bounty payouts,
    /// grant tranches): one signature, one transaction, and every payment is
    /// split by its own vault. If any vault refuses, nothing is paid. The
    /// network's limit on event bytes per transaction fits about eight
    /// payments: larger runs go in several transactions (the SDK splits them).
    pub fn pay_many(e: Env, from: Address, token: Address, payouts: Vec<Payout>) -> Vec<Split> {
        from.require_auth();
        let mut out = Vec::new(&e);
        for p in payouts.iter() {
            out.push_back(pay_one(&e, &from, &token, p));
        }
        out
    }

    /// The split `vault`'s rule gives for `gross` (the vault's own `quote_in`
    /// adds a payer's or an invoice's terms and the period's fixed amounts).
    pub fn quote(e: Env, vault: Address, gross: i128) -> Split {
        VaultClient::new(&e, &vault).quote(&gross)
    }
}

#[cfg(test)]
mod test;
