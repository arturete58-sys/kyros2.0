//! Stateful scenarios: each contract driven by a sequence of operations,
//! with its invariants checked after every step. The same scenarios run
//! under proptest (`tests/`, every CI run) and under libFuzzer
//! (`contracts/fuzz`, nightly): `Arbitrary` turns fuzz input into operations.
pub mod inbox;
pub mod registry;
pub mod router;
pub mod vault;
