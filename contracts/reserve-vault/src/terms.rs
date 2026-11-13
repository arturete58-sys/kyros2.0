//! How each payment splits: the rule, an invoice's terms or a payer's terms, and fixed amounts.
use crate::*;

/// Whether `who` can receive every token the vault takes. A Stellar account
/// needs a trustline for each classic asset, or the token's `balance` (and
/// every transfer to it) fails; a contract can always hold.
pub(crate) fn can_hold(e: &Env, c: &Config, who: &Address) -> bool {
    c.tokens.iter().all(|t| holds(e, &t, who))
}

/// Whether `who` can receive `t`: the token answers its `balance`.
pub(crate) fn holds(e: &Env, t: &Address, who: &Address) -> bool {
    token::Client::new(e, t).try_balance(who).is_ok()
}

/// The terms for a payment (an invoice's own terms first, then the terms
/// registered for its payer, else the rule) and the split they give.
pub(crate) fn split_for(
    e: &Env,
    rule: &Rule,
    from: &Address,
    reference: &BytesN<32>,
    gross: i128,
) -> (Rule, Split) {
    // An invoice's own terms first, then the terms registered for this payer.
    // Terms in use have their lifetime extended, so a payer's terms (e.g. the
    // inbox for clients abroad) are never archived while payments keep coming.
    let store = e.storage().persistent();
    let mut terms: Option<InvoiceTerms> = None;
    for k in [Key::Invoice(reference.clone()), Key::Payer(from.clone())] {
        if let Some(t) = store.get::<Key, InvoiceTerms>(&k) {
            store.extend_ttl(&k, TTL_THRESHOLD, PERIOD_TTL);
            terms = Some(t);
            break;
        }
    }
    match terms {
        Some(t) => {
            let r = Rule {
                vat_bps: t.vat_bps,
                buckets: t.buckets,
            };
            let s = split_withheld(e, &r, t.withholding_bps, gross);
            (r, s)
        }
        None => (rule.clone(), split(e, rule, gross)),
    }
}

/// What each fixed amount in `token` takes from `net`, in order, until the
/// period's amount is set aside: (bucket, amount) pairs with amount > 0.
pub(crate) fn fixed_takes(
    e: &Env,
    c: &Config,
    token: &Address,
    p: &PeriodState,
    net: i128,
) -> Vec<(Symbol, i128)> {
    let mut out = Vec::new(e);
    let mut left = net;
    for f in c.fixed.iter() {
        if left <= 0 {
            break;
        }
        if f.token != *token {
            continue;
        }
        let want = f.amount - p.fixed.get(f.bucket.clone()).unwrap_or(0);
        let take = want.min(left);
        if take > 0 {
            out.push_back((f.bucket, take));
            left -= take;
        }
    }
    out
}

/// At most `MAX_FIXED` amounts, each positive, in an accepted token, in its
/// own bucket (never `vat`).
pub(crate) fn check_fixed(e: &Env, c: &Config, fixed: &Vec<Fixed>) -> Result<(), VaultError> {
    if fixed.len() > MAX_FIXED {
        return Err(VaultError::InvalidFixed);
    }
    let vat = vat_symbol(e);
    for (i, f) in fixed.iter().enumerate() {
        if f.amount <= 0 || f.bucket == vat || !c.tokens.contains(&f.token) {
            return Err(VaultError::InvalidFixed);
        }
        for other in fixed.iter().skip(i + 1) {
            if other.bucket == f.bucket {
                return Err(VaultError::InvalidFixed);
            }
        }
    }
    Ok(())
}

/// A rule the shared validation accepts (see `kyros_types::validate`).
pub(crate) fn check_rule(e: &Env, rule: &Rule) -> Result<(), VaultError> {
    validate(e, rule).map_err(|_| VaultError::InvalidRule)
}

#[contractimpl]
impl ReserveVault {
    // ---- Invoices ----

    /// Registers how the payments of an invoice are split: `reference` is
    /// the hash the payer's payment carries (sha256 of the invoice number).
    /// Applies at once (it only changes how future payments of this invoice
    /// are booked, and the owner signs it); registering again replaces it.
    pub fn expect_invoice(
        e: Env,
        reference: BytesN<32>,
        terms: InvoiceTerms,
    ) -> Result<(), VaultError> {
        stored_config(&e).owner.require_auth();
        let rule = Rule {
            vat_bps: terms.vat_bps,
            buckets: terms.buckets.clone(),
        };
        check_rule(&e, &rule)?;
        if !validate_withholding(&rule, terms.withholding_bps) {
            return Err(VaultError::InvalidTerms);
        }
        let k = Key::Invoice(reference.clone());
        e.storage().persistent().set(&k, &terms);
        e.storage()
            .persistent()
            .extend_ttl(&k, TTL_THRESHOLD, PERIOD_TTL);
        InvoiceExpected { reference, terms }.publish(&e);
        Ok(())
    }

    /// The terms registered for an invoice, if any.
    pub fn invoice(e: Env, reference: BytesN<32>) -> Option<InvoiceTerms> {
        e.storage().persistent().get(&Key::Invoice(reference))
    }

    /// Removes an invoice's terms: later payments with its reference split by the rule.
    pub fn forget_invoice(e: Env, reference: BytesN<32>) -> Result<(), VaultError> {
        stored_config(&e).owner.require_auth();
        let k = Key::Invoice(reference.clone());
        if !e.storage().persistent().has(&k) {
            return Err(VaultError::UnknownInvoice);
        }
        e.storage().persistent().remove(&k);
        InvoiceForgotten { reference }.publish(&e);
        Ok(())
    }

    // ---- Clients with their own terms ----

    /// Registers terms for a payer address: its payments without invoice
    /// terms split by these (e.g. a client abroad, VAT 0). Applies at once:
    /// it only changes how future payments are booked, and the owner signs it.
    pub fn expect_payer(e: Env, payer: Address, terms: InvoiceTerms) -> Result<(), VaultError> {
        stored_config(&e).owner.require_auth();
        let rule = Rule {
            vat_bps: terms.vat_bps,
            buckets: terms.buckets.clone(),
        };
        check_rule(&e, &rule)?;
        if !validate_withholding(&rule, terms.withholding_bps) {
            return Err(VaultError::InvalidTerms);
        }
        let k = Key::Payer(payer.clone());
        e.storage().persistent().set(&k, &terms);
        e.storage()
            .persistent()
            .extend_ttl(&k, TTL_THRESHOLD, PERIOD_TTL);
        PayerExpected { payer, terms }.publish(&e);
        Ok(())
    }

    /// The terms registered for a payer address, if any.
    pub fn payer(e: Env, payer: Address) -> Option<InvoiceTerms> {
        e.storage().persistent().get(&Key::Payer(payer))
    }

    /// Removes a payer's terms: its later payments split by the rule.
    pub fn forget_payer(e: Env, payer: Address) -> Result<(), VaultError> {
        stored_config(&e).owner.require_auth();
        let k = Key::Payer(payer.clone());
        if !e.storage().persistent().has(&k) {
            return Err(VaultError::UnknownPayer);
        }
        e.storage().persistent().remove(&k);
        PayerForgotten { payer }.publish(&e);
        Ok(())
    }
}
