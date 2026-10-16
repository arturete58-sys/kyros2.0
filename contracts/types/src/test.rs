extern crate std;
use super::*;
use soroban_sdk::{vec, Env, Symbol};
use std::string::String;

fn vectors() -> serde_json::Value {
    serde_json::from_str(include_str!("../../../test-vectors/vectors.json")).unwrap()
}

fn num(v: &serde_json::Value) -> i128 {
    v.as_str().unwrap().parse().unwrap()
}

fn rule(e: &Env, vat: u32, buckets: &[(&str, u32)]) -> Rule {
    let mut b = Vec::new(e);
    for (n, bps) in buckets {
        b.push_back(Bucket {
            name: Symbol::new(e, n),
            bps: *bps,
        });
    }
    Rule {
        vat_bps: vat,
        buckets: b,
    }
}

#[test]
fn the_worked_example_from_the_architecture_document() {
    let e = Env::default();
    // 1,210 USDC (7 decimals), 21% VAT included, 20% income-tax prepayment on the base.
    let s = split(&e, &rule(&e, 2100, &[("irpf", 2000)]), 12_100_000_000);
    assert_eq!(s.base, 10_000_000_000);
    assert_eq!(s.vat, 2_100_000_000);
    assert_eq!(s.parts, vec![&e, 2_000_000_000]);
    assert_eq!(s.reserve, 4_100_000_000);
    assert_eq!(s.net, 8_000_000_000);
}

#[test]
fn every_shared_split_vector_matches() {
    let e = Env::default();
    let v = vectors();
    let cases = v["splits"].as_array().unwrap();
    assert!(cases.len() >= 50);
    for c in cases {
        let mut b = Vec::new(&e);
        for x in c["buckets"].as_array().unwrap() {
            b.push_back(Bucket {
                name: Symbol::new(&e, x["name"].as_str().unwrap()),
                bps: x["bps"].as_u64().unwrap() as u32,
            });
        }
        let r = Rule {
            vat_bps: c["vat_bps"].as_u64().unwrap() as u32,
            buckets: b,
        };
        assert_eq!(validate(&e, &r), Ok(()));
        let s = split(&e, &r, num(&c["gross"]));
        let name: String = c["rule"].as_str().unwrap().into();
        assert_eq!(s.base, num(&c["base"]), "{name}");
        assert_eq!(s.vat, num(&c["vat"]), "{name}");
        assert_eq!(s.reserve, num(&c["reserve"]), "{name}");
        assert_eq!(s.net, num(&c["net"]), "{name}");
        let parts = c["parts"].as_array().unwrap();
        assert_eq!(s.parts.len() as usize, parts.len());
        for (i, p) in parts.iter().enumerate() {
            assert_eq!(s.parts.get(i as u32).unwrap(), num(p), "{name}");
        }
        assert_eq!(s.net + s.reserve, s.gross);
        assert!(s.net >= 0);
    }
}

#[test]
fn parts_always_add_up_and_net_is_never_negative() {
    let e = Env::default();
    let r = rule(&e, 10_000, &[("a", 6_000), ("b", 4_000)]);
    for g in [0i128, 1, 2, 3, 99, 100, 101, 1_000_003, i64::MAX as i128] {
        let s = split(&e, &r, g);
        assert_eq!(s.net + s.reserve, g);
        assert!(s.net >= 0 && s.reserve >= 0);
    }
}

#[test]
fn invalid_rules_are_refused() {
    let e = Env::default();
    assert_eq!(
        validate(&e, &rule(&e, 10_001, &[])),
        Err(RuleError::VatTooHigh)
    );
    assert_eq!(
        validate(&e, &rule(&e, 2100, &[("a", 6_000), ("b", 4_001)])),
        Err(RuleError::BucketsOverBase)
    );
    assert_eq!(
        validate(&e, &rule(&e, 2100, &[("a", 1), ("a", 2)])),
        Err(RuleError::DuplicateBucket)
    );
    assert_eq!(
        validate(&e, &rule(&e, 2100, &[("vat", 1)])),
        Err(RuleError::ReservedName)
    );
    let many: std::vec::Vec<(&str, u32)> = ["a", "b", "c", "d", "e", "f", "g", "h", "i"]
        .iter()
        .map(|n| (*n, 1))
        .collect();
    assert_eq!(
        validate(&e, &rule(&e, 0, &many)),
        Err(RuleError::TooManyBuckets)
    );
}

#[test]
fn periods_match_an_independent_calendar() {
    let v = vectors();
    for p in v["periods"].as_array().unwrap() {
        let ts: u64 = p["ts"].as_str().unwrap().parse().unwrap();
        for (kind, key) in [
            (PeriodKind::Month, "month"),
            (PeriodKind::Quarter, "quarter"),
            (PeriodKind::Year, "year"),
            (PeriodKind::Seconds(60), "seconds60"),
        ] {
            let want = &p[key];
            let id = period_of(&kind, ts);
            assert_eq!(id as u64, want["id"].as_u64().unwrap(), "{key} {ts}");
            assert_eq!(
                period_start(&kind, id).to_string(),
                want["start"].as_str().unwrap(),
                "{key} {ts}"
            );
            assert_eq!(
                period_end(&kind, id).to_string(),
                want["end"].as_str().unwrap(),
                "{key} {ts}"
            );
            assert!(period_start(&kind, id) <= ts && ts < period_end(&kind, id));
        }
    }
}

#[test]
fn civil_dates_round_trip() {
    for z in (-800_000i64..800_000).step_by(997) {
        let (y, m, d) = civil_from_days(z);
        assert_eq!(days_from_civil(y, m, d), z);
    }
}

use std::string::ToString;
