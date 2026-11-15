//! The split: a rule's buckets and how a payment is divided between the
//! net amount and the reserve.
use crate::*;

/// One reserve bucket charged on the taxable base, e.g. the Spanish
/// income-tax prepayment (`irpf`, 2000 bps).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Bucket {
    /// The tax's short name (`irpf`, `ss`...); `vat` is reserved.
    pub name: Symbol,
    /// Share of the taxable base, in basis points.
    pub bps: u32,
}

/// How a gross payment is split. VAT is included in the gross amount; every
/// other bucket is a share of the taxable base (gross without VAT).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Rule {
    /// VAT included in the gross amount, in basis points (2100 = 21%).
    pub vat_bps: u32,
    /// Every other tax, each a share of the base.
    pub buckets: Vec<Bucket>,
}

/// The result of applying a rule to a gross amount. `parts[i]` belongs to
/// `rule.buckets[i]`; `reserve = vat + sum(parts) + fixed`; `net + reserve = gross`.
/// `fixed` is what a vault takes from the net amount for its fixed amounts
/// per period (e.g. a monthly social-security fee); the pure split leaves it 0.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Split {
    pub gross: i128,
    pub base: i128,
    pub vat: i128,
    pub parts: Vec<i128>,
    pub fixed: i128,
    pub reserve: i128,
    pub net: i128,
}

/// A fixed amount set aside each period in `bucket`, in `token`, before the
/// net amount goes out: the first payments of the period fill it (e.g. the
/// Spanish self-employed fee, 3 x the monthly fee per quarter).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Fixed {
    pub bucket: Symbol,
    pub token: Address,
    pub amount: i128,
}

/// Most fixed amounts a vault may have.
pub const MAX_FIXED: u32 = 4;

/// How the payments of one invoice are split, registered by the vault owner
/// when the invoice is issued and applied to every payment carrying its
/// reference.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InvoiceTerms {
    /// The VAT on the invoice (0 for exempt, reverse-charged or foreign).
    pub vat_bps: u32,
    /// Share of the base the client withholds and pays to the tax authority itself
    /// (e.g. Spanish IRPF on professional invoices), so it never reaches the vault.
    pub withholding_bps: u32,
    /// The reserve buckets for this invoice, on its base.
    pub buckets: Vec<Bucket>,
}

/// A token proposed for a vault to accept, waiting for its notice period.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingToken {
    pub token: Address,
    /// UNIX seconds from which the vault accepts it.
    pub ready_at: u64,
}

/// Why a rule is invalid.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RuleError {
    /// VAT above 100%.
    VatTooHigh,
    /// More than `MAX_BUCKETS` buckets.
    TooManyBuckets,
    /// The buckets together take more than the whole base.
    BucketsOverBase,
    /// Two buckets with the same name.
    DuplicateBucket,
    /// A bucket called `vat`.
    ReservedName,
}

/// `vat` is the bucket name VAT is booked under.
pub fn vat_symbol(e: &Env) -> Symbol {
    Symbol::new(e, "vat")
}

/// A rule is valid when VAT is at most 100%, there are at most `MAX_BUCKETS`
/// buckets with distinct names (none called `vat`), and the buckets together
/// take at most the whole base, so the net amount is never negative.
pub fn validate(e: &Env, rule: &Rule) -> Result<(), RuleError> {
    if rule.vat_bps as i128 > BPS {
        return Err(RuleError::VatTooHigh);
    }
    if rule.buckets.len() > MAX_BUCKETS {
        return Err(RuleError::TooManyBuckets);
    }
    let vat = vat_symbol(e);
    let mut total: i128 = 0;
    for (i, b) in rule.buckets.iter().enumerate() {
        if b.name == vat {
            return Err(RuleError::ReservedName);
        }
        for other in rule.buckets.iter().skip(i.saturating_add(1)) {
            if other.name == b.name {
                return Err(RuleError::DuplicateBucket);
            }
        }
        // At most MAX_BUCKETS u32s: saturation can never be reached.
        total = total.saturating_add(b.bps as i128);
    }
    if total > BPS {
        return Err(RuleError::BucketsOverBase);
    }
    Ok(())
}

