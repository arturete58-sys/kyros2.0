//! The Rate Registry under random publications, withdrawals and time, with
//! a vault that follows it (ceiling 25%).
//!
//! Invariants:
//!
//! - G1 History is final: a rate observed in force at a moment never
//!   changes afterwards, whatever is published or withdrawn.
//! - G2 Nothing applies sooner than the notice: a publication is accepted
//!   only for a date at least `min_notice` away, and only for 0..=100%.
//! - G3 The schedule stays sorted by date, one entry per date.
//! - G4 The following vault applies the registry's rate exactly when it is
//!   at most its ceiling, and its own rule otherwise, at every moment.
use crate::*;
use arbitrary::{Arbitrary, Unstructured};
use kyros_rate_registry::{RateRegistry, RateRegistryClient};
use kyros_types::Rule;
use soroban_sdk::{
    symbol_short,
    testutils::{Address as _, Ledger},
    Env, Symbol,
};
use std::vec::Vec;

/// The registry's notice in these runs: 30 days.
pub const REGISTRY_NOTICE: u64 = 30 * DAY;
/// The following vault ignores any rate above this.
pub const CEILING: u32 = 2_500;

#[derive(Clone, Debug)]
pub enum Op {
    /// Publish `bps` from `days` from now.
    Publish {
        days: u64,
        bps: u32,
    },
    /// Withdraw the entry starting `days` from now.
    Withdraw {
        days: u64,
    },
    /// Withdraw the `i`-th entry of the schedule.
    WithdrawNth(u8),
    Days(u64),
}

impl<'a> Arbitrary<'a> for Op {
    fn arbitrary(u: &mut Unstructured<'a>) -> arbitrary::Result<Self> {
        let bps = |u: &mut Unstructured<'a>| -> arbitrary::Result<u32> {
            Ok(match u.int_in_range(0u8..=4)? {
                0 => 0,
                1 => 10_000,
                2 => 10_001,
                3 => CEILING + 1,
                _ => u.int_in_range(0..=3_000)?,
            })
        };
        Ok(match u.int_in_range(0u8..=7)? {
            0..=2 => Op::Publish {
                days: u.int_in_range(0..=90)?,
                bps: bps(u)?,
            },
            3 => Op::Withdraw {
                days: u.int_in_range(0..=90)?,
            },
            4 => Op::WithdrawNth(u.arbitrary()?),
            _ => Op::Days(u.int_in_range(0..=40)?),
        })
    }
}

pub struct Run {
    pub w: World,
    pub reg: RateRegistryClient<'static>,
    country: Symbol,
    name: Symbol,
    /// (moment, rate in force then) as observed.
    seen: Vec<(u64, u32)>,
}

impl Run {
    pub fn new() -> Run {
        let w = World::new();
        w.e.cost_estimate().budget().reset_unlimited();
        let admin = soroban_sdk::Address::generate(&w.e);
        let reg =
            RateRegistryClient::new(&w.e, &w.e.register(RateRegistry, (admin, REGISTRY_NOTICE)));
        let (country, name) = (symbol_short!("ES"), symbol_short!("standard"));
        reg.seed(&country, &name, &2_100);
        w.v.follow(&reg.address, &country, &name, &CEILING);
        let mut r = Run {
            w,
            reg,
            country,
            name,
            seen: Vec::new(),
        };
        r.observe();
        r
    }

    fn now(&self) -> u64 {
        self.w.e.ledger().timestamp()
    }

    fn observe(&mut self) {
        let t = self.now();
        let r = self.reg.rate_at(&self.country, &self.name, &t).unwrap();
        self.seen.push((t, r));
    }

    /// Applies `op`, then checks every invariant (panics if one breaks).
    pub fn apply(&mut self, op: &Op) {
        let e: &Env = &self.w.e;
        let schedule_before = self.reg.schedule(&self.country, &self.name);
        let ok = match op {
            Op::Publish { days, bps } => {
                let from = self.now() + days * DAY;
                let r = self.reg.try_publish(&self.country, &self.name, &from, bps);
                // G2: accepted exactly when far enough and in range.
                let should = from >= self.now() + REGISTRY_NOTICE && *bps <= 10_000;
                assert_eq!(r.is_ok(), should, "publish {days} days, {bps} bps");
                r.is_ok()
            }
            Op::Withdraw { days } => {
                let from = self.now() + days * DAY;
                self.reg
                    .try_withdraw(&self.country, &self.name, &from)
                    .is_ok()
            }
            Op::WithdrawNth(i) => {
                let s = self.reg.schedule(&self.country, &self.name);
                if s.is_empty() {
                    false
                } else {
                    let x = s.get(*i as u32 % s.len()).unwrap();
                    let r = self.reg.try_withdraw(&self.country, &self.name, &x.from);
                    // Only what has not started may be withdrawn.
                    if x.from <= self.now() {
                        assert!(r.is_err(), "withdrew an entry in force");
                    }
                    r.is_ok()
                }
            }
            Op::Days(d) => {
                let t = self.now() + d * DAY;
                e.ledger().set_timestamp(t);
                true
            }
        };
        if !ok {
            assert_eq!(
                self.reg.schedule(&self.country, &self.name),
                schedule_before
            );
        }
        self.observe();
        self.check();
    }

    /// G1, G3, G4.
    pub fn check(&self) {
        for (t, r) in &self.seen {
            assert_eq!(
                self.reg.rate_at(&self.country, &self.name, t),
                Some(*r),
                "the rate in force at {t} changed"
            );
        }
        let s = self.reg.schedule(&self.country, &self.name);
        for i in 1..s.len() {
            assert!(s.get(i - 1).unwrap().from < s.get(i).unwrap().from);
        }
        assert!(s.iter().all(|x| x.bps <= 10_000));
        // G4: the vault's VAT at this moment.
        let rate = self.reg.rate(&self.country, &self.name).unwrap();
        let vat = if rate <= CEILING { rate } else { 2_100 };
        let gross = 1_000_000 * UNIT;
        let expected = kyros_types::split(
            &self.w.e,
            &Rule {
                vat_bps: vat,
                buckets: spain(&self.w.e).buckets,
            },
            gross,
        )
        .unwrap();
        assert_eq!(self.w.v.quote(&gross), expected, "vault VAT at rate {rate}");
    }
}

impl Default for Run {
    fn default() -> Self {
        Run::new()
    }
}
