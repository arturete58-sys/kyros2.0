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

fn due_rule(r: &serde_json::Value) -> Due {
    let n = |v: &serde_json::Value, k: &str| v[k].as_u64().unwrap() as u32;
    if let Some(a) = r.get("after") {
        return Due::After(a.as_u64().unwrap());
    }
    if let Some(m) = r.get("monthDay") {
        return Due::MonthDay(MonthDay {
            months: n(m, "months"),
            day: n(m, "day"),
            exception_month: n(m, "exceptionMonth"),
            exception_months: n(m, "exceptionMonths"),
            exception_day: n(m, "exceptionDay"),
        });
    }
    let y = &r["yearDate"];
    Due::YearDate(YearDate {
        fy_start_month: n(y, "fyStartMonth"),
        fy_start_day: n(y, "fyStartDay"),
        month: n(y, "month"),
        day: n(y, "day"),
        years_after: n(y, "yearsAfter"),
    })
}

#[test]
fn n_month_periods_match_an_independent_calendar() {
    let v = vectors();
    for p in v["monthsPeriods"].as_array().unwrap() {
        let ts: u64 = p["ts"].as_str().unwrap().parse().unwrap();
        for n in [2u32, 4, 6] {
            let kind = PeriodKind::Months(n);
            let want = &p[std::format!("months{n}")];
            let id = period_of(&kind, ts);
            assert_eq!(id as u64, want["id"].as_u64().unwrap(), "months{n} {ts}");
            assert_eq!(
                period_start(&kind, id).to_string(),
                want["start"].as_str().unwrap()
            );
            assert_eq!(
                period_end(&kind, id).to_string(),
                want["end"].as_str().unwrap()
            );
        }
    }
    assert!(valid_period(&PeriodKind::Months(4)));
    assert!(!valid_period(&PeriodKind::Months(5)));
    assert!(!valid_period(&PeriodKind::Months(0)));
}

#[test]
fn due_dates_match_an_independent_calendar() {
    let v = vectors();
    let rules = &v["dueRules"];
    for d in v["dues"].as_array().unwrap() {
        let kind = match d["kind"].as_str().unwrap() {
            "Month" => PeriodKind::Month,
            "Quarter" => PeriodKind::Quarter,
            "Year" => PeriodKind::Year,
            k => PeriodKind::Months(k.trim_start_matches("Months").parse().unwrap()),
        };
        let rule = due_rule(&rules[d["rule"].as_str().unwrap()]);
        assert!(valid_due(&rule));
        let id = d["id"].as_u64().unwrap() as u32;
        assert_eq!(
            due_at(&kind, id, &rule).to_string(),
            d["due"].as_str().unwrap(),
            "{d}"
        );
    }
    assert!(!valid_due(&Due::YearDate(YearDate {
        fy_start_month: 13,
        fy_start_day: 1,
        month: 6,
        day: 30,
        years_after: 1
    })));
    assert!(!valid_due(&Due::MonthDay(MonthDay {
        months: 0,
        day: 0,
        exception_month: 0,
        exception_months: 0,
        exception_day: 0
    })));
    assert!(!valid_due(&Due::MonthDay(MonthDay {
        months: 0,
        day: 20,
        exception_month: 13,
        exception_months: 0,
        exception_day: 30
    })));
}

#[test]
fn civil_dates_round_trip() {
    for z in (-800_000i64..800_000).step_by(997) {
        let (y, m, d) = civil_from_days(z);
        assert_eq!(days_from_civil(y, m, d), z);
    }
}

use std::string::ToString;

#[test]
fn due_days_move_past_closed_days_and_holidays_like_an_independent_calendar() {
    let v = vectors();
    let cases = v["workdays"].as_array().unwrap();
    assert!(cases.len() >= 300);
    let mut moved = 0;
    for c in cases {
        let end: u64 = c["end"].as_str().unwrap().parse().unwrap();
        let hol: std::vec::Vec<u32> = c["holidays"]
            .as_array()
            .unwrap()
            .iter()
            .map(|d| d.as_u64().unwrap() as u32)
            .collect();
        let got = next_open(end, c["closed"].as_u64().unwrap() as u32, |d| {
            hol.contains(&d)
        });
        assert_eq!(got.to_string(), c["want"].as_str().unwrap(), "{c}");
        if got != end {
            moved += 1;
        }
    }
    assert!(moved > 100);
    // 1970-01-01 was a Thursday; 2027-01-30 a Saturday.
    assert_eq!(weekday(0), 3);
    assert_eq!(weekday(20_848), 5);
    // Sub-day offsets (seconds-based dues) keep their time of day.
    assert_eq!(
        next_open(5 * 86_400 + 60, 0b111_1111 & !1, |_| false),
        11 * 86_400 + 60
    );
}

