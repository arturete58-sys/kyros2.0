//! Checked arithmetic for amounts and times.
//!
//! Every operation on an amount that could leave the `i128` range goes
//! through these helpers and fails with the vault's own codes
//! (`MathOverflow` = 40, `DivisionByZero` = 41), so a client reads why a call
//! was refused instead of a host trap. Ratios are taken in 256 bits
//! (`kyros_types::mul_div_floor`) and rounded down; each caller says which
//! side the rounding favours.
//!
//! The calendar's date arithmetic (`kyros_types`, `calendar.rs`) is not
//! routed through here: its inputs are bounded by validation (periods up to
//! ten years, due dates up to four, ledger times before the year 9999), and
//! the release profile's `overflow-checks` still guards it.
use crate::*;

impl From<MathError> for VaultError {
    fn from(m: MathError) -> Self {
        match m {
            MathError::Overflow => VaultError::MathOverflow,
            MathError::DivisionByZero => VaultError::DivisionByZero,
        }
    }
}

/// `a + b`.
pub(crate) fn add(a: i128, b: i128) -> Result<i128, VaultError> {
    Ok(kyros_types::add(a, b)?)
}

/// `a - b`.
pub(crate) fn sub(a: i128, b: i128) -> Result<i128, VaultError> {
    Ok(kyros_types::sub(a, b)?)
}

/// `floor(a * b / d)`, exact in 256 bits.
pub(crate) fn mul_div(e: &Env, a: i128, b: i128, d: i128) -> Result<i128, VaultError> {
    Ok(mul_div_floor(e, a, b, d)?)
}

/// `-a`, for an amount going out.
pub(crate) fn neg(a: i128) -> Result<i128, VaultError> {
    a.checked_neg().ok_or(VaultError::MathOverflow)
}

/// `t + secs`, for a point in time.
pub(crate) fn later(t: u64, secs: u64) -> Result<u64, VaultError> {
    Ok(kyros_types::later(t, secs)?)
}

/// The next id of a counter, `id + 1`.
pub(crate) fn next_id(id: u32) -> Result<u32, VaultError> {
    id.checked_add(1).ok_or(VaultError::MathOverflow)
}

/// Adds `amount` to `key` in a map of amounts (a bucket missing is 0).
pub(crate) fn credit(
    m: &mut Map<Symbol, i128>,
    key: &Symbol,
    amount: i128,
) -> Result<(), VaultError> {
    let v = add(m.get(key.clone()).unwrap_or(0), amount)?;
    m.set(key.clone(), v);
    Ok(())
}

/// Sums a list of amounts.
pub(crate) fn sum<I: IntoIterator<Item = i128>>(it: I) -> Result<i128, VaultError> {
    it.into_iter().try_fold(0i128, add)
}
