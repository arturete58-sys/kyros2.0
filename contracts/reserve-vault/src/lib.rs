//! Kyros Reserve Vault: one per user, owned by the user.
//!
//! Every payment that reaches the vault (through the Router or the user's
//! Inbox) is split by the owner's rule: the net amount goes straight to the
//! owner and the reserve stays here, booked to the current fiscal period in
//! one bucket per tax (`vat`, `irpf`, ...).
//!
//! What the contract enforces:
//! - **Lock.** A period's reserve cannot go back to the owner before the
//!   period's due date (`release`).
//! - **Destination.** Before that date reserve can only leave for the
//!   registered tax-payment destination (`pay_tax`), e.g. the owner's anchor
//!   account used to pay the tax in euros.
//! - **Notice.** A new rule or destination takes effect only after the
//!   notice period, and both the proposal and the change emit events.
//! - **VAT that follows the law (opt-in).** The owner can have the vault read
//!   its VAT rate from a Kyros Rate Registry, so a legal change applies on
//!   its date with no signature. The registry must give at least the vault's
//!   own notice, the owner sets a ceiling, and `unfollow` works at any time.
//! - **Reserve in the tax's currency (opt-in).** Reserve received in one token
//!   (USDC) can be swapped into another (EURC), so what is set aside is in
//!   the currency the tax is owed in. Anyone can trigger the swap (`convert`),
//!   but only through the swapper and price oracle the owner chose with
//!   notice, and never for less than the oracle price minus the owner's
//!   tolerance.
//! - **Yield (opt-in).** Part of the reserve can be lent through a yield
//!   strategy the owner chose with notice, one strategy instance per vault.
//!   The buckets keep their amounts; what the strategy earns on top is the
//!   owner's (`harvest`). Payments out withdraw from the strategy as needed.
//! - **Paying through an anchor.** `pay_tax_to` sends to the destination
//!   with a muxed id (the anchor's memo), so an anchor can match the payment
//!   and send euros to the owner's bank account.
//!
//! No admin and no upgrade path: Kyros never controls a vault. A new version
//! is a new contract the owner moves to by choice.
#![no_std]
use kyros_types::{
    period_end, period_of, split, split_withheld, validate, validate_withholding, vat_symbol,
    Asset, Bucket, OracleClient, PeriodKind, RegistryClient, Rule, Split, SwapClient, YieldClient,
    BPS,
};
use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, token, Address, BytesN,
    Env, Map, MuxedAddress, Symbol, Vec,
};

const DAY_IN_LEDGERS: u32 = 17_280;
/// Period entries live at least ~13 months after their last change.
const PERIOD_TTL: u32 = 400 * DAY_IN_LEDGERS;
const INSTANCE_TTL: u32 = 180 * DAY_IN_LEDGERS;

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
}

/// How the payments of one invoice are split, registered by the owner when
/// the invoice is issued and applied to every payment carrying its reference.
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

/// Where the vault reads its VAT rate while it follows a registry.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Feed {
    pub registry: Address,
    /// Country code, e.g. `ES`.
    pub country: Symbol,
    /// Rate name in that country, e.g. `standard`.
    pub rate: Symbol,
    /// Highest VAT the vault accepts from the registry; above it the vault keeps its own rule.
    pub max_bps: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Config {
    pub owner: Address,
    pub rule: Rule,
    pub tax_destination: Address,
    /// Seconds a proposed rule or destination waits before it can apply.
    pub notice_secs: u64,
    pub period: PeriodKind,
    /// Seconds after a period ends until its due date (from the rule pack).
    pub due_offset_secs: u64,
    /// SEP-41 tokens the vault accepts (an allow-list: USDC, EURC).
    pub tokens: Vec<Address>,
}

/// A proposed rule, waiting for its notice period.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingRule {
    pub rule: Rule,
    /// Unix seconds from which it applies.
    pub ready_at: u64,
}

/// A proposed tax destination, waiting for its notice period.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingDestination {
    pub destination: Address,
    /// Unix seconds from which it applies.
    pub ready_at: u64,
}

/// What one period holds for one token.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PeriodState {
    /// Reserve still held, per bucket (`vat` and the rule's buckets).
    pub buckets: Map<Symbol, i128>,
    /// Total reserved in the period so far (payments, and conversions into this token).
    pub reserved: i128,
    /// Total sent to the tax destination.
    pub paid: i128,
    /// Total returned to the owner after the due date.
    pub released: i128,
    /// Total swapped out of this token into the reserve currency.
    pub converted: i128,
}

