//! Kyros CCTP receiver: a client pays a Kyros vault from another chain.
//!
//! The client burns USDC on Ethereum, Base, Arbitrum or any other chain
//! Circle's CCTP V2 serves, naming this contract as `mintRecipient` and
//! `destinationCaller`, and putting the vault and the invoice reference in
//! the burn's hook data. Once Circle attests the burn, anyone calls
//! `mint_and_pay`: in one transaction this contract mints the USDC through
//! CCTP and pays it into the vault with that reference, so the vault splits
//! it (net to the owner, reserve to the vault, by the invoice's own terms if
//! the owner registered them). Nothing stays here between calls.
//!
//! The vault and the reference come from the burn the client signed on the
//! source chain, so the relayer cannot change where the money goes or which
//! terms apply. If the vault refuses the payment the whole call reverts and
//! the attested message stays redeemable.
//!
//! Hook data (the first 32 bytes follow the layout Circle's own forwarder
//! uses, with a zero magic so Circle does not relay it):
//!
//! ```text
//! bytes  0..24  zero
//! bytes 24..28  version, u32 big-endian = 1
//! bytes 28..32  length of what follows, u32 big-endian = 64
//! bytes 32..64  the vault's contract id
//! bytes 64..96  the invoice reference (zero for none)
//! ```
//!
//! No admin, no stored funds.
#![no_std]
use kyros_types::{split_withheld, Rule, Split, VaultClient};
use soroban_sdk::{
    address_payload::AddressPayload,
    auth::{ContractContext, InvokerContractAuthEntry, SubContractInvocation},
    contract, contractclient, contracterror, contractevent, contractimpl, contracttype,
    panic_with_error, token, vec, Address, Bytes, BytesN, Env, IntoVal, Symbol, Vec,
};

/// CCTP message V2 layout (Circle's `MessageV2`).
const MSG_VERSION: u32 = 0;
const MSG_SOURCE_DOMAIN: u32 = 4;
const MSG_SENDER: u32 = 44;
const MSG_RECIPIENT: u32 = 76;
const MSG_DESTINATION_CALLER: u32 = 108;
const MSG_BODY: u32 = 148;
/// Burn message V2 layout (Circle's `BurnMessageV2`), inside the body.
const BURN_VERSION: u32 = 0;
const BURN_TOKEN: u32 = 4;
const BURN_MINT_RECIPIENT: u32 = 36;
const BURN_MESSAGE_SENDER: u32 = 100;
const BURN_HOOK_DATA: u32 = 228;
const CCTP_VERSION: u32 = 1;
/// Kyros hook data.
pub const HOOK_VERSION: u32 = 1;
const HOOK_LEN: u32 = 64;

const DAY_IN_LEDGERS: u32 = 17_280;
const INSTANCE_TTL: u32 = 180 * DAY_IN_LEDGERS;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum CctpPayError {
    /// The message is too short or not a CCTP V2 burn.
    BadMessage = 1,
    /// The message is not addressed to Circle's TokenMessengerMinter.
    WrongRecipient = 2,
    /// The burn does not mint to this contract.
    WrongMintRecipient = 3,
    /// Another contract is the only one allowed to redeem this message.
    WrongCaller = 4,
    /// The hook data is not Kyros hook data.
    BadHookData = 5,
    /// CCTP does not know the burned token on this network.
    UnknownToken = 6,
    /// The mint added nothing.
    NothingMinted = 7,
}

#[contracttype]
#[derive(Clone)]
enum Key {
    Transmitter,
    Minter,
}

/// Circle's MessageTransmitter: validates the attestation and mints.
#[contractclient(name = "TransmitterClient")]
pub trait Transmitter {
    fn receive_message(e: Env, caller: Address, message: Bytes, attestation: Bytes) -> bool;
}

/// Circle's TokenMessengerMinter: which local token a remote token mints.
#[contractclient(name = "MinterClient")]
pub trait Minter {
    fn get_local_token(e: Env, remote_domain: u32, remote_token: BytesN<32>) -> Option<Address>;
}

/// A cross-chain payment paid into a vault.
#[contractevent(topics = ["kyros_cctp", "paid"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Paid {
    #[topic]
    pub vault: Address,
    #[topic]
    pub reference: BytesN<32>,
    /// CCTP domain of the source chain (0 Ethereum, 3 Arbitrum, 6 Base…).
    pub source_domain: u32,
    /// Who burned on the source chain (an EVM address is left-padded to 32 bytes).
    pub payer: BytesN<32>,
    pub token: Address,
    pub gross: i128,
    pub net: i128,
    pub reserve: i128,
}

/// What a payment message carries, once checked.
pub struct Payment {
    pub source_domain: u32,
    pub payer: BytesN<32>,
    pub burn_token: BytesN<32>,
    pub vault: Address,
    pub reference: BytesN<32>,
}

fn read_u32(e: &Env, b: &Bytes, at: u32) -> u32 {
    if b.len() < at + 4 {
        panic_with_error!(e, CctpPayError::BadMessage);
    }
    let mut x = [0u8; 4];
    b.slice(at..at + 4).copy_into_slice(&mut x);
    u32::from_be_bytes(x)
}

fn read_32(e: &Env, b: &Bytes, at: u32) -> BytesN<32> {
    if b.len() < at + 32 {
        panic_with_error!(e, CctpPayError::BadMessage);
    }
    let mut x = [0u8; 32];
    b.slice(at..at + 32).copy_into_slice(&mut x);
    BytesN::from_array(e, &x)
}

fn contract_id(e: &Env, a: &Address) -> BytesN<32> {
    match a.to_payload() {
        Some(AddressPayload::ContractIdHash(h)) => h,
        _ => panic_with_error!(e, CctpPayError::BadMessage),
    }
}

