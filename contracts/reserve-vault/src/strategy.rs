//! Yield (opt-in): a strategy the owner chose with notice, kept clear of reserve that is due soon.
use crate::*;

/// The strategy in force now (a pending one counts once its notice has passed).
pub(crate) fn active_strategy(e: &Env) -> Option<Strategy> {
    let pending: Option<PendingStrategy> = e.storage().instance().get(&Key::PendingStrategy);
    if let Some(p) = pending {
        if now(e) >= p.ready_at {
            return Some(p.strategy);
        }
    }
    e.storage().instance().get(&Key::Strategy)
}

pub(crate) fn invested(e: &Env, token: &Address) -> i128 {
    match active_strategy(e) {
        Some(s) if s.token == *token => YieldClient::new(e, &s.adapter).balance(),
        _ => 0,
    }
}

/// Makes sure the vault itself holds `amount` of `token`, withdrawing the
/// difference from the strategy if needed.
pub(crate) fn ensure_liquid(e: &Env, token: &Address, amount: i128) -> Result<(), VaultError> {
    let me = e.current_contract_address();
    let t = token::Client::new(e, token);
    let liquid = t.balance(&me);
    if liquid >= amount {
        return Ok(());
    }
    if let Some(s) = active_strategy(e) {
        if s.token == *token {
            // A strategy that cannot pay out now (e.g. a fully lent pool) leaves the payment waiting.
            let _ = YieldClient::new(e, &s.adapter).try_withdraw(&(amount - liquid));
            if t.balance(&me) >= amount {
                return Ok(());
            }
        }
    }
    Err(VaultError::Illiquid)
}

/// The reserve in `token` whose bucket is due within `INVEST_HORIZON_SECS`
/// (or already past due). For each bucket it takes the earlier of the rule's
/// date (before any holiday moves it) and the earliest date set by hand for
/// that period: never later than the real one.
pub(crate) fn due_soon(e: &Env, c: &Config, token: &Address) -> i128 {
    let total = held(e, token);
    let (soon, tracked) = scan_open(e, c, token);
    let store = e.storage().persistent();
    // Some period with reserve went untracked (more than `MAX_OPEN` at once):
    // all of it counts as due until the tracked periods account for it all.
    if tracked < total && store.get(&Key::OpenFull(token.clone())).unwrap_or(false) {
        return total;
    }
    soon.min(total)
}

/// Over the tracked open periods of `token`: the reserve due within
/// `INVEST_HORIZON_SECS`, and all the reserve they hold.
pub(crate) fn scan_open(e: &Env, c: &Config, token: &Address) -> (i128, i128) {
    let store = e.storage().persistent();
    let ids: Vec<u32> = store.get(&Key::Open(token.clone())).unwrap_or(Vec::new(e));
    let limit = now(e) + INVEST_HORIZON_SECS;
    let (mut soon, mut tracked) = (0, 0);
    for id in ids.iter() {
        // Two reads per period (its buckets and the earliest date set by
        // hand), not one per bucket: 36 periods of 8 buckets stay far from
        // the network's limit of entries per transaction.
        let set: Option<u64> = store.get(&Key::EarliestSet(id));
        for (bucket, amount) in load_period(e, id, token).buckets.iter() {
            if amount <= 0 {
                continue;
            }
            tracked += amount;
            let rule = due_at(&c.period, id, &bucket_due(&c.dues, &bucket));
            if set.map_or(rule, |x| x.min(rule)) <= limit {
                soon += amount;
            }
        }
    }
    (soon, tracked)
}

/// Clears `OpenFull` once the tracked periods hold all of `token`'s reserve
/// (the untracked ones were paid or released): `invest` works normally again.
pub(crate) fn settle_open_full(e: &Env, c: &Config, token: &Address) {
    let k = Key::OpenFull(token.clone());
    if e.storage().persistent().has(&k) && scan_open(e, c, token).1 >= held(e, token) {
        e.storage().persistent().remove(&k);
    }
}