/// How reserve received in `from_token` is turned into `to_token`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Conversion {
    pub from_token: Address,
    pub to_token: Address,
    /// A contract implementing `SwapApi`.
    pub swapper: Address,
    /// A SEP-40 price oracle (e.g. Reflector) that prices both tokens in one base.
    pub oracle: Address,
    /// How the oracle names each token, e.g. `Other(USD)` and `Other(EUR)` on a fiat oracle.
    pub from_price: Asset,
    pub to_price: Asset,
    /// Most a swap may return below the oracle price, in bps.
    pub max_slippage_bps: u32,
    /// Oldest oracle price accepted, in seconds.
    pub max_age_secs: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingConversion {
    pub conversion: Conversion,
    pub ready_at: u64,
}

/// A yield strategy for the reserve held in `token`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Strategy {
    /// A contract implementing `YieldApi` whose owner is this vault.
    pub adapter: Address,
    pub token: Address,
    /// Most of the reserve in `token` the strategy may hold, in bps.
    pub max_bps: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingStrategy {
    pub strategy: Strategy,
    pub ready_at: u64,
}

/// Where the reserve in one token is, and what it has earned.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Position {
    /// What the buckets of every period hold in this token: what the vault owes.
    pub held: i128,
    /// Tokens in the vault itself.
    pub liquid: i128,
    /// What the strategy would give back now.
    pub invested: i128,
    /// liquid + invested - held: the owner's yield (negative if the strategy lost value).
    pub surplus: i128,
}

#[contracttype]
#[derive(Clone)]
enum Key {
    Config,
    PendingRule,
    PendingDestination,
    Period(u32, Address),
    Feed,
    Conversion,
    PendingConversion,
    Strategy,
    PendingStrategy,
    Held(Address),
    Invoice(BytesN<32>),
}

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
    pub reserve: i128,
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

#[contractevent(topics = ["kyros_vault", "invoice_expected"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InvoiceExpected {
    #[topic]
    pub reference: BytesN<32>,
    pub terms: InvoiceTerms,
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

#[contractevent(topics = ["kyros_vault", "conversion_proposed"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConversionProposed {
    pub conversion: Conversion,
    pub ready_at: u64,
}

#[contractevent(topics = ["kyros_vault", "conversion_stopped"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConversionStopped {}

#[contractevent(topics = ["kyros_vault", "strategy_proposed"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StrategyProposed {
    pub strategy: Strategy,
    pub ready_at: u64,
}

#[contractevent(topics = ["kyros_vault", "strategy_stopped"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StrategyStopped {
    /// What came back from the strategy.
    pub withdrawn: i128,
}

#[contractevent(topics = ["kyros_vault", "invested"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Invested {
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

#[contractevent(topics = ["kyros_vault", "released"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Released {
    #[topic]
    pub token: Address,
    #[topic]
    pub period: u32,
    pub amount: i128,
}

#[contractevent(topics = ["kyros_vault", "rule_proposed"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuleProposed {
    pub rule: Rule,
    pub ready_at: u64,
}

#[contractevent(topics = ["kyros_vault", "destination_proposed"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DestinationProposed {
    pub destination: Address,
    pub ready_at: u64,
}

#[contractevent(topics = ["kyros_vault", "rule_applied"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuleApplied {
    pub rule: Rule,
}

#[contractevent(topics = ["kyros_vault", "destination_applied"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DestinationApplied {
    pub destination: Address,
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

#[contractevent(topics = ["kyros_vault", "change_cancelled"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ChangeCancelled {
    pub rule: bool,
    pub destination: bool,
}

fn now(e: &Env) -> u64 {
    e.ledger().timestamp()
}

/// Extends this vault's instance only. The wasm code is shared by every vault
/// and its rent is paid once for all (anyone can extend it), not by each
/// vault on every write.
fn bump_instance(e: &Env) {
    e.deployer().extend_ttl_for_contract_instance(
        e.current_contract_address(),
        INSTANCE_TTL / 2,
        INSTANCE_TTL,
    );
}

fn stored_config(e: &Env) -> Config {
    e.storage().instance().get(&Key::Config).unwrap()
}

