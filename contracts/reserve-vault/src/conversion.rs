//! Reserve in the tax's currency (opt-in): swaps through the owner's swapper,
//! never below the oracle price minus a tolerance.
use crate::*;

/// The conversion in force now (a pending one counts once its notice has passed).
pub(crate) fn active_conversion(e: &Env) -> Option<Conversion> {
    let pending: Option<PendingConversion> = e.storage().instance().get(&Key::PendingConversion);
    if let Some(p) = pending {
        if now(e) >= p.ready_at {
            return Some(p.conversion);
        }
    }
    e.storage().instance().get(&Key::Conversion)
}

/// The oracle's price for `a`: positive and at most `max_age` seconds old.
pub(crate) fn price(
    e: &Env,
    o: &OracleClient,
    a: &Asset,
    max_age: u64,
) -> Result<i128, VaultError> {
    let p = o.lastprice(a).ok_or(VaultError::PriceUnavailable)?;
    if p.price <= 0 || now(e).saturating_sub(p.timestamp) > max_age {
        return Err(VaultError::PriceUnavailable);
    }
    Ok(p.price)
}

/// The least a swap of `amount` must return: the oracle price minus the tolerance.
pub(crate) fn floor_out(e: &Env, c: &Conversion, amount: i128) -> Result<i128, VaultError> {
    let o = OracleClient::new(e, &c.oracle);
    let pf = price(e, &o, &c.from_price, c.max_age_secs)?;
    let pt = price(e, &o, &c.to_price, c.max_age_secs)?;
    let df = token::Client::new(e, &c.from_token).decimals();
    let dt = token::Client::new(e, &c.to_token).decimals();
    // One division at the end: scaling a rounded quotient up would round
    // the floor down by up to 10^(dt - df) units.
    let (num, den) = if dt >= df {
        (amount * pf * 10i128.pow(dt - df), pt)
    } else {
        (amount * pf, pt * 10i128.pow(df - dt))
    };
    Ok(num * (BPS - c.max_slippage_bps as i128) / (den * BPS))
}

#[contractimpl]
impl ReserveVault {
    /// The conversion in force now, if any.
    pub fn conversion(e: Env) -> Option<Conversion> {
        active_conversion(&e)
    }

    /// A proposed conversion and when it takes effect.
    pub fn pending_conversion(e: Env) -> Option<PendingConversion> {
        e.storage().instance().get(&Key::PendingConversion)
    }

    /// Proposes how to convert reserve from one token into another; it
    /// applies after `notice_secs`, because the swapper and the oracle decide
    /// what the reserve is exchanged for.
    pub fn propose_conversion(e: Env, conversion: Conversion) -> Result<u64, VaultError> {
        let c = active(&e);
        c.owner.require_auth();
        if !c.tokens.contains(&conversion.from_token)
            || !c.tokens.contains(&conversion.to_token)
            || conversion.from_token == conversion.to_token
            || conversion.max_slippage_bps > MAX_SLIPPAGE_BPS
            || conversion.max_age_secs == 0
            || conversion.max_age_secs > MAX_PRICE_AGE_SECS
        {
            return Err(VaultError::InvalidConversion);
        }
        Self::fold_extras(&e);
        let ready_at = now(&e) + c.notice_secs;
        e.storage().instance().set(
            &Key::PendingConversion,
            &PendingConversion {
                conversion: conversion.clone(),
                ready_at,
            },
        );
        bump_instance(&e);
        ConversionProposed {
            conversion,
            ready_at,
        }
        .publish(&e);
        Ok(ready_at)
    }

    /// Stops converting, at once (a pending conversion is dropped too).
    pub fn stop_conversion(e: Env) -> Result<(), VaultError> {
        stored_config(&e).owner.require_auth();
        let had =
            active_conversion(&e).is_some() || e.storage().instance().has(&Key::PendingConversion);
        if !had {
            return Err(VaultError::NoConversion);
        }
        e.storage().instance().remove(&Key::Conversion);
        e.storage().instance().remove(&Key::PendingConversion);
        ConversionStopped {}.publish(&e);
        Ok(())
    }

    /// Swaps everything `period` holds in the conversion's `from_token` into
    /// its `to_token`, bucket by bucket. Anyone can call it (a keeper does,
    /// right after each payment); the swap must return at least the oracle
    /// price minus the owner's tolerance. Returns the amount received.
    pub fn convert(e: Env, period: u32) -> Result<i128, VaultError> {
        let c = active_conversion(&e).ok_or(VaultError::NoConversion)?;
        Self::fold_extras(&e);
        let me = e.current_contract_address();
        let mut from = load_period(&e, period, &c.from_token);
        let mut total: i128 = 0;
        for (_, v) in from.buckets.iter() {
            total += v;
        }
        if total <= 0 {
            return Err(VaultError::NothingToConvert);
        }
        let floor = floor_out(&e, &c, total)?;
        ensure_liquid(&e, &c.from_token, total)?;
        let out_token = token::Client::new(&e, &c.to_token);
        let before = out_token.balance(&me);
        token::Client::new(&e, &c.from_token).transfer(&me, &c.swapper, &total);
        SwapClient::new(&e, &c.swapper).swap(&c.from_token, &c.to_token, &total, &floor, &me);
        let out = out_token.balance(&me) - before;
        if out < floor {
            return Err(VaultError::SwapBelowFloor);
        }
        // Each bucket keeps its share: what it held over the total, of what came out.
        let mut to = load_period(&e, period, &c.to_token);
        let n = from.buckets.len();
        let mut given: i128 = 0;
        let mut emptied = Map::new(&e);
        for (i, (k, v)) in from.buckets.iter().enumerate() {
            let share = if i as u32 + 1 == n {
                out - given
            } else {
                out * v / total
            };
            given += share;
            to.buckets
                .set(k.clone(), to.buckets.get(k.clone()).unwrap_or(0) + share);
            emptied.set(k, 0i128);
        }
        from.buckets = emptied;
        from.converted += total;
        to.reserved += out;
        save_period(&e, period, &c.from_token, &from);
        save_period(&e, period, &c.to_token, &to);
        add_held(&e, &c.from_token, -total);
        add_held(&e, &c.to_token, out);
        bump_instance(&e);
        Converted {
            period,
            from_token: c.from_token,
            to_token: c.to_token,
            amount_in: total,
            amount_out: out,
            floor,
        }
        .publish(&e);
        Ok(out)
    }
}
