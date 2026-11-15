//! The vault under random sequences of everything that can happen to it.
//!
//! Invariants (docs/threat-model.md, "Invariants"):
//!
//! - I1 `held` is the sum of every bucket of every period.
//! - I2 Each period balances: reserved = buckets + paid + released + converted.
//! - I3 Solvent: the vault and its strategy hold at least `held`.
//! - I4 A refused call changes nothing.
//! - I5 The tax destination receives exactly what the books say was paid.
//! - I6 The owner receives exactly the net of each payment, plus what was
//!   released, corrected or harvested: nothing else leaves to anyone.
//! - I7 Nothing is released before its bucket's due date.
//! - I8 After `invest`, the strategy holds no more than its share of the
//!   reserve not due soon (unless it cannot pay out).
use crate::*;
use arbitrary::{Arbitrary, Unstructured};
use soroban_sdk::{testutils::Address as _, token, Address, Symbol};
use std::vec::Vec;

/// One thing that can happen to a vault.
#[derive(Clone, Debug)]
pub enum Op {
    Pay(i128),
    Deposit {
        vat: bool,
        amount: i128,
    },
    PayTax {
        period: usize,
        vat: bool,
        amount: i128,
    },
    Release {
        period: usize,
    },
    Correct {
        period: usize,
        amount: i128,
    },
    ApplyCorrections,
    Donate(i128),
    Earn(i128),
    Invest,
    Harvest,
    Lend(bool),
    Days(u64),
}

impl<'a> Arbitrary<'a> for Op {
    fn arbitrary(u: &mut Unstructured<'a>) -> arbitrary::Result<Self> {
        let period = |u: &mut Unstructured<'a>| u.int_in_range(0usize..=3);
        Ok(match u.int_in_range(0u8..=18)? {
            0..=3 => Op::Pay(amount(u)?),
            4 => Op::Deposit {
                vat: u.arbitrary()?,
                amount: amount(u)?,
            },
            5 | 6 => Op::PayTax {
                period: period(u)?,
                vat: u.arbitrary()?,
                amount: amount(u)?,
            },
            7 | 8 => Op::Release { period: period(u)? },
            9 => Op::Correct {
                period: period(u)?,
                amount: amount(u)?,
            },
            10 => Op::ApplyCorrections,
            11 => Op::Donate(u.int_in_range(1..=500 * UNIT)?),
            12 => Op::Earn(u.int_in_range(1..=50 * UNIT)?),
            13 | 14 => Op::Invest,
            15 => Op::Harvest,
            16 => Op::Lend(u.arbitrary()?),
            _ => Op::Days(u.int_in_range(0..=45)?),
        })
    }
}

/// An amount from the interesting ones: dust, ordinary, zero and negative.
pub fn amount(u: &mut Unstructured) -> arbitrary::Result<i128> {
    Ok(match u.int_in_range(0u8..=3)? {
        0 => u.int_in_range(1..=10)?,
        1 => u.int_in_range(1..=2_000 * UNIT)?,
        2 => 0,
        _ => -1,
    })
}

/// A vault with an honest yield strategy, a donor, and the books the
/// invariants are checked against.
pub struct Run {
    pub w: World,
    pub y: YieldClient<'static>,
    donor: Address,
    periods: Vec<u32>,
    lent_out: bool,
    /// What the owner (the payout address) should have received so far.
    owner_expected: i128,
}

impl Default for Run {
    fn default() -> Self {
        Self::new()
    }
}

impl Run {
    pub fn new() -> Run {
        let w = World::new();
        w.e.cost_estimate().budget().reset_unlimited();
        let y = YieldClient::new(
            &w.e,
            &w.e.register(Yield, (w.v.address.clone(), w.token.clone())),
        );
        w.v.propose_strategy(&y.address, &5_000);
        let donor = Address::generate(&w.e);
        w.mint(&donor, 1_000_000 * UNIT);
        let periods = std::vec![w.v.current_period()];
        Run {
            w,
            y,
            donor,
            periods,
            lent_out: false,
            owner_expected: 0,
        }
    }

    fn period(&self, i: usize) -> u32 {
        self.periods[i % self.periods.len()]
    }

    fn bucket(&self, vat: bool) -> Symbol {
        if vat {
            self.w.vat()
        } else {
            self.w.irpf()
        }
    }

    /// Everything a refused call must leave untouched.
    fn state(&self) -> std::vec::Vec<i128> {
        let w = &self.w;
        let mut s = std::vec![
            w.balance(&w.v.address),
            w.balance(&self.y.address),
            w.balance(&w.owner),
            w.balance(&w.tax),
            w.held(),
        ];
        for p in &self.periods {
            let b = w.v.period(p, &w.token);
            s.extend([b.reserved, b.paid, b.released, b.converted, b.deposited]);
            s.extend(b.buckets.values().iter());
        }
        s
    }