fn pending_rule(e: &Env) -> Option<PendingRule> {
    e.storage().instance().get(&Key::PendingRule)
}

fn pending_destination(e: &Env) -> Option<PendingDestination> {
    e.storage().instance().get(&Key::PendingDestination)
}

/// The config in force now: a pending change counts once its notice has passed,
/// even before anyone calls `apply_pending`.
fn active(e: &Env) -> Config {
    let mut c = stored_config(e);
    if let Some(p) = pending_rule(e) {
        if now(e) >= p.ready_at {
            c.rule = p.rule;
        }
    }
    if let Some(p) = pending_destination(e) {
        if now(e) >= p.ready_at {
            c.tax_destination = p.destination;
        }
    }
    c
}

fn feed(e: &Env) -> Option<Feed> {
    e.storage().instance().get(&Key::Feed)
}

/// The VAT the registry gives now, if the vault follows one and the rate is within the ceiling.
fn followed_vat(e: &Env, f: &Feed) -> Option<u32> {
    RegistryClient::new(e, &f.registry)
        .rate_at(&f.country, &f.rate, &now(e))
        .filter(|b| *b <= f.max_bps)
}

/// The config in force now with the followed VAT applied: what payments use.
fn effective(e: &Env) -> Config {
    let mut c = active(e);
    if let Some(f) = feed(e) {
        if let Some(bps) = followed_vat(e, &f) {
            c.rule.vat_bps = bps;
        }
    }
    c
}

fn load_period(e: &Env, id: u32, token: &Address) -> PeriodState {
    e.storage()
        .persistent()
        .get(&Key::Period(id, token.clone()))
        .unwrap_or(PeriodState {
            buckets: Map::new(e),
            reserved: 0,
            paid: 0,
            released: 0,
            converted: 0,
        })
}

fn held(e: &Env, token: &Address) -> i128 {
    e.storage()
        .persistent()
        .get(&Key::Held(token.clone()))
        .unwrap_or(0)
}

fn add_held(e: &Env, token: &Address, delta: i128) {
    let k = Key::Held(token.clone());
    e.storage().persistent().set(&k, &(held(e, token) + delta));
    e.storage()
        .persistent()
        .extend_ttl(&k, PERIOD_TTL / 2, PERIOD_TTL);
}

/// The conversion in force now (a pending one counts once its notice has passed).
fn active_conversion(e: &Env) -> Option<Conversion> {
    let pending: Option<PendingConversion> = e.storage().instance().get(&Key::PendingConversion);
    if let Some(p) = pending {
        if now(e) >= p.ready_at {
            return Some(p.conversion);
        }
    }
    e.storage().instance().get(&Key::Conversion)
}

/// The strategy in force now (a pending one counts once its notice has passed).
fn active_strategy(e: &Env) -> Option<Strategy> {
    let pending: Option<PendingStrategy> = e.storage().instance().get(&Key::PendingStrategy);
    if let Some(p) = pending {
        if now(e) >= p.ready_at {
            return Some(p.strategy);
        }
    }
    e.storage().instance().get(&Key::Strategy)
}

fn invested(e: &Env, token: &Address) -> i128 {
    match active_strategy(e) {
        Some(s) if s.token == *token => YieldClient::new(e, &s.adapter).balance(),
        _ => 0,
    }
}

