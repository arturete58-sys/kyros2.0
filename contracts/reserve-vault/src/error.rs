//! The vault's errors.
use crate::*;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum VaultError {
    /// The rule is invalid (VAT over 100%, buckets over the base, duplicate or reserved names, too many buckets).
    InvalidRule = 1,
    InvalidAmount = 2,
    /// The vault does not accept this token.
    TokenNotAccepted = 3,
    /// The period's due date has not passed yet.
    NotDue = 4,
    NothingToRelease = 5,
    /// More than the bucket holds.
    ExceedsReserve = 6,
    NoPendingChange = 7,
    /// The notice period has not passed yet.
    ChangeNotReady = 8,
    UnknownBucket = 9,
    NoTokens = 10,
    /// The change has already taken effect.
    AlreadyInForce = 11,
    /// The vault is not following a rate registry.
    NotFollowing = 12,
    /// The registry's advance notice is shorter than the vault's.
    RegistryNoticeTooShort = 13,
    /// The registry does not list this rate.
    UnknownRate = 14,
    /// The registry's rate today differs from the vault's VAT, or is above the ceiling:
    /// align the rule first, so following changes nothing today.
    RateMismatch = 15,
    /// No reserve currency conversion is set.
    NoConversion = 16,
    /// The conversion is invalid (a token the vault does not accept, the same token twice, tolerance over 100%).
    InvalidConversion = 17,
    /// The oracle has no price, or its price is older than allowed.
    PriceUnavailable = 18,
    /// The swap returned less than the oracle price minus the owner's tolerance.
    SwapBelowFloor = 19,
    /// The period holds nothing in that token.
    NothingToConvert = 20,
    /// No yield strategy is set.
    NoStrategy = 21,
    /// The strategy does not work for this vault, holds a token the vault does not accept,
    /// or its share is over 100%.
    InvalidStrategy = 22,
    /// A strategy is already set: stop it first.
    StrategyInUse = 23,
    /// Not enough liquid reserve, even after withdrawing from the strategy.
    Illiquid = 24,
    /// A muxed destination whose account is not the tax destination.
    WrongDestination = 25,
    /// Invoice terms whose withholding and buckets together exceed the base.
    InvalidTerms = 26,
    /// No terms are registered for that invoice reference.
    UnknownInvoice = 27,
    /// A period kind that cannot be used (`Months(n)` with n not dividing 12).
    InvalidPeriod = 28,
    /// A due rule that cannot be used (a month or day out of range).
    InvalidDue = 29,
    /// An earlier due date must still be at least the notice period away.
    DueTooSoon = 30,
    UnknownPayment = 31,
    /// A scheduled payment's date has not come yet.
    NotYet = 32,
    /// Too many payments or periods in one call.
    TooMany = 33,
    UnknownPayer = 34,
    UnknownCorrection = 35,
    /// Fixed amounts that cannot be used (too many, not positive, the `vat`
    /// bucket, a token the vault does not accept, the same bucket twice).
    InvalidFixed = 36,
    /// A deposit into a period that has not started.
    FuturePeriod = 37,
    /// The vault already accepts that token.
    AlreadyAccepted = 38,
    /// A payout address that cannot hold one of the vault's tokens, or a tax
    /// destination that can hold none (a Stellar account without the
    /// trustline): every payment to it would fail.
    CannotHold = 39,
}
