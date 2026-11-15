//! The Router under random single payments and payroll runs to several
//! vaults, one of which does not accept the token.
//!
//! Invariants:
//!
//! - R1 Conservation: the payer is debited exactly the sum of the payments
//!   that went through; each owner receives exactly their net amounts and
//!   each vault exactly its reserve.
//! - R2 All or nothing: a run with one refused payment moves nothing.
//! - R3 The Router never holds funds.
use crate::*;
use arbitrary::{Arbitrary, Unstructured};
use kyros_reserve_vault::{ReserveVault, ReserveVaultClient};
use kyros_router::{Payout, Router, RouterClient};
use kyros_types::{InvoiceTerms, PeriodKind, Rule};
use soroban_sdk::{testutils::Address as _, token::StellarAssetClient, vec, Address, BytesN};
use std::vec::Vec;

/// One call to the Router.
#[derive(Clone, Debug)]
pub enum Op {
    /// `pay` to vault `vault % 3`.
    Pay {
        vault: u8,
        gross: i128,
        reference: u8,
    },
    /// `pay_many` with up to eight payouts.
    PayMany(Vec<(u8, i128, u8)>),
    Days(u64),
}

impl<'a> Arbitrary<'a> for Op {
    fn arbitrary(u: &mut Unstructured<'a>) -> arbitrary::Result<Self> {
        Ok(match u.int_in_range(0u8..=5)? {
            0..=2 => Op::Pay {
                vault: u.arbitrary()?,
                gross: super::vault::amount(u)?,
                reference: u.arbitrary()?,
            },
            3 | 4 => {
                let n = u.int_in_range(0usize..=8)?;
                let mut v = Vec::with_capacity(n);
                for _ in 0..n {
                    v.push((u.arbitrary()?, super::vault::amount(u)?, u.arbitrary()?));
                }
                Op::PayMany(v)
            }
            _ => Op::Days(u.int_in_range(0..=40)?),
        })
    }
}

/// A Router, a payer and three vaults: Spanish rules, a vault for clients
/// abroad (no VAT, through payer terms), and one that takes another token.
pub struct Run {
    pub e: soroban_sdk::Env,
    pub router: RouterClient<'static>,
    pub token: Address,
    pub payer: Address,
    pub vaults: Vec<ReserveVaultClient<'static>>,
    pub owners: Vec<Address>,
    /// Expected (owner received, vault reserve) per vault.
    expected: Vec<(i128, i128)>,
    paid: i128,
    start: i128,
}

impl Run {
    pub fn new() -> Run {
        let w = World::new();
        let e = w.e.clone();
        e.cost_estimate().budget().reset_unlimited();
        let router = RouterClient::new(&e, &e.register(Router, ()));
        let other = e
            .register_stellar_asset_contract_v2(Address::generate(&e))
            .address();
        let mut vaults = Vec::new();
        let mut owners = Vec::new();
        for (i, tok) in [&w.token, &w.token, &other].into_iter().enumerate() {
            let owner = Address::generate(&e);
            let rule = if i == 1 {
                Rule {
                    vat_bps: 0,
                    buckets: spain(&e).buckets,
                }
            } else {
                spain(&e)
            };
            let v = ReserveVaultClient::new(
                &e,
                &e.register(
                    ReserveVault,
                    (
                        owner.clone(),
                        rule,
                        Address::generate(&e),
                        NOTICE,
                        PeriodKind::Quarter,
                        kyros_reserve_vault::dues_after(&e, DUE_OFFSET),
                        vec![&e, tok.clone()],
                    ),
                ),
            );
            vaults.push(v);
            owners.push(owner);
        }
        // The vault for clients abroad registers the payer's terms: no VAT.
        vaults[1].expect_payer(
            &w.payer,
            &InvoiceTerms {
                vat_bps: 0,
                withholding_bps: 0,
                buckets: spain(&e).buckets,
            },
        );
        StellarAssetClient::new(&e, &w.token).mint(&w.payer, &(1_000_000 * UNIT));
        let start = w.balance(&w.payer);
        Run {
            start,
            router,
            token: w.token.clone(),
            payer: w.payer.clone(),
            vaults,
            owners,
            expected: std::vec![(0, 0); 3],
            paid: 0,
            e,
        }
    }

    fn bal(&self, a: &Address) -> i128 {
        soroban_sdk::token::Client::new(&self.e, &self.token).balance(a)
    }

    fn state(&self) -> Vec<i128> {
        let mut s = std::vec![self.bal(&self.payer), self.bal(&self.router.address)];
        for (v, o) in self.vaults.iter().zip(&self.owners) {
            s.push(self.bal(&v.address));
            s.push(self.bal(o));
        }
        s
    }

    /// Applies `op`, then checks every invariant (panics if one breaks).
    pub fn apply(&mut self, op: &Op) {
        let before = self.state();
        let ok = match op {
            Op::Pay {
                vault,
                gross,
                reference,
            } => {
                let i = *vault as usize % 3;
                let r = self.router.try_pay(
                    &self.payer,
                    &self.vaults[i].address,
                    &self.token,
                    gross,
                    &BytesN::from_array(&self.e, &[*reference; 32]),
                );
                if let Ok(Ok(s)) = &r {
                    assert_eq!(s.net + s.reserve, *gross);
                    self.expected[i].0 += s.net;
                    self.expected[i].1 += s.reserve;
                    self.paid += gross;
                }
                r.is_ok()
            }
            Op::PayMany(items) => {
                let mut payouts = vec![&self.e];
                for (v, g, r) in items {
                    payouts.push_back(Payout {
                        vault: self.vaults[*v as usize % 3].address.clone(),
                        gross: *g,
                        reference: BytesN::from_array(&self.e, &[*r; 32]),
                    });
                }
                let r = self.router.try_pay_many(&self.payer, &self.token, &payouts);
                if let Ok(Ok(splits)) = &r {
                    assert_eq!(splits.len() as usize, items.len());
                    for ((v, g, _), s) in items.iter().zip(splits.iter()) {
                        let i = *v as usize % 3;
                        assert_eq!(s.net + s.reserve, *g);
                        self.expected[i].0 += s.net;
                        self.expected[i].1 += s.reserve;
                        self.paid += g;
                    }
                }
                r.is_ok()
            }
            Op::Days(d) => {
                use soroban_sdk::testutils::Ledger as _;
                let t = self.e.ledger().timestamp() + d * DAY;
                self.e.ledger().set_timestamp(t);
                true
            }
        };
        // R2: a refused call, single or batched, moves nothing.
        if !ok {
            assert_eq!(self.state(), before, "a refused {op:?} moved money");
        }
        self.check();
    }

    /// R1 and R3.
    pub fn check(&self) {
        assert_eq!(self.bal(&self.payer), self.start - self.paid);
        assert_eq!(self.bal(&self.router.address), 0);
        for (i, (v, o)) in self.vaults.iter().zip(&self.owners).enumerate() {
            assert_eq!(self.bal(o), self.expected[i].0, "owner {i}");
            assert_eq!(self.bal(&v.address), self.expected[i].1, "vault {i}");
        }
    }
}

impl Default for Run {
    fn default() -> Self {
        Run::new()
    }
}
