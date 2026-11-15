# Fuzz targets

Coverage-guided fuzzing of the Kyros contracts with
[cargo-fuzz](https://github.com/rust-fuzz/cargo-fuzz) (libFuzzer). It runs
every night in `.github/workflows/nightly-fuzz.yml`; a crash is uploaded
with its minimized input, and the corpus is kept between nights.

| Target | What the fuzzer controls | What must hold |
| --- | --- | --- |
| `split` | Any valid rule, any gross from 0 to `i128::MAX` | The split never fails, adds up exactly, rounds as documented |
| `cctp_message` | Raw bytes, or a valid CCTP V2 message with bytes changed or cut | The parser accepts or refuses with its own error code; it never traps |
| `vault_ops` | Sequences of payments, deposits, tax payments, releases, corrections, donations, yield and time | The vault's eight invariants after every step |
| `router_ops` | Payments and payroll runs to three vaults, one refusing the token | Every unit accounted for; refused calls move nothing |
| `inbox_ops` | Payments, junk tokens, sweeps, returns, moves (including to a stranger's vault) | Conservation; the Inbox follows only the owner's vaults, after notice |
| `registry_ops` | Publications (0%, 100%, out of range, too soon), withdrawals, time | History final, notice held, the following vault's VAT right |

The operation targets drive the scenarios in
`contracts/test-suites/src/scenarios`, the same ones proptest runs on every
CI run, so an invariant is written once and checked both ways.

```sh
rustup toolchain install nightly
cargo install cargo-fuzz
cd contracts/fuzz
cargo +nightly fuzz run --sanitizer none vault_ops -- -max_total_time=300
```

`--sanitizer none`: the code is safe Rust, so the time goes to new inputs
rather than to memory checks.