/// Makes sure the vault itself holds `amount` of `token`, withdrawing the
/// difference from the strategy if needed.
fn ensure_liquid(e: &Env, token: &Address, amount: i128) -> Result<(), VaultError> {
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

fn price(e: &Env, o: &OracleClient, a: &Asset, max_age: u64) -> Result<i128, VaultError> {
    let p = o.lastprice(a).ok_or(VaultError::PriceUnavailable)?;
    if p.price <= 0 || now(e).saturating_sub(p.timestamp) > max_age {
        return Err(VaultError::PriceUnavailable);
    }
    Ok(p.price)
}

/// The least a swap of `amount` must return: the oracle price minus the tolerance.
fn floor_out(e: &Env, c: &Conversion, amount: i128) -> Result<i128, VaultError> {
    let o = OracleClient::new(e, &c.oracle);
    let pf = price(e, &o, &c.from_price, c.max_age_secs)?;
    let pt = price(e, &o, &c.to_price, c.max_age_secs)?;
    let df = token::Client::new(e, &c.from_token).decimals();
    let dt = token::Client::new(e, &c.to_token).decimals();
    let mut fair = amount * pf / pt;
    if dt > df {
        fair *= 10i128.pow(dt - df);
    } else if df > dt {
        fair /= 10i128.pow(df - dt);
    }
    Ok(fair * (BPS - c.max_slippage_bps as i128) / BPS)
}

fn save_period(e: &Env, id: u32, token: &Address, s: &PeriodState) {
    let k = Key::Period(id, token.clone());
    e.storage().persistent().set(&k, s);
    e.storage()
        .persistent()
        .extend_ttl(&k, PERIOD_TTL / 2, PERIOD_TTL);
}

fn check_rule(e: &Env, rule: &Rule) -> Result<(), VaultError> {
    validate(e, rule).map_err(|_| VaultError::InvalidRule)
}

#[contract]
pub struct ReserveVault;

#[contractimpl]
impl ReserveVault {
    pub fn __constructor(
        e: Env,
        owner: Address,
        rule: Rule,
        tax_destination: Address,
        notice_secs: u64,
        period: PeriodKind,
        due_offset_secs: u64,
        tokens: Vec<Address>,
    ) -> Result<(), VaultError> {
        check_rule(&e, &rule)?;
        if tokens.is_empty() {
            return Err(VaultError::NoTokens);
        }
        let c = Config {
            owner,
            rule,
            tax_destination,
            notice_secs,
            period,
            due_offset_secs,
            tokens,
        };
        e.storage().instance().set(&Key::Config, &c);
        bump_instance(&e);
        Ok(())
    }

    // ---- Reads ----

    /// The config in force now (a pending change whose notice has passed is
    /// included; while following a registry, the rule shows the followed VAT).
    pub fn config(e: Env) -> Config {
        effective(&e)
    }

    /// The registry the vault follows for its VAT, if any.
    pub fn feed(e: Env) -> Option<Feed> {
        feed(&e)
    }

    pub fn notice_secs(e: Env) -> u64 {
        stored_config(&e).notice_secs
    }

    pub fn pending_rule(e: Env) -> Option<PendingRule> {
        pending_rule(&e)
    }

    pub fn pending_destination(e: Env) -> Option<PendingDestination> {
        pending_destination(&e)
    }

    pub fn owner(e: Env) -> Address {
        stored_config(&e).owner
    }

    pub fn accepts(e: Env, token: Address) -> bool {
        stored_config(&e).tokens.contains(&token)
    }

    /// The split the current rule gives for `gross`.
    pub fn quote(e: Env, gross: i128) -> Split {
        split(&e, &effective(&e).rule, gross)
    }

    pub fn current_period(e: Env) -> u32 {
        period_of(&stored_config(&e).period, now(&e))
    }

    /// Unix seconds from which `period`'s reserve can be released to the owner.
    pub fn due_date(e: Env, period: u32) -> u64 {
        let c = stored_config(&e);
        period_end(&c.period, period) + c.due_offset_secs
    }

    pub fn period(e: Env, period: u32, token: Address) -> PeriodState {
        load_period(&e, period, &token)
    }

    // ---- Money in ----

    /// Pulls `gross` of `token` from `from` (who must authorize the transfers):
    /// the net amount to the owner, the reserve into the vault, booked to the
    /// current period. Called by the Router (the payer authorizes) and by the
    /// user's Inbox (the inbox contract authorizes).
    pub fn receive(
        e: Env,
        from: Address,
        token: Address,
        gross: i128,
        reference: BytesN<32>,
    ) -> Result<Split, VaultError> {
        from.require_auth();
        if gross <= 0 {
            return Err(VaultError::InvalidAmount);
        }
        let mut c = effective(&e);
        if !c.tokens.contains(&token) {
            return Err(VaultError::TokenNotAccepted);
        }
        // An invoice the owner registered splits by its own terms; anything else by the rule.
        let terms: Option<InvoiceTerms> = e
            .storage()
            .persistent()
            .get(&Key::Invoice(reference.clone()));
        let s = match terms {
            Some(t) => {
                c.rule = Rule {
                    vat_bps: t.vat_bps,
                    buckets: t.buckets,
                };
                split_withheld(&e, &c.rule, t.withholding_bps, gross)
            }
            None => split(&e, &c.rule, gross),
        };
        let t = token::Client::new(&e, &token);
        if s.net > 0 {
            t.transfer(&from, &c.owner, &s.net);
        }
        if s.reserve > 0 {
            t.transfer(&from, &e.current_contract_address(), &s.reserve);
        }
        let id = period_of(&c.period, now(&e));
        let mut p = load_period(&e, id, &token);
        let vat = vat_symbol(&e);
        p.buckets
            .set(vat.clone(), p.buckets.get(vat).unwrap_or(0) + s.vat);
        for (i, b) in c.rule.buckets.iter().enumerate() {
            let part = s.parts.get(i as u32).unwrap();
            p.buckets
                .set(b.name.clone(), p.buckets.get(b.name).unwrap_or(0) + part);
        }
        p.reserved += s.reserve;
        save_period(&e, id, &token, &p);
        add_held(&e, &token, s.reserve);
        bump_instance(&e);
        Received {
            token,
            period: id,
            from,
            reference,
            gross,
            net: s.net,
            vat: s.vat,
            parts: s.parts.clone(),
            reserve: s.reserve,
        }
        .publish(&e);
        Ok(s)
    }

    // ---- Money out ----

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

    /// After the period's due date, returns everything it still holds to the owner.
    pub fn release(e: Env, period: u32, token: Address) -> Result<i128, VaultError> {
        let c = active(&e);
        c.owner.require_auth();
        if now(&e) < period_end(&c.period, period) + c.due_offset_secs {
            return Err(VaultError::NotDue);
        }
        let mut p = load_period(&e, period, &token);
        let mut total: i128 = 0;
        let mut emptied = Map::new(&e);
        for (k, v) in p.buckets.iter() {
            total += v;
            emptied.set(k, 0i128);
        }
        if total <= 0 {
            return Err(VaultError::NothingToRelease);
        }
        p.buckets = emptied;
        p.released += total;
        save_period(&e, period, &token, &p);
        add_held(&e, &token, -total);
        ensure_liquid(&e, &token, total)?;
        token::Client::new(&e, &token).transfer(&e.current_contract_address(), &c.owner, &total);
        Released {
            token,
            period,
            amount: total,
        }
        .publish(&e);
        Ok(total)
    }

    // ---- Changes, with notice ----

    /// Proposes a new rule; it applies after `notice_secs`. A new proposal
    /// replaces a pending one and restarts the notice.
    pub fn propose_rule(e: Env, rule: Rule) -> Result<u64, VaultError> {
        Self::propose_rule_at(e, rule, 0)
    }

    /// Proposes a new rule that takes effect at `effective_at` (UNIX seconds),
    /// or after `notice_secs` if that is later. Used to follow a scheduled VAT
    /// change: the owner signs ahead and the vault switches on the day the new
    /// rate applies, never before the notice has run. 0 means as soon as possible.
    pub fn propose_rule_at(e: Env, rule: Rule, effective_at: u64) -> Result<u64, VaultError> {
        let c = active(&e);
        c.owner.require_auth();
        check_rule(&e, &rule)?;
        Self::fold(&e);
        let ready_at = (now(&e) + c.notice_secs).max(effective_at);
        e.storage().instance().set(
            &Key::PendingRule,
            &PendingRule {
                rule: rule.clone(),
                ready_at,
            },
        );
        bump_instance(&e);
        RuleProposed { rule, ready_at }.publish(&e);
        Ok(ready_at)
    }

    /// Proposes a new tax destination; it applies after `notice_secs`.
    pub fn propose_destination(e: Env, destination: Address) -> Result<u64, VaultError> {
        let c = active(&e);
        c.owner.require_auth();
        Self::fold(&e);
        let ready_at = now(&e) + c.notice_secs;
        e.storage().instance().set(
            &Key::PendingDestination,
            &PendingDestination {
                destination: destination.clone(),
                ready_at,
            },
        );
        bump_instance(&e);
        DestinationProposed {
            destination,
            ready_at,
        }
        .publish(&e);
        Ok(ready_at)
    }

    // ---- VAT that follows the law ----

    /// Starts reading the VAT rate from `registry` (`country`, `rate`), so
    /// legal changes apply on their date with no signature. Changes nothing
    /// today: the registry's current rate must equal the vault's VAT. The
    /// registry must give at least the vault's own notice. A rate above
    /// `max_bps` is ignored and the vault keeps its own rule.
    pub fn follow(
        e: Env,
        registry: Address,
        country: Symbol,
        rate: Symbol,
        max_bps: u32,
    ) -> Result<(), VaultError> {
        let c = effective(&e);
        c.owner.require_auth();
        let r = RegistryClient::new(&e, &registry);
        if r.min_notice() < c.notice_secs {
            return Err(VaultError::RegistryNoticeTooShort);
        }
        let today = r
            .rate_at(&country, &rate, &now(&e))
            .ok_or(VaultError::UnknownRate)?;
        if today != c.rule.vat_bps || today > max_bps || max_bps > 10_000 {
            return Err(VaultError::RateMismatch);
        }
        e.storage().instance().set(
            &Key::Feed,
            &Feed {
                registry: registry.clone(),
                country: country.clone(),
                rate: rate.clone(),
                max_bps,
            },
        );
        bump_instance(&e);
        VatFollowed {
            registry,
            country,
            rate,
            max_bps,
        }
        .publish(&e);
        Ok(())
    }

    /// Stops following the registry, at once. The vault keeps the VAT in
    /// force at this moment as its own.
    pub fn unfollow(e: Env) -> Result<u32, VaultError> {
        let c = effective(&e);
        c.owner.require_auth();
        if feed(&e).is_none() {
            return Err(VaultError::NotFollowing);
        }
        Self::fold(&e);
        let mut stored = stored_config(&e);
        stored.rule.vat_bps = c.rule.vat_bps;
        e.storage().instance().set(&Key::Config, &stored);
        e.storage().instance().remove(&Key::Feed);
        bump_instance(&e);
        VatUnfollowed {
            vat_bps: c.rule.vat_bps,
        }
        .publish(&e);
        Ok(c.rule.vat_bps)
    }

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
            .extend_ttl(&k, PERIOD_TTL / 2, PERIOD_TTL);
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
        let k = Key::Invoice(reference);
        if !e.storage().persistent().has(&k) {
            return Err(VaultError::UnknownInvoice);
        }
        e.storage().persistent().remove(&k);
        Ok(())
    }

    // ---- Reserve in the tax's currency ----

    /// The conversion in force now, if any.
    pub fn conversion(e: Env) -> Option<Conversion> {
        active_conversion(&e)
    }

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
            || conversion.max_slippage_bps as i128 > BPS
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

    // ---- Yield ----

    /// The strategy in force now, if any.
    pub fn strategy(e: Env) -> Option<Strategy> {
        active_strategy(&e)
    }

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
            let y = YieldClient::new(&e, &s.adapter);
            let all = y.balance();
            if all > 0 {
                withdrawn = y.withdraw(&all);
            }
        }
        e.storage().instance().remove(&Key::Strategy);
        e.storage().instance().remove(&Key::PendingStrategy);
        StrategyStopped { withdrawn }.publish(&e);
        Ok(withdrawn)
    }

    /// Moves liquid reserve into the strategy up to its share. Anyone can
    /// call it (a keeper does). Returns the amount deposited.
    pub fn invest(e: Env) -> Result<i128, VaultError> {
        let s = active_strategy(&e).ok_or(VaultError::NoStrategy)?;
        Self::fold_extras(&e);
        let me = e.current_contract_address();
        let y = YieldClient::new(&e, &s.adapter);
        let target = held(&e, &s.token) * s.max_bps as i128 / BPS;
        let liquid = token::Client::new(&e, &s.token).balance(&me);
        let amount = (target - y.balance()).min(liquid);
        if amount <= 0 {
            return Ok(0);
        }
        token::Client::new(&e, &s.token).transfer(&me, &s.adapter, &amount);
        y.deposit(&amount);
        bump_instance(&e);
        Invested {
            token: s.token,
            amount,
        }
        .publish(&e);
        Ok(amount)
    }

    /// Sends the owner what the reserve in `token` has earned (liquid plus
    /// invested, minus what the buckets hold). Returns the amount sent.
    pub fn harvest(e: Env, token: Address) -> Result<i128, VaultError> {
        let c = active(&e);
        c.owner.require_auth();
        let me = e.current_contract_address();
        let liquid = token::Client::new(&e, &token).balance(&me);
        let surplus = liquid + invested(&e, &token) - held(&e, &token);
        if surplus <= 0 {
            return Ok(0);
        }
        ensure_liquid(&e, &token, surplus)?;
        let amount = surplus.min(token::Client::new(&e, &token).balance(&me));
        token::Client::new(&e, &token).transfer(&me, &c.owner, &amount);
        Harvested { token, amount }.publish(&e);
        Ok(amount)
    }

    /// Withdraws pending changes that have not taken effect yet.
    pub fn cancel(e: Env) -> Result<(), VaultError> {
        stored_config(&e).owner.require_auth();
        let t = now(&e);
        let r = pending_rule(&e).filter(|p| t < p.ready_at).is_some();
        let d = pending_destination(&e).filter(|p| t < p.ready_at).is_some();
        if !r && !d {
            return if pending_rule(&e).is_some() || pending_destination(&e).is_some() {
                Err(VaultError::AlreadyInForce)
            } else {
                Err(VaultError::NoPendingChange)
            };
        }
        if r {
            e.storage().instance().remove(&Key::PendingRule);
        }
        if d {
            e.storage().instance().remove(&Key::PendingDestination);
        }
        ChangeCancelled {
            rule: r,
            destination: d,
        }
        .publish(&e);
        Ok(())
    }

    /// Writes pending changes whose notice has passed into the config. Anyone can call it.
    pub fn apply_pending(e: Env) -> Result<(), VaultError> {
        if pending_rule(&e).is_none() && pending_destination(&e).is_none() {
            return Err(VaultError::NoPendingChange);
        }
        if !Self::fold(&e) {
            return Err(VaultError::ChangeNotReady);
        }
        bump_instance(&e);
        Ok(())
    }
}

