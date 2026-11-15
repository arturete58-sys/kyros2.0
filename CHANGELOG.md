# Changelog

All notable changes to the Kyros contracts, SDK and app are recorded here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the contracts follow [Semantic Versioning](https://semver.org/): a
removed or changed public function, event or error code is a major version;
error codes are only ever appended. Each release's wasm hashes and build
attestations are on its [GitHub Release](https://github.com/arturete58-sys/kyros2.0/releases).

## [Unreleased]

## [0.1.0] - 2026-11-15

First versioned release of the contracts, on Stellar testnet. Not audited
yet; not deployed on mainnet.

### Contracts

- **Reserve Vault** (one per user, owned by the user, no admin): splits each
  payment as it arrives into the net amount (to the payout address) and the
  tax reserve (VAT and up to eight buckets), locks each bucket until its due
  date, pays the tax destination at any time (`pay_tax`, `pay_tax_to` with a
  muxed memo, scheduled payments anyone can run), and releases to the owner
  after the due date. Invoice and payer terms (withholding, reverse charge,
  clients abroad), fixed amounts per period, reserve deposits, corrections
  with notice, due dates set by the tax office, weekends and holidays from
  the registry. Opt-in: conversion to the tax's currency through a swapper
  at no less than the oracle price, and yield through a strategy capped at
  the owner's share and kept clear of reserve due within 14 days.
- **Router** (shared): pays a vault inside the payer's own transaction;
  `pay_many` for payroll runs, all or nothing.
- **Inbox** (one per user): a plain payment address anyone can sweep through
  the vault; moved to another vault of the same owner only with notice.
- **CCTP receiver** (shared): mints USDC burned on another chain (Circle
  CCTP V2) and pays it into a vault in the same call.
- **Rate Registry** (one per network): dated VAT rates and public holidays,
  published at least a notice period ahead; history is final.
- **Adapters**: Soroswap swapper, Blend v2 yield strategy, Ondo USDY yield
  strategy (built, not deployed).

### Interfaces

- Vault errors 1-42. Arithmetic: `MathOverflow` (40), `DivisionByZero`
  (41). Settings: `InvalidNotice` (42, notice above a year), `CannotHold`
  (39, an address without the trustline).
- Inbox errors 1-7 (`MathOverflow` = 7); CCTP receiver errors 1-9 (`BadSplit`
  = 8, `MathOverflow` = 9); Ondo adapter `MathOverflow` (5),
  `DivisionByZero` (6); Blend adapter `MathOverflow` (2).
- Vault events, grouped by area, all typed (`#[contractevent]`), including
  `InvoiceForgotten`, `PayerForgotten`, `CorrectionCancelled`, `Divested`,
  `StrategyStopping`.
- `quote`, `quote_for`, `quote_in`, `position` and `due_soon` return a
  `Result` (a value that cannot be represented is `MathOverflow`); their
  successful results are unchanged on the wire.
- Every wasm carries `Description` and `Source` metadata; release builds
  add `version` and `source_repo` (SEP-0055).

### Security

Five internal review passes ([docs/security-review.md](docs/security-review.md)),
each finding reproduced by a test before it was fixed:

- Arithmetic is checked everywhere money moves, ratios are taken in 256 bits,
  and unchecked arithmetic is a build error (`clippy::arithmetic_side_effects`
  denied workspace-wide). Fixed: the conversion floor overflowed for large
  reserves between currencies of different decimals.
- Yield: the strategy is kept at the owner's share as the reserve shrinks or
  comes due (found by the stateful property test); earnings come out of the
  strategy, never out of the reserve the vault holds; a strategy that cannot
  pay out can still be stopped.
- Payout addresses, tax destinations and new tokens are refused when they
  cannot receive the tokens; notice capped at a year; books before
  transfers; tracked open periods recover after an overflow of the list.
- Every call fits mainnet's resource limits, measured in tests; shared
  entries are kept alive by a keeper and never extended past the network
  maximum.

### Testing and tooling

- Adversarial suites for every contract (`contracts/test-suites`), one test
  per threat in [docs/threat-model.md](docs/threat-model.md); stateful
  property tests for the vault, Router, Inbox and Registry; corrupted
  cross-chain messages for the CCTP receiver.
- Nightly coverage-guided fuzzing (cargo-fuzz) of the same scenarios, the
  split arithmetic and the CCTP message parser.
- Mutation testing (cargo-mutants) weekly and on every pull request.
- Coverage of the contract code in CI, with a floor; RustSec advisories.
- Verifiable releases: pinned toolchain, SHA-256 manifest and GitHub build
  provenance for every wasm.

[Unreleased]: https://github.com/arturete58-sys/kyros2.0/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/arturete58-sys/kyros2.0/releases/tag/v0.1.0
