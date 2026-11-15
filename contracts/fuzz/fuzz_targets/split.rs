//! The split for any valid rule and any gross in 0..=i128::MAX: it never
//! fails, the parts add up to the gross exactly, VAT is never rounded down
//! and no bucket takes more than its share of the base.
#![no_main]
use arbitrary::{Arbitrary, Unstructured};
use kyros_types::{mul_div_ceil, mul_div_floor, split, validate, Bucket, Rule, BPS};
use libfuzzer_sys::fuzz_target;
use soroban_sdk::{Env, Symbol, Vec};

const NAMES: [&str; 8] = ["irpf", "ss", "b3", "b4", "b5", "b6", "b7", "b8"];

fuzz_target!(|data: &[u8]| {
    let mut u = Unstructured::new(data);
    let e = Env::default();
    e.cost_estimate().budget().reset_unlimited();
    let Ok(vat) = u.int_in_range(0u32..=10_000) else { return };
    let Ok(n) = u.int_in_range(0usize..=8) else { return };
    let mut buckets = Vec::new(&e);
    for name in NAMES.iter().take(n) {
        let Ok(bps) = u.int_in_range(0u32..=10_000) else { return };
        buckets.push_back(Bucket {
            name: Symbol::new(&e, name),
            bps,
        });
    }
    let rule = Rule { vat_bps: vat, buckets };
    if validate(&e, &rule).is_err() {
        return;
    }
    let Ok(gross) = i128::arbitrary(&mut u).map(|g| g.checked_abs().unwrap_or(i128::MAX)) else {
        return;
    };
    let s = split(&e, &rule, gross).expect("a valid rule splits every gross");
    assert_eq!(s.net + s.reserve, gross);
    assert!(s.net >= 0 && s.base >= 0 && s.base <= gross);
    // VAT is what the base leaves: never below the exact figure.
    let exact_vat = mul_div_ceil(&e, gross, vat as i128, BPS + vat as i128).unwrap();
    assert!(s.vat >= exact_vat - 1 && s.vat <= exact_vat + 1);
    for (b, p) in rule.buckets.iter().zip(s.parts.iter()) {
        assert_eq!(p, mul_div_floor(&e, s.base, b.bps as i128, BPS).unwrap());
    }
});
