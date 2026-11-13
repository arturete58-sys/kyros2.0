//! Money out: tax payments to the destination, and releases after the due date.
use crate::*;

#[contractimpl]
impl ReserveVault {
    /// Sends `amount` from a period's bucket to the tax destination. Allowed at
    /// any time; this is the only way reserve leaves before the due date.
    pub fn pay_tax(
        e: Env,
        period: u32,
        token: Address,
        bucket: Symbol,
        amount: i128,
    ) -> Result<(), VaultError> {
        let c = active(&e);
        Self::pay(
            &e,
            &c,
            period,
            token,
            bucket,
            amount,
            MuxedAddress::from(&c.tax_destination),
        )
    }

    /// Like `pay_tax`, to the destination with a muxed id: `to` must be the
    /// tax destination's account with the anchor's memo as id, so the anchor
    /// can match the payment (SEP-6/SEP-24 withdrawals with an id memo).
    pub fn pay_tax_to(
        e: Env,
        period: u32,
        token: Address,
        bucket: Symbol,
        amount: i128,
        to: MuxedAddress,
    ) -> Result<(), VaultError> {
        let c = active(&e);
        if to.address() != c.tax_destination {
            return Err(VaultError::WrongDestination);
        }
        Self::pay(&e, &c, period, token, bucket, amount, to)
    }

    /// Returns to the owner what the period still holds in every bucket whose
    /// due date has passed; buckets not yet due stay locked.
    pub fn release(e: Env, period: u32, token: Address) -> Result<i128, VaultError> {
        let c = active(&e);
        c.owner.require_auth();
        let t = now(&e);
        let mut p = load_period(&e, period, &token);
        let mut total: i128 = 0;
        let mut held_back: i128 = 0;
        let mut after = Map::new(&e);
        for (k, v) in p.buckets.iter() {
            if v > 0 && t >= lock_at(&e, &c, period, &k) {
                total += v;
                after.set(k, 0i128);
            } else {
                held_back += v;
                after.set(k, v);
            }
        }
        if total <= 0 {
            return Err(if held_back > 0 {
                VaultError::NotDue
            } else {
                VaultError::NothingToRelease
            });
        }
        p.buckets = after;
        p.released += total;
        save_period(&e, period, &token, &p);
        add_held(&e, &token, -total);
        ensure_liquid(&e, &token, total)?;
        token::Client::new(&e, &token).transfer(&e.current_contract_address(), &c.payout, &total);
        Released {
            token,
            period,
            amount: total,
        }
        .publish(&e);
        Ok(total)
    }
}
