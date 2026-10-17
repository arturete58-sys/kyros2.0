#![cfg(test)]
use super::*;
use soroban_sdk::{
    symbol_short,
    testutils::{Address as _, Ledger},
    vec, Env,
};

const T0: u64 = 1_790_000_000;
const NOTICE: u64 = 7 * 86_400;

fn setup() -> (Env, RateRegistryClient<'static>) {
    let e = Env::default();
    e.mock_all_auths();
    e.ledger().set_timestamp(T0);
    let id = e.register(RateRegistry, (Address::generate(&e), NOTICE));
    let c = RateRegistryClient::new(&e, &id);
    (e, c)
}

#[test]
fn rates_follow_their_dates() {
    let (e, r) = setup();
    let (th, std) = (symbol_short!("TH"), symbol_short!("standard"));
    r.seed(&th, &std, &700);
    assert_eq!(r.rate(&th, &std), Some(700));
    let change = T0 + 30 * 86_400;
    r.publish(&th, &std, &change, &1000);
    assert_eq!(r.rate_at(&th, &std, &(change - 1)), Some(700));
    assert_eq!(r.rate_at(&th, &std, &change), Some(1000));
    assert_eq!(
        r.schedule(&th, &std),
        vec![
            &e,
            Entry { from: T0, bps: 700 },
            Entry {
                from: change,
                bps: 1000
            }
        ]
    );
    assert_eq!(r.rate(&symbol_short!("XX"), &std), None);
}

#[test]
fn nothing_applies_sooner_than_the_notice_and_history_is_final() {
    let (e, r) = setup();
    let (ch, std) = (symbol_short!("CH"), symbol_short!("standard"));
    r.seed(&ch, &std, &810);
    assert_eq!(
        r.try_seed(&ch, &std, &900),
        Err(Ok(RegistryError::AlreadySeeded))
    );
    assert_eq!(
        r.try_publish(&ch, &std, &(T0 + NOTICE - 1), &850),
        Err(Ok(RegistryError::TooSoon))
    );
    assert_eq!(
        r.try_publish(&ch, &std, &(T0 + NOTICE), &10_001),
        Err(Ok(RegistryError::InvalidRate))
    );
    // A future entry can be corrected or withdrawn (a reform voted down) ...
    let d = T0 + 60 * 86_400;
    r.publish(&ch, &std, &d, &850);
    r.publish(&ch, &std, &d, &840);
    assert_eq!(r.schedule(&ch, &std).len(), 2);
    assert_eq!(r.rate_at(&ch, &std, &d), Some(840));
    r.withdraw(&ch, &std, &d);
    assert_eq!(r.rate_at(&ch, &std, &d), Some(810));
    // ... but once it applies it stays.
    r.publish(&ch, &std, &d, &850);
    e.ledger().set_timestamp(d);
    assert_eq!(
        r.try_withdraw(&ch, &std, &d),
        Err(Ok(RegistryError::AlreadyInForce))
    );
    assert_eq!(
        r.try_publish(&ch, &std, &d, &900),
        Err(Ok(RegistryError::TooSoon))
    );
}

#[test]
fn only_the_publisher_writes() {
    let e = Env::default();
    e.ledger().set_timestamp(T0);
    let id = e.register(RateRegistry, (Address::generate(&e), NOTICE));
    let r = RateRegistryClient::new(&e, &id);
    assert!(r
        .try_seed(&symbol_short!("ES"), &symbol_short!("standard"), &2100)
        .is_err());
}

// 2026-12-25 and 2027-01-01, as day numbers.
const XMAS_2026: u32 = 20_812;
const NY_2027: u32 = 20_819;

#[test]
fn holidays_are_set_before_their_year_and_only_added_after() {
    let (e, c) = setup();
    let es = symbol_short!("ES");
    // T0 is in 2026: 2026 has no list yet, so it can be seeded once.
    c.set_holidays(&es, &2026, &vec![&e, XMAS_2026]);
    assert_eq!(c.holidays(&es, &2026), vec![&e, XMAS_2026]);
    assert_eq!(
        c.try_set_holidays(&es, &2026, &vec![&e]),
        Err(Ok(RegistryError::YearStarted))
    );
    // 2027 can be replaced until it starts.
    c.set_holidays(&es, &2027, &vec![&e, NY_2027]);
    c.set_holidays(&es, &2027, &vec![&e, NY_2027, NY_2027 + 5]);
    assert_eq!(c.holidays(&es, &2027).len(), 2);
    // A day outside the year is refused.
    assert_eq!(
        c.try_set_holidays(&es, &2027, &vec![&e, XMAS_2026]),
        Err(Ok(RegistryError::InvalidHolidays))
    );
    // A holiday declared during the year can be added, never a past one.
    let today = (T0 / 86_400) as u32;
    c.add_holiday(&es, &(today + 3));
    assert!(c.holidays(&es, &2026).contains(today + 3));
    assert_eq!(
        c.try_add_holiday(&es, &today),
        Err(Ok(RegistryError::AlreadyInForce))
    );
    assert!(c.holidays(&symbol_short!("PT"), &2026).is_empty());
}