impl ReserveVault {
    #[allow(clippy::too_many_arguments)]
    fn pay(
        e: &Env,
        c: &Config,
        period: u32,
        token: Address,
        bucket: Symbol,
        amount: i128,
        to: MuxedAddress,
    ) -> Result<(), VaultError> {
        c.owner.require_auth();
        if amount <= 0 {
            return Err(VaultError::InvalidAmount);
        }
        let mut p = load_period(e, period, &token);
        let held_now = p
            .buckets
            .get(bucket.clone())
            .ok_or(VaultError::UnknownBucket)?;
        if amount > held_now {
            return Err(VaultError::ExceedsReserve);
        }
        p.buckets.set(bucket.clone(), held_now - amount);
        p.paid += amount;
        save_period(e, period, &token, &p);
        add_held(e, &token, -amount);
        ensure_liquid(e, &token, amount)?;
        let memo = to.id();
        token::Client::new(e, &token).transfer(&e.current_contract_address(), &to, &amount);
        TaxPaid {
            token,
            period,
            bucket,
            amount,
            destination: c.tax_destination.clone(),
            memo,
        }
        .publish(e);
        Ok(())
    }

    /// Moves a conversion or strategy whose notice has passed into place.
    fn fold_extras(e: &Env) {
        let t = now(e);
        let pc: Option<PendingConversion> = e.storage().instance().get(&Key::PendingConversion);
        if let Some(p) = pc {
            if t >= p.ready_at {
                e.storage().instance().set(&Key::Conversion, &p.conversion);
                e.storage().instance().remove(&Key::PendingConversion);
            }
        }
        let ps: Option<PendingStrategy> = e.storage().instance().get(&Key::PendingStrategy);
        if let Some(p) = ps {
            if t >= p.ready_at {
                e.storage().instance().set(&Key::Strategy, &p.strategy);
                e.storage().instance().remove(&Key::PendingStrategy);
            }
        }
    }

    /// Moves ready pending changes into the stored config. Returns whether any applied.
    fn fold(e: &Env) -> bool {
        let t = now(e);
        let mut c = stored_config(e);
        let mut applied = false;
        if let Some(p) = pending_rule(e) {
            if t >= p.ready_at {
                c.rule = p.rule.clone();
                e.storage().instance().remove(&Key::PendingRule);
                RuleApplied { rule: p.rule }.publish(e);
                applied = true;
            }
        }
        if let Some(p) = pending_destination(e) {
            if t >= p.ready_at {
                c.tax_destination = p.destination.clone();
                e.storage().instance().remove(&Key::PendingDestination);
                DestinationApplied {
                    destination: p.destination,
                }
                .publish(e);
                applied = true;
            }
        }
        if applied {
            e.storage().instance().set(&Key::Config, &c);
        }
        applied
    }
}

#[cfg(test)]
mod test;