/// Removes the strategy (and any pending one) once all it held is back.
pub(crate) fn drop_strategy(e: &Env, withdrawn: i128) {
    e.storage().instance().remove(&Key::Strategy);
    e.storage().instance().remove(&Key::PendingStrategy);
    e.storage().instance().remove(&Key::Stopping);
    StrategyStopped { withdrawn }.publish(e);
}

#[contractimpl]
impl ReserveVault {
    /// The strategy in force now, if any.
    pub fn strategy(e: Env) -> Option<Strategy> {
        active_strategy(&e)
    }

    /// A proposed strategy and when it takes effect.
    pub fn pending_strategy(e: Env) -> Option<PendingStrategy> {
        e.storage().instance().get(&Key::PendingStrategy)
    }

    /// Where the reserve in `token` is and what it has earned.
    pub fn position(e: Env, token: Address) -> Position {
        let held = held(&e, &token);
        let liquid = token::Client::new(&e, &token).balance(&e.current_contract_address());
        let invested = invested(&e, &token);
        Position {
            held,
            liquid,
            invested,
            surplus: liquid + invested - held,
        }
    }

    /// Proposes a yield strategy that may hold up to `max_bps` of the reserve
    /// in its token; it applies after `notice_secs`. The strategy must work
    /// for this vault only. One strategy at a time: stop the current one first.
    pub fn propose_strategy(e: Env, adapter: Address, max_bps: u32) -> Result<u64, VaultError> {
        let c = active(&e);
        c.owner.require_auth();
        if active_strategy(&e).is_some() {
            return Err(VaultError::StrategyInUse);
        }
        let y = YieldClient::new(&e, &adapter);
        let token = y.asset();
        if y.owner() != e.current_contract_address()
            || !c.tokens.contains(&token)
            || max_bps as i128 > BPS
        {
            return Err(VaultError::InvalidStrategy);
        }
        let ready_at = now(&e) + c.notice_secs;
        let strategy = Strategy {
            adapter,
            token,
            max_bps,
        };
        e.storage().instance().set(
            &Key::PendingStrategy,
            &PendingStrategy {
                strategy: strategy.clone(),
                ready_at,
            },
        );
        bump_instance(&e);
        StrategyProposed { strategy, ready_at }.publish(&e);
        Ok(ready_at)
    }

    /// Stops the strategy at once and brings everything it holds back to the
    /// vault (a pending strategy is dropped too). Returns what came back.
    pub fn stop_strategy(e: Env) -> Result<i128, VaultError> {
        stored_config(&e).owner.require_auth();
        let s = active_strategy(&e);
        let pending = e.storage().instance().has(&Key::PendingStrategy);
        if s.is_none() && !pending {
            return Err(VaultError::NoStrategy);
        }
        let mut withdrawn = 0;
        if let Some(s) = s {
            let me = e.current_contract_address();
            let t = token::Client::new(&e, &s.token);
            let y = YieldClient::new(&e, &s.adapter);
            let all = y.balance();
            if all > 0 {
                let before = t.balance(&me);
                let ok = matches!(y.try_withdraw(&all), Ok(Ok(_)));
                withdrawn = t.balance(&me) - before;
                if !ok {
                    // A fully lent pool or a stale price: removing the strategy
                    // now would strand what it holds. It takes nothing more,
                    // and `invest` brings the rest back, then removes it.
                    e.storage().instance().set(&Key::Strategy, &s);
                    e.storage().instance().remove(&Key::PendingStrategy);
                    e.storage().instance().set(&Key::Stopping, &true);
                    bump_instance(&e);
                    StrategyStopping {
                        withdrawn,
                        left: y.balance(),
                    }
                    .publish(&e);
                    return Ok(withdrawn);
                }
            }
        }
        drop_strategy(&e, withdrawn);
        Ok(withdrawn)
    }

    /// Whether a stopped strategy is still bringing its reserve back.
    pub fn stopping(e: Env) -> bool {
        e.storage().instance().get(&Key::Stopping).unwrap_or(false)
    }

