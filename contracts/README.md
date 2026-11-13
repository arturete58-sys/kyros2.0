# Kyros contracts

Soroban contracts for Kyros, written in Rust with `soroban-sdk` 28. Each user
gets their own Reserve Vault: every payment is split as it arrives, the net
amount goes to the user and the tax reserve stays locked until the tax is
due. There is no admin key over money and no upgrade path. A new version is a
new contract the owner moves to by choice.

The full design, with sequence diagrams, is in
[docs/architecture.md](../docs/architecture.md). The review history, with
every issue found and the test that reproduces it, is in
[docs/security-review.md](../docs/security-review.md).

## Workspace

| Crate | Instances | Role | Holds money | Privileged role |
| --- | --- | --- | --- | --- |
| `types` | library | Split arithmetic, fiscal calendar, cross-contract interfaces. Pure functions, no storage | — | — |
| `reserve-vault` | one per user | Splits payments, locks the reserve until each tax is due, pays the tax office | yes | the owner (the user) |
| `inbox` | one per user | A plain payment address; anyone sweeps it through the vault | between a payment and its sweep | none (the vault's owner can move it, with notice) |
| `router` | one, shared | Splits a payment inside the payer's own transaction; payroll runs | no | none |
| `cctp-pay` | one, shared | Mints USDC burned on another chain (Circle CCTP V2) and pays it into a vault in the same call | no | none |
| `rate-registry` | one, shared | Dated VAT rates and public holidays, published with notice | no | a publisher multisig; it cannot move money |
| `swap-soroswap` | one, shared | `SwapApi` over the Soroswap router, used for converting the reserve | no (nothing between calls) | none |
| `yield-blend` | one per vault | `YieldApi` over a Blend v2 pool: plain supply, never borrows | the lent reserve | the vault |
| `yield-ondo` | one per vault | `YieldApi` holding Ondo USDY. Not deployed (USDY eligibility) | the invested reserve | the vault |

Contracts only call each other through the traits in `types`
(`VaultApi`, `RegistryApi`, `YieldApi`, `SwapApi`, `OracleApi`), so any
adapter that implements the trait can be plugged in. Plugging one into a
vault always waits for that vault's notice.

## The Reserve Vault, module by module

| Module | Contents |
| --- | --- |
| `lib.rs` | Crate docs, contract metadata, constructor |
| `types`, `error`, `events` | Public interface: stored data and limits, `VaultError` (stable codes), events grouped by area |
| `storage` | Ledger keys, TTLs, the configuration in force, period books, open-period tracking |
| `terms` | How a payment splits: rule, invoice terms, payer terms, fixed amounts |
| `calendar` | Due dates, weekends and holidays, dates set by the tax office |
| `money_in`, `money_out` | `receive`, `deposit`; `pay_tax`, `pay_tax_to`, `release` |
| `scheduled`, `corrections` | Payments on a date anyone can run; reserve taken back after notice |
| `changes` | Every change that waits out the notice (propose, apply, cancel); VAT that follows the registry |
| `conversion`, `strategy` | Opt-in currency conversion and yield |
| `reads` | Read-only entry points |
| `internal` | Steps shared by the entry points (paying out, applying changes) |

Each module adds its own `#[contractimpl]` block to the one `ReserveVault`
contract, so the exported interface is the union of all of them.

## What the vault guarantees

Each line is enforced on-chain and covered by tests in `reserve-vault/src/test.rs`.

- **The lock.** A bucket's reserve goes back to the owner (`release`) only
  after its due date, moved past weekends and holidays. Before that it can
  only go to the registered tax destination.
- **Notice.** Every change that could redirect the reserve (rule,
  destination, payout address, fixed amounts, new tokens, swapper and oracle,
  yield strategy, corrections, an earlier due date) waits `notice_secs`.
  Stopping a conversion or a strategy, unfollowing the registry and
  cancelling a pending change apply at once, because they can only make the
  vault safer.
- **Exact splits.** Integer arithmetic in `i128` with `overflow-checks` on in
  release builds. Every bucket rounds down, the remainder goes to the net
  amount, and `net + reserve = gross` always. The same vectors
  (`test-vectors/vectors.json`) are checked in Rust and in the TypeScript SDK,
  plus 20,000 random cases per property.
- **Liquidity.** Reserve due within 14 days is kept in the vault, never
  lent. The strategy never holds more than the owner's share (`max_bps`) of
  the reserve that is not due soon: `invest` brings the excess back when
  payments shrink the reserve. Earnings are paid out of the strategy
  (`harvest`), never out of the reserve the vault holds.
- **Conversion floor.** A swap must return at least the oracle price minus
  the owner's tolerance (at most 5%), from a price no older than the owner's
  limit.
- **Recipients that can receive.** A payout address must hold every accepted
  token, a destination at least one, and a new token must be receivable by
  the payout address. Otherwise a missing trustline would block every payment.

## Soroban specifics

- **Storage classes.** The configuration and small bounded lists (pending
  changes, scheduled and correction ids) live in instance storage, which is
  read on every call anyway. Period books, invoices, payers and due dates live
  in persistent storage, one entry each, so no call reads more than it needs.
  Nothing uses temporary storage: none of it may disappear.
- **TTL.** Entries are extended when written, to about six months (the
  network maximum), and again when less than half of that is left
  (`TTL_EXTEND_TO`, `TTL_THRESHOLD` in `types`). Each vault and inbox
  extends its own instance only. The shared wasm and the shared contracts are
  kept alive by a daily keeper (`sdk/src/ttl.ts`) that anyone can run. Since
  Protocol 23 an archived entry is restored by the transaction that needs it.
- **Network limits.** `soroban-sdk` 28 enforces mainnet resource limits in
  tests. The heaviest vault is measured: 36 open months with 8 buckets and
  holidays from the registry. Its heaviest call, `invest`, touches 84 of the
  400 ledger entries a transaction may use, and the test fails above 120. A payroll run through
  the Router fits 8 payments in the 16 KB event limit, and the SDK splits
  larger runs.
- **Authorization.** The vault requires its owner's signature for everything
  that moves money out, except the steps anyone may trigger, which can only
  pay the tax destination, pay the owner what the notice already allowed, or
  move reserve between the vault and what the owner chose (`run_scheduled`,
  `apply_correction`, `convert`, `invest`). Contracts that move a user's tokens on the
  vault's behalf (inbox, CCTP receiver, swapper, Blend adapter) call
  `authorize_as_current_contract` with the exact sub-invocations: token,
  function, recipient and amount. Nothing broader.
- **Muxed addresses.** `pay_tax_to` pays the destination as a muxed account
  (CAP-67), so an anchor can match the payment by its memo id.
- **Events.** Every change and every movement of money publishes a typed
  `#[contractevent]` with indexed topics, so apps and keepers filter by kind
  through the RPC.
- **Errors.** `#[contracterror]` enums with fixed numeric codes. Codes are
  never renumbered; new ones are appended.
- **Metadata.** Each wasm carries `contractmeta!` entries (`Description`,
  `Source`) for explorers and verifiers.

## Building and testing

```sh
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
RUSTDOCFLAGS="-D warnings" cargo doc --workspace --no-deps
cargo test                 # mainnet resource limits enforced
stellar contract build     # wasm32v1-none, release profile
```

CI runs all of these on every push and fails if any wasm exceeds the
network's 128 KiB contract size limit. A second workflow deploys the
contracts to testnet and runs the end-to-end demo (`sdk/src/demo/testnet.ts`). Integration tests run against the real
Soroswap and Blend wasm builds in `vendor/`.

## External contracts

| Contract | Used by | What Kyros trusts it for |
| --- | --- | --- |
| Stellar Asset Contracts (USDC, EURC) | all | Token balances and transfers |
| Soroswap router and pairs | `swap-soroswap` | Executing the swap; the vault checks the result against its own floor |
| Reflector (SEP-40) | vault conversion | Prices; stale or missing prices stop the swap |
| Blend v2 pool | `yield-blend` | Holding the lent reserve; bad debt is covered first by its backstop |
| Circle MessageTransmitter, TokenMessengerMinter | `cctp-pay` | Attestations and minting; the vault and reference come from the signed burn |

Not audited yet.
