//! Checked arithmetic on amounts.
//!
//! Every amount is an `i128` in the token's smallest unit. The contracts never
//! rely on `overflow-checks` for money: each operation that could leave the
//! i128 range is checked and fails with a contract error code a client can
//! read (`MathOverflow`, `DivisionByZero`), never with a host trap.
//!
//! Products are taken in 256 bits before dividing (`mul_div_floor`), so a
//! ratio of two amounts is exact whenever the result itself fits in i128.
use crate::*;

/// Why an operation on amounts could not complete. Each contract maps it to
/// its own error codes.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MathError {
    /// The result does not fit in an i128.
    Overflow,
    /// A divisor that is zero or negative.
    DivisionByZero,
}

/// `floor(a * b / d)`, with the product taken in 256 bits.
///
/// Rounds toward negative infinity. `d` must be positive. Exact whenever the
/// result fits in an i128, however large `a * b` is.
pub fn mul_div_floor(e: &Env, a: i128, b: i128, d: i128) -> Result<i128, MathError> {
    if d <= 0 {
        return Err(MathError::DivisionByZero);
    }
    if let Some(p) = a.checked_mul(b) {
        return Ok(p.div_euclid(d));
    }
    let p = I256::from_i128(e, a).mul(&I256::from_i128(e, b));
    floor_div(e, &p, d)
}

/// `floor(a * b * c / d)`, with the product taken in 256 bits: for a price
/// times a scale, where rounding twice would lose precision. `d` must be
/// positive; a product beyond 256 bits is `Overflow`.
pub fn mul3_div_floor(e: &Env, a: i128, b: i128, c: i128, d: i128) -> Result<i128, MathError> {
    if d <= 0 {
        return Err(MathError::DivisionByZero);
    }
    if let Some(p) = a.checked_mul(b).and_then(|x| x.checked_mul(c)) {
        return Ok(p.div_euclid(d));
    }
    let p = I256::from_i128(e, a)
        .checked_mul(&I256::from_i128(e, b))
        .and_then(|x| x.checked_mul(&I256::from_i128(e, c)))
        .ok_or(MathError::Overflow)?;
    floor_div(e, &p, d)
}

/// `floor(p / d)` for a 256-bit `p` and a positive `d`.
fn floor_div(e: &Env, p: &I256, d: i128) -> Result<i128, MathError> {
    let d = I256::from_i128(e, d);
    // `div` truncates toward zero; taking the remainder off first makes the
    // division exact, so the quotient is the floor (d > 0).
    let r = p.rem_euclid(&d);
    p.sub(&r).div(&d).to_i128().ok_or(MathError::Overflow)
}

/// `ceil(a * b / d)`, with the product taken in 256 bits. `d` must be positive.
pub fn mul_div_ceil(e: &Env, a: i128, b: i128, d: i128) -> Result<i128, MathError> {
    let q = mul_div_floor(e, a, b, d)?;
    // a * b is a multiple of d exactly when q * d == a * b.
    let exact = match (q.checked_mul(d), a.checked_mul(b)) {
        (Some(x), Some(y)) => x == y,
        _ => {
            let x = I256::from_i128(e, q).mul(&I256::from_i128(e, d));
            x == I256::from_i128(e, a).mul(&I256::from_i128(e, b))
        }
    };
    if exact {
        Ok(q)
    } else {
        q.checked_add(1).ok_or(MathError::Overflow)
    }
}

/// `a + b`, or `Overflow`.
pub fn add(a: i128, b: i128) -> Result<i128, MathError> {
    a.checked_add(b).ok_or(MathError::Overflow)
}

/// `a - b`, or `Overflow`.
pub fn sub(a: i128, b: i128) -> Result<i128, MathError> {
    a.checked_sub(b).ok_or(MathError::Overflow)
}

/// `t + secs` for a point in time, or `Overflow`.
pub fn later(t: u64, secs: u64) -> Result<u64, MathError> {
    t.checked_add(secs).ok_or(MathError::Overflow)
}

/// `10^n`, or `Overflow` (n > 38).
pub fn pow10(n: u32) -> Result<i128, MathError> {
    10i128.checked_pow(n).ok_or(MathError::Overflow)
}