    /// Applies `op`, then checks every invariant (panics if one breaks).
    pub fn apply(&mut self, op: &Op) {
        let w = &self.w;
        let before = self.state();
        let ok = match op.clone() {
            Op::Pay(gross) => {
                w.mint(&w.payer, gross.max(0));
                let r = w.v.try_receive(&w.payer, &w.token, &gross, &w.reference(1));
                if let Ok(Ok(s)) = &r {
                    assert_eq!(s.net + s.reserve, gross);
                    self.owner_expected += s.net;
                }
                r.is_ok()
            }
            Op::Deposit { vat, amount } => {
                w.mint(&w.payer, amount.max(0));
                let q = w.v.current_period();
                w.v.try_deposit(&w.payer, &w.token, &q, &self.bucket(vat), &amount)
                    .is_ok()
            }
            Op::PayTax {
                period,
                vat,
                amount,
            } => {
                w.v.try_pay_tax(&self.period(period), &w.token, &self.bucket(vat), &amount)
                    .is_ok()
            }
            Op::Release { period } => {
                let p = self.period(period);
                let books = w.v.period(&p, &w.token).buckets;
                let r = w.v.try_release(&p, &w.token);
                if let Ok(Ok(out)) = r {
                    self.owner_expected += out;
                    // I7: every bucket that went out was due.
                    let after = w.v.period(&p, &w.token).buckets;
                    for (k, v) in books.iter() {
                        if v > 0 && after.get(k.clone()).unwrap_or(0) == 0 {
                            assert!(
                                w.e.ledger().timestamp() >= w.v.bucket_due_date(&p, &k),
                                "released before the due date"
                            );
                        }
                    }
                }
                r.is_ok()
            }
            Op::Correct { period, amount } => {
                w.v.try_propose_correction(&self.period(period), &w.token, &w.irpf(), &amount)
                    .is_ok()
            }
            Op::ApplyCorrections => {
                let mut any = false;
                for id in w.v.correction_ids().iter() {
                    if let Ok(Ok(out)) = w.v.try_apply_correction(&id) {
                        self.owner_expected += out;
                        any = true;
                    }
                }
                any
            }
            Op::Donate(a) => {
                token::Client::new(&w.e, &w.token).transfer(&self.donor, &w.v.address, &a);
                true
            }
            Op::Earn(a) => {
                w.mint(&self.y.address, a);
                true
            }
            Op::Invest => {
                let r = w.v.try_invest();
                if let Ok(Ok(_)) = r {
                    self.check_share();
                }
                r.is_ok()
            }
            Op::Harvest => {
                let r = w.v.try_harvest(&w.token);
                if let Ok(Ok(out)) = r {
                    self.owner_expected += out;
                }
                r.is_ok()
            }
            Op::Lend(on) => {
                self.y.set_lent_out(&on);
                self.lent_out = on;
                true
            }
            Op::Days(d) => {
                w.at(w.e.ledger().timestamp() + d * DAY);
                let q = w.v.current_period();
                if !self.periods.contains(&q) {
                    self.periods.push(q);
                }
                true
            }
        };
        // I4: a refused call leaves everything as it was.
        if !ok {
            assert_eq!(self.state(), before, "a refused {op:?} changed the state");
        }
        self.check();
    }

    /// I8: the strategy's share, right after a successful `invest`.
    fn check_share(&self) {
        let w = &self.w;
        let held = w.held();
        let liquid = w.balance(&w.v.address);
        let soon = w.v.due_soon(&w.token);
        let target = (held - soon) * 5_000 / 10_000;
        let at_risk = (held - liquid).max(0);
        // Above the share only while the strategy cannot pay out, or while
        // it is still bringing back reserve that is due soon.
        assert!(
            at_risk <= target || liquid < soon || self.lent_out,
            "strategy above its share: at risk {at_risk}, target {target}"
        );
    }

    /// I1, I2, I3, I5, I6.
    pub fn check(&self) {
        let w = &self.w;
        let mut buckets = 0i128;
        let mut paid = 0i128;
        for p in &self.periods {
            let b = w.v.period(p, &w.token);
            let in_buckets: i128 = b.buckets.values().iter().sum();
            // I2
            assert_eq!(
                b.reserved,
                in_buckets + b.paid + b.released + b.converted,
                "period {p} does not balance"
            );
            assert!(b.buckets.values().iter().all(|v| v >= 0));
            buckets += in_buckets;
            paid += b.paid;
        }
        // I1
        assert_eq!(w.held(), buckets);
        // I3
        assert!(w.balance(&w.v.address) + w.balance(&self.y.address) >= w.held());
        // I5
        assert_eq!(w.balance(&w.tax), paid);
        // I6
        assert_eq!(w.balance(&w.owner), self.owner_expected);
    }
}
