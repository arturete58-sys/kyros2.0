//! Kyros Inbox: one per user, a payment address that needs no integration.
//!
//! Anyone can pay the inbox with an ordinary SEP-41 `transfer` (an x402
//! payment, a wallet sending tokens to a contract address, an anchor
//! payout). `sweep` then splits whatever the inbox holds through the user's
//! vault: net to the owner, reserve to the vault. Anyone can call `sweep`;
//! the Kyros keeper calls it in the ledger after a payment arrives. If the
//! keeper stops, the funds stay here and can only ever go to the owner and
//! the vault.
//!
//! The owner can move the inbox to a new vault of theirs (for example after
//! moving to another country, whose taxes and calendar need a new vault).
//! The move waits for the current vault's notice period, so the payment
//! address stays the same and a stolen key cannot redirect it at once.
//!
//! No admin.
#![no_std]
use kyros_types::{Split, VaultClient};
use soroban_sdk::{
    auth::{ContractContext, InvokerContractAuthEntry, SubContractInvocation},
    contract, contracterror, contractevent, contractimpl, contracttype, token, vec, Address,
    BytesN, Env, IntoVal, Symbol, Vec,
};

const DAY_IN_LEDGERS: u32 = 17_280;
const INSTANCE_TTL: u32 = 180 * DAY_IN_LEDGERS;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum InboxError {
    NothingToSweep = 1,
    /// The vault accepts this token: use `sweep`.
    TokenAccepted = 2,
    /// The new vault must belong to the same owner.
    NotSameOwner = 3,
    NoPendingMove = 4,
    /// The move has already taken effect.
    AlreadyMoved = 5,
}

/// A move to another vault, waiting for the notice period.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingVault {
    pub vault: Address,
    pub ready_at: u64,
}

#[contracttype]
#[derive(Clone)]
enum Key {
    Vault,
    Swept,
    PendingVault,
}

#[contractevent(topics = ["kyros_inbox", "swept"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Swept {
    #[topic]
    pub token: Address,
    pub gross: i128,
    pub net: i128,
    pub reserve: i128,
    pub ledger: u32,
}

#[contractevent(topics = ["kyros_inbox", "returned"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Returned {
    #[topic]
    pub token: Address,
    pub amount: i128,
}

fn pending(e: &Env) -> Option<PendingVault> {
    e.storage().instance().get(&Key::PendingVault)
}

/// The vault in force: a pending move counts once its notice has passed.
fn vault(e: &Env) -> Address {
    if let Some(p) = pending(e) {
        if e.ledger().timestamp() >= p.ready_at {
            return p.vault;
        }
    }
    e.storage().instance().get(&Key::Vault).unwrap()
}

#[contractevent(topics = ["kyros_inbox", "move_proposed"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MoveProposed {
    pub vault: Address,
    pub ready_at: u64,
}

#[contractevent(topics = ["kyros_inbox", "move_cancelled"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MoveCancelled {
    pub vault: Address,
}

#[contract]
pub struct Inbox;

#[contractimpl]
impl Inbox {
    pub fn __constructor(e: Env, vault: Address) {
        e.storage().instance().set(&Key::Vault, &vault);
        e.storage()
            .instance()
            .extend_ttl(INSTANCE_TTL / 2, INSTANCE_TTL);
    }

    pub fn vault(e: Env) -> Address {
        vault(&e)
    }

    pub fn pending_vault(e: Env) -> Option<PendingVault> {
        pending(&e)
    }

    /// Moves the inbox to `new_vault` (same owner) after the current vault's
    /// notice period. Payments keep arriving at the same address; from the
    /// move on they are split by the new vault. The old vault keeps its
    /// reserves and releases them on their own dates.
    pub fn propose_vault(e: Env, new_vault: Address) -> Result<u64, InboxError> {
        let current = VaultClient::new(&e, &vault(&e));
        let owner = current.owner();
        owner.require_auth();
        if VaultClient::new(&e, &new_vault).owner() != owner {
            return Err(InboxError::NotSameOwner);
        }
        // Fold a move that already took effect before starting a new one.
        e.storage().instance().set(&Key::Vault, &current.address);
        let ready_at = e.ledger().timestamp() + current.notice_secs();
        e.storage().instance().set(
            &Key::PendingVault,
            &PendingVault {
                vault: new_vault.clone(),
                ready_at,
            },
        );
        e.storage()
            .instance()
            .extend_ttl(INSTANCE_TTL / 2, INSTANCE_TTL);
        MoveProposed {
            vault: new_vault,
            ready_at,
        }
        .publish(&e);
        Ok(ready_at)
    }

