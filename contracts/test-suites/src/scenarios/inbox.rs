//! A user's Inbox under random payments from anyone, junk tokens, sweeps by
//! anyone, returns of the junk, and moves to a new vault of the same owner,
//! plus an attempted move to someone else's vault.
//!
//! Invariants:
//!
//! - N1 Conservation: everything sent to the Inbox in the accepted token is
//!   either still in the Inbox, or reached the owner (net) and the vaults
//!   (reserve). Nobody else receives any of it.
//! - N2 A successful sweep leaves nothing of that token in the Inbox.
//! - N3 Junk is only ever returned to the owner's payout address.
//! - N4 The Inbox only ever follows a vault of the same owner, and only once
//!   the notice has passed.
//! - N5 A refused call moves nothing.
use crate::*;
use arbitrary::{Arbitrary, Unstructured};
use kyros_inbox::{Inbox, InboxClient};
use kyros_reserve_vault::{ReserveVault, ReserveVaultClient};
use kyros_types::PeriodKind;
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token::{self, StellarAssetClient},
    vec, Address, Env,
};
use std::vec::Vec;

/// One thing that can happen to an Inbox.
#[derive(Clone, Debug)]
pub enum Op {
    /// Someone sends `amount` of the accepted token.
    Send(i128),
    /// Someone sends a token the vault does not take.
    SendJunk(i128),
    Sweep,
    SweepJunk,
    ReturnJunk,
    ReturnAccepted,
    /// The owner moves the Inbox to their second vault.
    MoveToOwn,
    /// Someone tries to move it to their own vault.
    MoveToStranger,
    CancelMove,
    Days(u64),
}

impl<'a> Arbitrary<'a> for Op {
    fn arbitrary(u: &mut Unstructured<'a>) -> arbitrary::Result<Self> {
        Ok(match u.int_in_range(0u8..=11)? {
            0..=2 => Op::Send(u.int_in_range(1..=2_000 * UNIT)?),
            3 => Op::SendJunk(u.int_in_range(1..=2_000 * UNIT)?),
            4 | 5 => Op::Sweep,
            6 => Op::SweepJunk,
            7 => Op::ReturnJunk,
            8 => Op::ReturnAccepted,
            9 => Op::MoveToOwn,
            10 => match u.int_in_range(0u8..=1)? {
                0 => Op::MoveToStranger,
                _ => Op::CancelMove,
            },
            _ => Op::Days(u.int_in_range(0..=10)?),
        })
    }
}

pub struct Run {
    pub e: Env,
    pub inbox: InboxClient<'static>,
    pub token: Address,
    pub junk: Address,
    pub owner: Address,
    pub vaults: [ReserveVaultClient<'static>; 2],
    pub stranger_vault: Address,
    sender: Address,
    sent: i128,
    junk_sent: i128,
    /// Owner's net from sweeps, reserve into each vault.
    net: i128,
    reserve: i128,
}

fn vault_for(e: &Env, owner: &Address, token: &Address) -> ReserveVaultClient<'static> {
    ReserveVaultClient::new(
        e,
        &e.register(
            ReserveVault,
            (
                owner.clone(),
                spain(e),
                Address::generate(e),
                NOTICE,
                PeriodKind::Quarter,
                kyros_reserve_vault::dues_after(e, DUE_OFFSET),
                vec![e, token.clone()],
            ),
        ),
    )
}

impl Run {
    pub fn new() -> Run {
        let w = World::new();
        let e = w.e.clone();
        e.cost_estimate().budget().reset_unlimited();
        let second = vault_for(&e, &w.owner, &w.token);
        let stranger_vault = vault_for(&e, &Address::generate(&e), &w.token).address;
        let inbox = InboxClient::new(&e, &e.register(Inbox, (w.v.address.clone(),)));
        let junk = e
            .register_stellar_asset_contract_v2(Address::generate(&e))
            .address();
        let sender = Address::generate(&e);
        Run {
            inbox,
            token: w.token.clone(),
            junk,
            owner: w.owner.clone(),
            vaults: [w.v, second],
            stranger_vault,
            sender,
            sent: 0,
            junk_sent: 0,
            net: 0,
            reserve: 0,
            e,
        }
    }