/// Applies `rule` to `gross` (in the token's smallest unit, gross >= 0).
///
/// ```text
/// base   = floor(gross * 10000 / (10000 + vat_bps))
/// vat    = gross - base
/// part_i = floor(base * bps_i / 10000)
/// net    = gross - vat - sum(part_i)
/// ```
///
/// Rounding: VAT is what the base leaves, so it is never rounded down; each
/// other bucket is rounded down, by less than one unit. The reserve can be
/// short of the exact figure by less than one unit per bucket per payment
/// (10^-7 of a dollar for a Stellar asset), never more; it never takes more
/// than the rule says. `net + reserve = gross` exactly, always.
///
/// Every gross from 0 to `i128::MAX` splits: the products are taken in 256
/// bits, and every result is at most the gross.
pub fn split(e: &Env, rule: &Rule, gross: i128) -> Result<Split, MathError> {
    split_withheld(e, rule, 0, gross)
}

/// Like `split`, for an invoice from which the client withheld
/// `withholding_bps` of the base (e.g. Spanish IRPF, 1500) and paid it to the
/// tax authority itself, so the gross received is base + VAT - withholding:
///
/// ```text
/// base = floor(gross * 10000 / (10000 + vat_bps - withholding_bps))
/// vat  = floor(base * vat_bps / 10000)   (with withholding)
/// ```
/// With no withholding it is exactly `split`. The buckets and the
/// withholding together must not exceed the base (`validate_withholding`),
/// so the net amount is never negative. A withholding larger than the VAT
/// makes the base larger than the gross: for a gross near `i128::MAX` that
/// base does not fit, and the split fails with `Overflow`.
pub fn split_withheld(
    e: &Env,
    rule: &Rule,
    withholding_bps: u32,
    gross: i128,
) -> Result<Split, MathError> {
    if withholding_bps == 0 {
        return split_plain(e, rule, gross);
    }
    let den = sub(add(BPS, rule.vat_bps as i128)?, withholding_bps as i128)?;
    let base = mul_div_floor(e, gross, BPS, den)?;
    let vat = mul_div_floor(e, base, rule.vat_bps as i128, BPS)?;
    let mut parts = Vec::new(e);
    let mut reserve = vat;
    for b in rule.buckets.iter() {
        let p = mul_div_floor(e, base, b.bps as i128, BPS)?;
        parts.push_back(p);
        reserve = add(reserve, p)?;
    }
    Ok(Split {
        gross,
        base,
        vat,
        parts,
        fixed: 0,
        reserve,
        net: sub(gross, reserve)?,
    })
}

/// A withholding is valid when it and the rule's buckets take at most the
/// whole base, and the client still pays something (a 100% withholding with
/// no VAT would leave nothing to split).
pub fn validate_withholding(rule: &Rule, withholding_bps: u32) -> bool {
    // Sums of u32s in an i128: saturation can never be reached.
    let mut total = withholding_bps as i128;
    for b in rule.buckets.iter() {
        total = total.saturating_add(b.bps as i128);
    }
    total <= BPS && (withholding_bps as i128) < BPS.saturating_add(rule.vat_bps as i128)
}

/// `split` with no withholding. Cannot overflow for any gross >= 0: base <=
/// gross, each part <= base, and a valid rule's parts add up to <= base.
fn split_plain(e: &Env, rule: &Rule, gross: i128) -> Result<Split, MathError> {
    let base = mul_div_floor(e, gross, BPS, add(BPS, rule.vat_bps as i128)?)?;
    let vat = sub(gross, base)?;
    let mut parts = Vec::new(e);
    let mut reserve = vat;
    for b in rule.buckets.iter() {
        let p = mul_div_floor(e, base, b.bps as i128, BPS)?;
        parts.push_back(p);
        reserve = add(reserve, p)?;
    }
    Ok(Split {
        gross,
        base,
        vat,
        parts,
        fixed: 0,
        reserve,
        net: sub(gross, reserve)?,
    })
}