    /// Keeps the strategy at its share of the reserve that is not due soon.
    /// Reserve due within `INVEST_HORIZON_SECS` (or past due) stays liquid:
    /// if the vault holds less than that, it is brought back from the
    /// strategy (as much as the strategy can pay out now). Otherwise the
    /// reserve the vault does not hold itself is kept at `max_bps` of what is
    /// not due soon: liquid reserve goes in up to it, and the excess comes back.
    /// Anyone can call it (a keeper does, daily). Returns the amount moved:
    /// positive into the strategy, negative back to the vault.
    pub fn invest(e: Env) -> Result<i128, VaultError> {
        let s = active_strategy(&e).ok_or(VaultError::NoStrategy)?;
        Self::fold_extras(&e);
        let c = active(&e);
        let me = e.current_contract_address();
        let t = token::Client::new(&e, &s.token);
        let y = YieldClient::new(&e, &s.adapter);
        let liquid = t.balance(&me);
        if Self::stopping(e.clone()) {
            // Stopped by the owner: everything comes back, then it is removed.
            let rest = y.balance();
            // Payments may already have taken it all (`ensure_liquid`).
            let ok = rest <= 0 || matches!(y.try_withdraw(&rest), Ok(Ok(_)));
            let back = t.balance(&me) - liquid;
            if ok {
                drop_strategy(&e, back);
            }
            bump_instance(&e);
            return Ok(-back);
        }
        settle_open_full(&e, &c, &s.token);
        let soon = due_soon(&e, &c, &s.token);
        if liquid < soon {
            // A strategy that cannot pay out now is asked again on the next call.
            let _ = y.try_withdraw(&(soon - liquid));
            let back = t.balance(&me) - liquid;
            bump_instance(&e);
            if back > 0 {
                Divested {
                    token: s.token,
                    amount: back,
                }
                .publish(&e);
            }
            return Ok(-back);
        }
        let held = held(&e, &s.token);
        let target = (held - soon) * s.max_bps as i128 / BPS;
        // The reserve that depends on the strategy is what the vault does not
        // hold itself (what the strategy earned is the owner's, and a loss
        // still counts). Payments from the vault raise it: past `max_bps`, the
        // excess comes back.
        let at_risk = (held - liquid).max(0);
        if at_risk > target {
            let excess = (at_risk - target).min(y.balance());
            if excess <= 0 {
                return Ok(0);
            }
            let _ = y.try_withdraw(&excess);
            let back = t.balance(&me) - liquid;
            bump_instance(&e);
            if back > 0 {
                Divested {
                    token: s.token,
                    amount: back,
                }
                .publish(&e);
            }
            return Ok(-back);
        }
        let amount = (target - at_risk).min(liquid - soon);
        if amount <= 0 {
            return Ok(0);
        }
        t.transfer(&me, &s.adapter, &amount);
        y.deposit(&amount);
        bump_instance(&e);
        Invested {
            token: s.token,
            amount,
        }
        .publish(&e);
        Ok(amount)
    }

    /// The reserve in `token` due within `INVEST_HORIZON_SECS` (or past due),
    /// which `invest` keeps in the vault.
    pub fn due_soon(e: Env, token: Address) -> i128 {
        due_soon(&e, &active(&e), &token)
    }

    /// Sends the owner what the reserve in `token` has earned (liquid plus
    /// invested, minus what the buckets hold). The earnings come out of the
    /// strategy, where they were made: the reserve the vault holds itself
    /// never pays them. Returns the amount sent.
    pub fn harvest(e: Env, token: Address) -> Result<i128, VaultError> {
        let c = active(&e);
        c.owner.require_auth();
        let me = e.current_contract_address();
        let t = token::Client::new(&e, &token);
        let held = held(&e, &token);
        let liquid = t.balance(&me);
        let surplus = liquid + invested(&e, &token) - held;
        if surplus <= 0 {
            return Ok(0);
        }
        if let Some(s) = active_strategy(&e).filter(|s| s.token == token) {
            // A strategy that cannot pay out now leaves its earnings for later.
            let _ = YieldClient::new(&e, &s.adapter).try_withdraw(&surplus);
        }
        // The reserve the vault held itself before stays in it.
        let amount = surplus.min(t.balance(&me) - liquid.min(held));
        if amount <= 0 {
            return Ok(0);
        }
        t.transfer(&me, &c.payout, &amount);
        Harvested { token, amount }.publish(&e);
        Ok(amount)
    }
}
