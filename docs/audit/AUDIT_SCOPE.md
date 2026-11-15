# Kyros: audit scope

Prepared for an external security audit of the Kyros Soroban contracts
(Stellar Community Fund Audit Bank). Everything an auditor needs to start
is here or linked from here.

## 1. What is audited

| Item | Value |
| --- | --- |
| Repository | https://github.com/arturete58-sys/kyros2.0 |
| Commit | `FREEZE_COMMIT` (set when the audit is booked: the commit of tag `vFREEZE_VERSION`) |
| Release | `vFREEZE_VERSION`, with wasm files, `SHA256SUMS` and build attestations |
| Language | Rust, edition 2021, `#![no_std]` |
| Rust toolchain | 1.97.0 (pinned in `.github/workflows/release.yml`) |
| Soroban SDK | `soroban-sdk` 28.0.0 |
| Stellar CLI | 28.1.0 |
| Target | `wasm32v1-none`, release profile: `opt-level = "z"`, `lto`, `overflow-checks = true`, `panic = "abort"` |
| Network | Stellar testnet today; mainnet after the audit |

To reproduce the audited wasm from the frozen commit:

```sh
cd contracts
stellar contract build --meta source_repo=github:arturete58-sys/kyros2.0 --meta version=FREEZE_VERSION
sha256sum target/wasm32v1-none/release/*.wasm   # compare with the release's SHA256SUMS
gh attestation verify target/wasm32v1-none/release/kyros_reserve_vault.wasm --repo arturete58-sys/kyros2.0
```

## 2. Contracts in scope

Lines are non-blank, non-comment lines of contract code, tests excluded.
Wasm hashes are those of the release build at the frozen commit; the values
below are from the release workflow's dry run on `main` at `01bd1b2`
(2026-11-15, version 0.1.0) and are replaced by the tagged release's.

| Contract | Path | Lines | Wasm SHA-256 | What it does |
| --- | --- | --- | --- | --- |
| Reserve Vault | `contracts/reserve-vault` | 2,258 | `053aeca32f46f2ef2b5ae7609ca335b3c3f71e08a83b67ff085d1e9b60088540` | One per user. Splits each payment into net and reserve, locks each tax bucket until its due date, pays the tax destination, releases to the owner after the due date; invoice and payer terms, fixed amounts, deposits, corrections, scheduled payments, registry-followed VAT, opt-in conversion and yield. All settings that could redirect the reserve wait a notice period. |
| Shared types | `contracts/types` | 437 | (library) | Checked 256-bit arithmetic, the split, the fiscal calendar (periods, due dates, weekends, holidays), and the traits the contracts call each other through. |
| Router | `contracts/router` | 83 | `bbac4c284cbb3ed5a40303bdca9d4ac7918d4ec0f397bfd1d5ebbb6e99123d0c` | Pays a vault inside the payer's transaction; `pay_many` for payroll runs, all or nothing. Stateless. |
| Inbox | `contracts/inbox` | 207 | `f8f40b28d1c856a2c98be3047f63c011e8ccad8b4aff46a71508642726f7dc89` | One per user. A payment address anyone can sweep through its vault; moved to another vault of the same owner only with notice. |
| CCTP receiver | `contracts/cctp-pay` | 222 | `60a16826c153618d41c52e81a1256b39c61012369b8c97097c4797137c9331d4` | Receives a Circle CCTP V2 message, mints the USDC and pays it into the vault named in the hook data, in one call. Holds nothing between calls. |
| Rate Registry | `contracts/rate-registry` | 316 | `d1eae744af2edc78d877d800a64b8367e22ce83677c5d57e011b31fc5ace595f` | Dated VAT rates and public holidays, published by a multisig at least a notice period ahead. Moves no money. |
| Soroswap swapper | `contracts/swap-soroswap` | 86 | `bdd193fe15e97dc3d9b02016e87e63301712f22e394bdbcf88dc7bf982ffab44` | `SwapApi` over the Soroswap router, for the vault's conversion. Holds nothing between calls. |
| Blend yield strategy | `contracts/yield-blend` | 145 | `d9bfb98e027d04067ab7f81f66c12808969efba2e60a192c79ef91f1a2755de5` | One per lending vault. Supplies to a Blend v2 pool, never borrows; only its vault moves funds. |
| **Total** | | **3,754** | | |

### Out of scope

| Item | Why |
| --- | --- |
| `contracts/yield-ondo` (185 lines) | Built and tested, not deployed (USDY eligibility). Can be added. |
| `contracts/test-suites`, `contracts/fuzz`, every `src/test.rs` | Tests, mocks and fuzz targets. Useful to the auditor; not deployed. |
| `contracts/vendor` | Soroswap and Blend wasm builds, used only in integration tests. |
| `sdk/`, `app/`, `plugins/`, `rule-packs/` | Off-chain. They hold no keys of users and no funds; they build transactions the user signs. A separate review can cover them. |
| Third-party contracts | Circle CCTP, Reflector, Soroswap, Blend, Stellar Asset Contracts: see trust assumptions. |

## 3. Roles and privileges

| Role | Who | Can | Cannot |
| --- | --- | --- | --- |
| Vault owner | The user (a wallet or a passkey smart wallet) | Pay tax; release due buckets; change settings with notice; cancel pending changes; stop conversion and yield at once; register invoice and payer terms; set due dates (later at once, earlier with notice) | Take reserve before its due date except by a correction that waits the notice; act on another user's vault |
| Registry publisher | A multisig of rule-pack maintainers | Publish and withdraw future rates and holidays; rotate itself (`set_admin`) | Move money; change a rate sooner than the registry's notice; change a rate in force or past |
| Payer | Anyone paying a user | Sign one payment of one amount | Choose their own terms; pay less tax than the vault's rule says |
| Keeper | Anyone | Sweep an Inbox; run due scheduled payments; apply corrections whose notice passed; convert; rebalance yield; extend TTLs | Choose any recipient: these calls pay the tax destination, the owner, or the vault's own strategy |
| CCTP relayer | Anyone | Submit an attested CCTP message to the receiver | Change the vault, amount or reference: they come from the signed burn |
| Kyros (the project) | — | Nothing on-chain | Move, freeze or upgrade any vault; there is no admin key and no upgrade path ([migration.md](../migration.md)) |

