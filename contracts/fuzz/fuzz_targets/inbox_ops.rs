//! Random sequences of operations on the inbox scenario
//! (`kyros_test_suites::scenarios::inbox`); every invariant is checked after
//! every step, and a broken one panics, which libFuzzer reports as a crash.
#![no_main]
use arbitrary::{Arbitrary, Unstructured};
use kyros_test_suites::scenarios::inbox::{Op, Run};
use libfuzzer_sys::fuzz_target;

/// Long enough to reach several fiscal periods, short enough to stay fast.
const MAX_OPS: usize = 60;

fuzz_target!(|data: &[u8]| {
    let mut u = Unstructured::new(data);
    let mut run = Run::new();
    for _ in 0..MAX_OPS {
        if u.is_empty() {
            break;
        }
        match Op::arbitrary(&mut u) {
            Ok(op) => run.apply(&op),
            Err(_) => break,
        }
    }
});