/// Checks a CCTP message is a burn that mints to `me` and carries Kyros hook data.
pub fn parse(e: &Env, me: &Address, minter: &Address, message: &Bytes) -> Payment {
    if message.len() < MSG_BODY || read_u32(e, message, MSG_VERSION) != CCTP_VERSION {
        panic_with_error!(e, CctpPayError::BadMessage);
    }
    if read_32(e, message, MSG_RECIPIENT) != contract_id(e, minter) {
        panic_with_error!(e, CctpPayError::WrongRecipient);
    }
    let caller = read_32(e, message, MSG_DESTINATION_CALLER);
    if caller != BytesN::from_array(e, &[0; 32]) && caller != contract_id(e, me) {
        panic_with_error!(e, CctpPayError::WrongCaller);
    }
    let body = message.slice(MSG_BODY..message.len());
    if body.len() < BURN_HOOK_DATA || read_u32(e, &body, BURN_VERSION) != CCTP_VERSION {
        panic_with_error!(e, CctpPayError::BadMessage);
    }
    if read_32(e, &body, BURN_MINT_RECIPIENT) != contract_id(e, me) {
        panic_with_error!(e, CctpPayError::WrongMintRecipient);
    }
    let hook = body.slice(BURN_HOOK_DATA..body.len());
    if hook.len() < 32 + HOOK_LEN
        || hook.slice(0..24) != Bytes::from_array(e, &[0; 24])
        || read_u32(e, &hook, 24) != HOOK_VERSION
        || read_u32(e, &hook, 28) != HOOK_LEN
    {
        panic_with_error!(e, CctpPayError::BadHookData);
    }
    let vault = Address::from_payload(e, AddressPayload::ContractIdHash(read_32(e, &hook, 32)));
    // The source chain's sender is the TokenMessenger; the person who burned is in the burn message.
    let _ = read_32(e, message, MSG_SENDER);
    Payment {
        source_domain: read_u32(e, message, MSG_SOURCE_DOMAIN),
        payer: read_32(e, &body, BURN_MESSAGE_SENDER),
        burn_token: read_32(e, &body, BURN_TOKEN),
        vault,
        reference: read_32(e, &hook, 64),
    }
}

#[contract]
pub struct CctpPay;

#[contractimpl]
impl CctpPay {
    /// `transmitter` and `minter` are Circle's MessageTransmitter and
    /// TokenMessengerMinter on this network.
    pub fn __constructor(e: Env, transmitter: Address, minter: Address) {
        e.storage().instance().set(&Key::Transmitter, &transmitter);
        e.storage().instance().set(&Key::Minter, &minter);
    }

    pub fn transmitter(e: Env) -> Address {
        e.storage().instance().get(&Key::Transmitter).unwrap()
    }

    pub fn minter(e: Env) -> Address {
        e.storage().instance().get(&Key::Minter).unwrap()
    }

    /// Mints an attested CCTP burn and pays it into the vault its hook data
    /// names, with its reference. Permissionless: whoever relays it pays the
    /// network fee and cannot change anything else.
    pub fn mint_and_pay(e: Env, message: Bytes, attestation: Bytes) -> Split {
        let me = e.current_contract_address();
        let minter = Self::minter(e.clone());
        let p = parse(&e, &me, &minter, &message);
        let token = MinterClient::new(&e, &minter)
            .get_local_token(&p.source_domain, &p.burn_token)
            .unwrap_or_else(|| panic_with_error!(&e, CctpPayError::UnknownToken));

        let t = token::Client::new(&e, &token);
        let before = t.balance(&me);
        TransmitterClient::new(&e, &Self::transmitter(e.clone())).receive_message(
            &me,
            &message,
            &attestation,
        );
        let gross = t.balance(&me) - before;
        if gross <= 0 {
            panic_with_error!(&e, CctpPayError::NothingMinted);
        }

        // The vault pulls the money from here; authorize exactly the two
        // transfers its split will make, nothing else.
        let v = VaultClient::new(&e, &p.vault);
        let s = match v.invoice(&p.reference) {
            Some(terms) => split_withheld(
                &e,
                &Rule {
                    vat_bps: terms.vat_bps,
                    buckets: terms.buckets,
                },
                terms.withholding_bps,
                gross,
            ),
            None => v.quote(&gross),
        };
        let owner = v.owner();
        let transfer = Symbol::new(&e, "transfer");
        let mut auths: Vec<InvokerContractAuthEntry> = Vec::new(&e);
        if s.net > 0 {
            auths.push_back(InvokerContractAuthEntry::Contract(SubContractInvocation {
                context: ContractContext {
                    contract: token.clone(),
                    fn_name: transfer.clone(),
                    args: (me.clone(), owner, s.net).into_val(&e),
                },
                sub_invocations: vec![&e],
            }));
        }
        if s.reserve > 0 {
            auths.push_back(InvokerContractAuthEntry::Contract(SubContractInvocation {
                context: ContractContext {
                    contract: token.clone(),
                    fn_name: transfer,
                    args: (me.clone(), p.vault.clone(), s.reserve).into_val(&e),
                },
                sub_invocations: vec![&e],
            }));
        }
        e.authorize_as_current_contract(auths);
        let done = v.receive(&me, &token, &gross, &p.reference);
        e.storage()
            .instance()
            .extend_ttl(INSTANCE_TTL / 2, INSTANCE_TTL);
        Paid {
            vault: p.vault,
            reference: p.reference,
            source_domain: p.source_domain,
            payer: p.payer,
            token,
            gross,
            net: done.net,
            reserve: done.reserve,
        }
        .publish(&e);
        done
    }
}

#[cfg(test)]
mod test;
