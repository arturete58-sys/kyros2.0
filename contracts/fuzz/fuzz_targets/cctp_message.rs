//! Cross-chain messages as an attacker would send them: raw bytes, or a
//! well-formed CCTP V2 message with fuzzer-chosen bytes changed or cut. The
//! parser must accept or refuse with one of its own error codes, never trap.
#![no_main]
use arbitrary::{Arbitrary, Unstructured};
use kyros_cctp_pay::{parse, CctpPayError, HOOK_VERSION};
use libfuzzer_sys::fuzz_target;
use soroban_sdk::{
    contract, contractimpl, testutils::Address as _, Address, Bytes, BytesN, Env,
};

/// Runs the parser inside a contract, so its errors are contract errors.
#[contract]
pub struct Harness;

#[contractimpl]
impl Harness {
    pub fn parse(e: Env, minter: Address, message: Bytes) -> Result<BytesN<32>, CctpPayError> {
        let me = e.current_contract_address();
        Ok(parse(&e, &me, &minter, &message).reference)
    }
}

fn id(a: &Address) -> [u8; 32] {
    match a.to_payload() {
        Some(soroban_sdk::address_payload::AddressPayload::ContractIdHash(h)) => h.to_array(),
        _ => [0; 32],
    }
}

/// A well-formed message for `me`, minted by `minter`, paying `vault`.
fn valid(e: &Env, me: &Address, minter: &Address, vault: &Address) -> Bytes {
    let mut m = Bytes::new(e);
    m.extend_from_array(&1u32.to_be_bytes()); // version
    m.extend_from_array(&6u32.to_be_bytes()); // source domain (Base)
    m.extend_from_array(&27u32.to_be_bytes()); // destination domain (Stellar)
    m.extend_from_array(&[1; 32]); // nonce
    m.extend_from_array(&[0x5E; 32]); // sender
    m.extend_from_array(&id(minter)); // recipient
    m.extend_from_array(&[0; 32]); // destination caller: anyone
    m.extend_from_array(&1000u32.to_be_bytes());
    m.extend_from_array(&1000u32.to_be_bytes());
    m.extend_from_array(&1u32.to_be_bytes()); // burn message version
    m.extend_from_array(&[0xBA; 32]); // burn token
    m.extend_from_array(&id(me)); // mint recipient
    m.extend_from_array(&[0; 32]); // amount
    m.extend_from_array(&[0xC1; 32]); // message sender
    m.extend_from_array(&[0; 96]); // max fee, fee executed, expiration
    m.extend_from_array(&[0; 24]); // hook
    m.extend_from_array(&HOOK_VERSION.to_be_bytes());
    m.extend_from_array(&64u32.to_be_bytes());
    m.extend_from_array(&id(vault));
    m.extend_from_array(&[7; 32]); // reference
    m
}

fuzz_target!(|data: &[u8]| {
    let mut u = Unstructured::new(data);
    let e = Env::default();
    e.cost_estimate().budget().reset_unlimited();
    let h = HarnessClient::new(&e, &e.register(Harness, ()));
    let minter = e.register(Harness, ());
    let vault = Address::generate(&e);
    let raw = bool::arbitrary(&mut u).unwrap_or(false);
    let message = if raw {
        Bytes::from_slice(&e, u.take_rest())
    } else {
        let mut m = valid(&e, &h.address, &minter, &vault);
        let flips = u.int_in_range(0u8..=4).unwrap_or(0);
        for _ in 0..flips {
            let (Ok(at), Ok(b)) = (u.int_in_range(0..=m.len() - 1), u8::arbitrary(&mut u)) else {
                break;
            };
            m.set(at, b);
        }
        if let Ok(true) = bool::arbitrary(&mut u) {
            let cut = u.int_in_range(0..=m.len()).unwrap_or(m.len());
            m = m.slice(0..cut);
        }
        m
    };
    match h.try_parse(&minter, &message) {
        // Accepted, or refused with one of the receiver's own codes.
        Ok(_) | Err(Ok(_)) => {}
        Err(Err(err)) => panic!("the parser trapped instead of refusing: {err:?}"),
    }
});