/// A small deterministic generator, so the random cases repeat exactly.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn upto(&mut self, n: u64) -> u64 {
        self.next() % (n + 1)
    }
}

#[test]
fn every_split_adds_up_and_nothing_is_negative() {
    let e = Env::default();
    e.cost_estimate().budget().reset_unlimited();
    let mut g = Rng(0x9E37_79B9_7F4A_7C15);
    let names = ["a", "b", "c", "d", "e", "f"];
    for case in 0..20_000 {
        let vat = g.upto(BPS as u64) as u32;
        let mut left = BPS as u64;
        let mut buckets = Vec::new(&e);
        for n in names.iter().take(g.upto(MAX_BUCKETS as u64 - 1) as usize) {
            let bps = g.upto(left) as u32;
            left -= bps as u64;
            buckets.push_back(Bucket {
                name: Symbol::new(&e, n),
                bps,
            });
        }
        let r = Rule {
            vat_bps: vat,
            buckets,
        };
        assert!(validate(&e, &r).is_ok());
        let w = if case % 2 == 0 {
            0
        } else {
            g.upto(left) as u32
        };
        if !validate_withholding(&r, w) {
            continue;
        }
        // Up to 10^18 units: a trillion dollars in a 7-decimal token.
        let gross = match case % 4 {
            0 => g.upto(10) as i128,
            1 => g.upto(1_000_000) as i128,
            _ => g.upto(1_000_000_000_000_000_000) as i128,
        };
        let s = split_withheld(&e, &r, w, gross);
        let parts: i128 = s.parts.iter().sum();
        assert_eq!(s.net + s.reserve, gross, "case {case}");
        assert_eq!(s.reserve, s.vat + parts, "case {case}");
        assert!(
            s.net >= 0 && s.vat >= 0 && s.base >= 0,
            "case {case}: {s:?}"
        );
        assert!(s.parts.iter().all(|p| p >= 0), "case {case}");
        assert!(
            s.base * (BPS + vat as i128 - w as i128) / BPS <= gross,
            "case {case}"
        );
    }
}

#[test]
fn every_timestamp_falls_in_its_period_and_is_due_after_it() {
    let mut g = Rng(0xD1B5_4A32_D192_ED03);
    let kinds = [
        PeriodKind::Month,
        PeriodKind::Quarter,
        PeriodKind::Year,
        PeriodKind::Months(2),
        PeriodKind::Months(6),
    ];
    let dues = [
        Due::After(20 * 86_400),
        Due::MonthDay(MonthDay {
            months: 0,
            day: 20,
            exception_month: 7,
            exception_months: 1,
            exception_day: 20,
        }),
        Due::MonthDay(MonthDay {
            months: 1,
            day: 31,
            exception_month: 0,
            exception_months: 0,
            exception_day: 0,
        }),
        Due::YearDate(YearDate {
            fy_start_month: 4,
            fy_start_day: 6,
            month: 1,
            day: 31,
            years_after: 2,
        }),
    ];
    for _ in 0..20_000 {
        // From 1970 to 2100.
        let ts = g.upto(4_102_444_800);
        for k in kinds.iter() {
            let id = period_of(k, ts);
            assert!(
                period_start(k, id) <= ts && ts < period_end(k, id),
                "{k:?} {ts}"
            );
            for d in dues.iter() {
                assert!(due_at(k, id, d) >= period_end(k, id), "{k:?} {d:?} {ts}");
            }
        }
        // Fixed-length periods take only `After` (the vault refuses the rest).
        let k = PeriodKind::Seconds(86_400 * 7);
        let id = period_of(&k, ts);
        assert!(period_start(&k, id) <= ts && ts < period_end(&k, id));
        assert!(due_at(&k, id, &dues[0]) >= period_end(&k, id));
    }
}

#[test]
fn a_due_rule_that_would_overflow_the_clock_is_invalid() {
    // Before: `After(u64::MAX)` was valid and every due date it gave overflowed,
    // so release, invest and pay_tax failed for the whole vault.
    assert!(!valid_due(&Due::After(u64::MAX)));
    assert!(!valid_due(&Due::After(MAX_DUE_AFTER_SECS + 1)));
    assert!(valid_due(&Due::After(MAX_DUE_AFTER_SECS)));
}

#[test]
fn a_fixed_length_period_that_would_overflow_the_clock_is_invalid() {
    // Before: any length above zero; `Seconds(u64::MAX)` overflowed the period's end.
    assert!(!valid_period(&PeriodKind::Seconds(u64::MAX)));
    assert!(!valid_period(&PeriodKind::Seconds(MAX_PERIOD_SECS + 1)));
    assert!(!valid_period(&PeriodKind::Seconds(1)));
    assert!(valid_period(&PeriodKind::Seconds(60)));
    assert!(valid_period(&PeriodKind::Seconds(MAX_PERIOD_SECS)));
}
