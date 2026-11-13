//! Events: every change and every movement of money is published.
use crate::*;

// ---- Money in and out ----

#[contractevent(topics = ["kyros_vault", "received"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Received {
    #[topic]
    pub token: Address,
    #[topic]
    pub period: u32,
    pub from: Address,
    pub reference: BytesN<32>,
    pub gross: i128,
    pub net: i128,
    pub vat: i128,
    pub parts: Vec<i128>,
    /// Taken from the net amount for the period's fixed amounts.
    pub fixed: i128,
    pub reserve: i128,
}

#[contractevent(topics = ["kyros_vault", "deposited"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Deposited {
    #[topic]
    pub token: Address,
    #[topic]
    pub period: u32,
    pub from: Address,
    pub bucket: Symbol,
    pub amount: i128,
}

#[contractevent(topics = ["kyros_vault", "tax_paid"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TaxPaid {
    #[topic]
    pub token: Address,
    #[topic]
    pub period: u32,
    pub bucket: Symbol,
    pub amount: i128,
    pub destination: Address,
    /// The muxed id (anchor memo) the payment carried, if any.
    pub memo: Option<u64>,
}

#[contractevent(topics = ["kyros_vault", "released"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Released {
    #[topic]
    pub token: Address,
    #[topic]
    pub period: u32,
    pub amount: i128,
}

// ---- Changes with notice ----

#[contractevent(topics = ["kyros_vault", "rule_proposed"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuleProposed {
    pub rule: Rule,
    pub ready_at: u64,
}

#[contractevent(topics = ["kyros_vault", "rule_applied"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuleApplied {
    pub rule: Rule,
}

#[contractevent(topics = ["kyros_vault", "destination_proposed"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DestinationProposed {
    pub destination: Address,
    pub ready_at: u64,
}

#[contractevent(topics = ["kyros_vault", "destination_applied"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DestinationApplied {
    pub destination: Address,
}

#[contractevent(topics = ["kyros_vault", "payout_proposed"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PayoutProposed {
    pub payout: Address,
    pub ready_at: u64,
}

#[contractevent(topics = ["kyros_vault", "payout_applied"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PayoutApplied {
    pub payout: Address,
}

#[contractevent(topics = ["kyros_vault", "fixed_proposed"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FixedProposed {
    pub fixed: Vec<Fixed>,
    pub ready_at: u64,
}

#[contractevent(topics = ["kyros_vault", "fixed_applied"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FixedApplied {
    pub fixed: Vec<Fixed>,
}

#[contractevent(topics = ["kyros_vault", "token_proposed"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TokenProposed {
    pub token: Address,
    pub ready_at: u64,
}

#[contractevent(topics = ["kyros_vault", "token_added"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TokenAdded {
    pub token: Address,
}

#[contractevent(topics = ["kyros_vault", "change_cancelled"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ChangeCancelled {
    pub rule: bool,
    pub destination: bool,
    pub payout: bool,
    pub fixed: bool,
    pub token: bool,
}

#[contractevent(topics = ["kyros_vault", "vat_followed"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VatFollowed {
    pub registry: Address,
    pub country: Symbol,
    pub rate: Symbol,
    pub max_bps: u32,
}

#[contractevent(topics = ["kyros_vault", "vat_unfollowed"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VatUnfollowed {
    /// The VAT the vault keeps from now on (the registry's rate when it stopped following).
    pub vat_bps: u32,
}

// ---- How payments split ----

#[contractevent(topics = ["kyros_vault", "invoice_expected"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InvoiceExpected {
    #[topic]
    pub reference: BytesN<32>,
    pub terms: InvoiceTerms,
}

#[contractevent(topics = ["kyros_vault", "invoice_forgotten"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InvoiceForgotten {
    #[topic]
    pub reference: BytesN<32>,
}

#[contractevent(topics = ["kyros_vault", "payer_expected"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PayerExpected {
    #[topic]
    pub payer: Address,
    pub terms: InvoiceTerms,
}

#[contractevent(topics = ["kyros_vault", "payer_forgotten"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PayerForgotten {
    #[topic]
    pub payer: Address,
}

// ---- Due dates and scheduled payments ----

#[contractevent(topics = ["kyros_vault", "due_set"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DueSet {
    #[topic]
    pub bucket: Symbol,
    pub from_period: u32,
    pub to_period: u32,
    /// The due day as a day number (days since 1970-01-01).
    pub day: u32,
}

#[contractevent(topics = ["kyros_vault", "payment_scheduled"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PaymentScheduled {
    #[topic]
    pub id: u32,
    pub at: u64,
    pub payments: Vec<Payment>,
}

#[contractevent(topics = ["kyros_vault", "scheduled_run"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScheduledRun {
    #[topic]
    pub id: u32,
    pub paid: i128,
}

#[contractevent(topics = ["kyros_vault", "scheduled_cancelled"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScheduledCancelled {
    #[topic]
    pub id: u32,
}

// ---- Corrections ----

#[contractevent(topics = ["kyros_vault", "correction_proposed"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CorrectionProposed {
    #[topic]
    pub id: u32,
    pub correction: Correction,
}

#[contractevent(topics = ["kyros_vault", "correction_applied"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CorrectionApplied {
    #[topic]
    pub id: u32,
    pub amount: i128,
}

#[contractevent(topics = ["kyros_vault", "correction_cancelled"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CorrectionCancelled {
    #[topic]
    pub id: u32,
}

// ---- Conversion ----

#[contractevent(topics = ["kyros_vault", "conversion_proposed"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConversionProposed {
    pub conversion: Conversion,
    pub ready_at: u64,
}

#[contractevent(topics = ["kyros_vault", "converted"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Converted {
    #[topic]
    pub period: u32,
    pub from_token: Address,
    pub to_token: Address,
    pub amount_in: i128,
    pub amount_out: i128,
    /// The least the oracle price allowed.
    pub floor: i128,
}

#[contractevent(topics = ["kyros_vault", "conversion_stopped"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConversionStopped {}

// ---- Yield ----

#[contractevent(topics = ["kyros_vault", "strategy_proposed"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StrategyProposed {
    pub strategy: Strategy,
    pub ready_at: u64,
}

#[contractevent(topics = ["kyros_vault", "invested"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Invested {
    #[topic]
    pub token: Address,
    pub amount: i128,
}

/// Reserve brought back from the strategy because it is due soon.
#[contractevent(topics = ["kyros_vault", "divested"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Divested {
    #[topic]
    pub token: Address,
    pub amount: i128,
}

#[contractevent(topics = ["kyros_vault", "harvested"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Harvested {
    #[topic]
    pub token: Address,
    pub amount: i128,
}

/// The owner stopped the strategy, but it could not pay everything out now:
/// it takes nothing more, and `invest` brings the rest back.
#[contractevent(topics = ["kyros_vault", "strategy_stopping"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StrategyStopping {
    pub withdrawn: i128,
    /// Still in the strategy.
    pub left: i128,
}

#[contractevent(topics = ["kyros_vault", "strategy_stopped"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StrategyStopped {
    /// What came back from the strategy.
    pub withdrawn: i128,
}