    fn bal(&self, t: &Address, a: &Address) -> i128 {
        token::Client::new(&self.e, t).balance(a)
    }

    fn state(&self) -> Vec<i128> {
        std::vec![
            self.bal(&self.token, &self.inbox.address),
            self.bal(&self.junk, &self.inbox.address),
            self.bal(&self.token, &self.owner),
            self.bal(&self.junk, &self.owner),
            self.bal(&self.token, &self.vaults[0].address),
            self.bal(&self.token, &self.vaults[1].address),
        ]
    }

    /// Applies `op`, then checks every invariant (panics if one breaks).
    pub fn apply(&mut self, op: &Op) {
        let before = self.state();
        let before_vault = self.inbox.vault();
        let ok = match op {
            Op::Send(a) => {
                StellarAssetClient::new(&self.e, &self.token).mint(&self.inbox.address, a);
                self.sent += a;
                true
            }
            Op::SendJunk(a) => {
                StellarAssetClient::new(&self.e, &self.junk).mint(&self.inbox.address, a);
                self.junk_sent += a;
                true
            }
            Op::Sweep => {
                let r = self.inbox.try_sweep(&self.token);
                if let Ok(Ok(s)) = &r {
                    self.net += s.net;
                    self.reserve += s.reserve;
                    // N2
                    assert_eq!(self.bal(&self.token, &self.inbox.address), 0);
                }
                r.is_ok()
            }
            Op::SweepJunk => self.inbox.try_sweep(&self.junk).is_ok(),
            Op::ReturnJunk => self.inbox.try_return_unaccepted(&self.junk).is_ok(),
            Op::ReturnAccepted => {
                // The accepted token is never "returned": it is always split.
                let r = self.inbox.try_return_unaccepted(&self.token);
                assert!(r.is_err());
                false
            }
            Op::MoveToOwn => {
                let target = if self.inbox.vault() == self.vaults[0].address {
                    &self.vaults[1]
                } else {
                    &self.vaults[0]
                };
                self.inbox.try_propose_vault(&target.address).is_ok()
            }
            Op::MoveToStranger => {
                let r = self.inbox.try_propose_vault(&self.stranger_vault);
                assert!(r.is_err(), "moved to someone else's vault");
                false
            }
            Op::CancelMove => self.inbox.try_cancel_move().is_ok(),
            Op::Days(d) => {
                let t = self.e.ledger().timestamp() + d * DAY;
                self.e.ledger().set_timestamp(t);
                true
            }
        };
        // N5
        if !ok {
            assert_eq!(self.state(), before, "a refused {op:?} moved money");
        }
        // N4: the vault in force changes only to one of the owner's own,
        // and only through time passing (a move whose notice ended).
        let now_vault = self.inbox.vault();
        assert!(self.vaults.iter().any(|v| v.address == now_vault));
        if now_vault != before_vault {
            assert!(matches!(op, Op::Days(_)), "the vault changed on {op:?}");
        }
        self.check();
    }

    /// N1 and N3.
    pub fn check(&self) {
        let inbox = self.bal(&self.token, &self.inbox.address);
        let in_vaults = self.bal(&self.token, &self.vaults[0].address)
            + self.bal(&self.token, &self.vaults[1].address);
        assert_eq!(self.bal(&self.token, &self.owner), self.net);
        assert_eq!(in_vaults, self.reserve);
        assert_eq!(self.sent, inbox + self.net + self.reserve);
        assert_eq!(
            self.junk_sent,
            self.bal(&self.junk, &self.inbox.address) + self.bal(&self.junk, &self.owner)
        );
        assert_eq!(self.bal(&self.token, &self.sender), 0);
    }
}

impl Default for Run {
    fn default() -> Self {
        Run::new()
    }
}