## 4. Threat model

The full model, one test per threat, is [docs/threat-model.md](../threat-model.md).
The guarantees an audit should try to break:

1. **The lock.** No reserve reaches anyone but the tax destination before
   its bucket's due date (moved past weekends and holidays), except by a
   correction that waited the notice.
2. **The notice.** Every change that could redirect the reserve waits
   `notice_secs` and can be cancelled until then.
3. **Exact splits.** `net + reserve = gross` for every payment; every bucket
   gets exactly what the rule (or the invoice's or payer's terms) gives,
   rounded down by less than one unit, VAT never rounded down.
4. **Conservation.** The vault and its strategy hold at least `held`;
   `held` is the sum of every bucket; each period balances.
5. **Least authority across contracts.** Contracts that move a user's tokens
   for the vault authorize exactly the transfers of the split, nothing more.
6. **Liveness.** No one can make a vault unusable: every list is capped,
   each call stays within mainnet's resource limits, a refused call changes
   nothing.

## 5. Trust assumptions

| Component | Trusted for | If it misbehaves |
| --- | --- | --- |
| Stellar network and Soroban host | Authorization, atomicity, refusing re-entry, state archival and automatic restore | Out of Kyros's control |
| Stellar Asset Contracts (USDC, EURC) | Balances and transfers; issuer controls (freeze, clawback) apply as the issuer sets them | An issuer freeze blocks the reserve; accepted for regulated assets |
| Circle CCTP V2 (MessageTransmitter, TokenMessengerMinter) | Attestation checks, nonces (replay), minting | A forged attestation would mint; Kyros checks recipient, caller and hook format |
| Reflector (SEP-40 oracle) | Prices for conversion | Stale or missing prices stop conversion; a wrong price is bounded by the owner's slippage limit (at most 10%) |
| Soroswap | Executing swaps | The vault checks what arrived against its own floor |
| Blend v2 pool | Holding lent reserve | Bad debt or a frozen pool: reserve due within 14 days stays in the vault; the owner stops the strategy at once |
| GitHub Actions and attestations | Building and attesting releases | A compromised pipeline could attest a bad build; the build is reproducible from the commit |

## 6. Known and accepted risks

| Risk | Why it is accepted |
| --- | --- |
| A stolen owner key can redirect the reserve after the notice period | The notice is the defence: the guardian alerts the user, who cancels. Passkey smart wallets make key theft harder. |
| The strategy, swapper and oracle chosen by the owner can lose what they are given | Each is the owner's choice, with notice; reserve due soon is never lent; stopping is immediate. |
| A CCTP message whose hook names something that is not a vault can never be paid in through the receiver | The whole call reverts and nothing is minted. If someone then redeems that message at Circle directly, the USDC lands in the receiver and stays there (it has no admin to return it). The SDK builds the hook from the vault's address, so this needs a payer to send a malformed burn. |
| Rounding leaves less than one unit per bucket per payment out of the reserve | 10^-7 of a dollar for a Stellar asset; VAT itself is never rounded down. |
| `RUSTSEC-2026-0387` (crypto-bigint timing) in the dependency graph | Only the native test host uses it; CI fails if it ever reaches the wasm. |
| No upgrade path | A choice: a bug is fixed by a new version the owner moves to ([migration.md](../migration.md)). |

## 7. What has been done already

| Item | Where |
| --- | --- |
| Five internal review passes, each finding reproduced by a test before its fix | [docs/security-review.md](../security-review.md) |
| Threat model, invariants, rounding table | [docs/threat-model.md](../threat-model.md) |
| Architecture, storage choices, Soroban specifics | [docs/architecture.md](../architecture.md), [contracts/README.md](../../contracts/README.md) |
| Unit and integration tests under mainnet resource limits | each crate's `src/test.rs` |
| Adversarial suites and stateful property tests for every contract | `contracts/test-suites/tests` |
| Coverage-guided fuzzing, nightly | `contracts/fuzz`, `.github/workflows/nightly-fuzz.yml` |
| Mutation testing, weekly and on pull requests | `contracts/.cargo/mutants.toml`, `.github/workflows/mutants.yml` |
| Coverage of the contract code (lines) | CI summary and badge; floor of 90% |
| Unchecked arithmetic denied at compile time | `contracts/Cargo.toml` (`[workspace.lints.clippy]`) |
| End-to-end demo on testnet, daily | [docs/testnet/README.md](../testnet/README.md) |

## 8. Questions we would like answered

1. Can any sequence of calls, by anyone other than the owner, move reserve
   to anyone but the tax destination before its due date?
2. Can the owner's notice be bypassed or shortened (including through
   `set_due`, `propose_rule_at`, the registry, or a token added with notice)?
3. Are the authorization trees built with `authorize_as_current_contract`
   (Inbox, CCTP receiver, Blend adapter) as narrow as intended?
4. Is the split exact and the rounding as documented for every rule the
   validation accepts, including invoice terms with withholding?
5. Can a vault be made unusable (resource limits, archival, list caps)?

## 9. Contact

Security reports and audit coordination: the repository's private
vulnerability reporting ([SECURITY.md](../../SECURITY.md)).