    /// Cancels a move that has not taken effect yet.
    pub fn cancel_move(e: Env) -> Result<(), InboxError> {
        let p = pending(&e).ok_or(InboxError::NoPendingMove)?;
        if e.ledger().timestamp() >= p.ready_at {
            return Err(InboxError::AlreadyMoved);
        }
        let current: Address = e.storage().instance().get(&Key::Vault).unwrap();
        VaultClient::new(&e, &current).owner().require_auth();
        e.storage().instance().remove(&Key::PendingVault);
        MoveCancelled { vault: p.vault }.publish(&e);
        Ok(())
    }

    /// Number of sweeps so far (a cheap way for the keeper to see progress).
    pub fn sweeps(e: Env) -> u32 {
        e.storage().instance().get(&Key::Swept).unwrap_or(0)
    }

    /// Splits the inbox's whole `token` balance through the vault. Permissionless.
    pub fn sweep(e: Env, token: Address) -> Result<Split, InboxError> {
        let me = e.current_contract_address();
        let gross = token::Client::new(&e, &token).balance(&me);
        if gross <= 0 {
            return Err(InboxError::NothingToSweep);
        }
        let v = VaultClient::new(&e, &vault(&e));
        let owner = v.owner();
        let s = v.quote(&gross);
        // The vault pulls the money from this inbox, so the inbox authorizes
        // exactly these two transfers for the vault's call, nothing else.
        let transfer = Symbol::new(&e, "transfer");
        let mut auths: Vec<InvokerContractAuthEntry> = Vec::new(&e);
        if s.net > 0 {
            auths.push_back(InvokerContractAuthEntry::Contract(SubContractInvocation {
                context: ContractContext {
                    contract: token.clone(),
                    fn_name: transfer.clone(),
                    args: (me.clone(), owner.clone(), s.net).into_val(&e),
                },
                sub_invocations: vec![&e],
            }));
        }
        if s.reserve > 0 {
            auths.push_back(InvokerContractAuthEntry::Contract(SubContractInvocation {
                context: ContractContext {
                    contract: token.clone(),
                    fn_name: transfer,
                    args: (me.clone(), v.address.clone(), s.reserve).into_val(&e),
                },
                sub_invocations: vec![&e],
            }));
        }
        e.authorize_as_current_contract(auths);
        let reference = BytesN::from_array(&e, &[0u8; 32]);
        let done = v.receive(&me, &token, &gross, &reference);
        let n: u32 = e.storage().instance().get(&Key::Swept).unwrap_or(0) + 1;
        e.storage().instance().set(&Key::Swept, &n);
        e.storage()
            .instance()
            .extend_ttl(INSTANCE_TTL / 2, INSTANCE_TTL);
        Swept {
            token,
            gross,
            net: done.net,
            reserve: done.reserve,
            ledger: e.ledger().sequence(),
        }
        .publish(&e);
        Ok(done)
    }

    /// Sends a token the vault does not accept back to the vault owner, so
    /// nothing sent by mistake is stuck here. Permissionless.
    pub fn return_unaccepted(e: Env, token: Address) -> Result<i128, InboxError> {
        let v = VaultClient::new(&e, &vault(&e));
        if v.accepts(&token) {
            return Err(InboxError::TokenAccepted);
        }
        let me = e.current_contract_address();
        let t = token::Client::new(&e, &token);
        let amount = t.balance(&me);
        if amount <= 0 {
            return Err(InboxError::NothingToSweep);
        }
        t.transfer(&me, &v.owner(), &amount);
        Returned { token, amount }.publish(&e);
        Ok(amount)
    }
}
