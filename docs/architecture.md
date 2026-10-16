# Architecture

Four Soroban contracts hold every rule that touches money or rates. Everything off-chain (rule packs, keeper, indexer, web app) only suggests rules and shows balances; none of it holds funds or keys.

| Contract | Instances | Admin | Functions |
| --- | --- | --- | --- |
| Reserve Vault | one per user | none; the user is owner | `receive`, `quote`, `pay_tax`, `release`, `propose_rule`, `propose_rule_at`, `propose_destination`, `cancel`, `apply_pending`, `follow`, `unfollow`, reads |
| Router | one, shared | none, no storage | `pay`, `quote` |
| Inbox | one per user | none; moved only by the vault owner, with notice | `sweep`, `return_unaccepted`, `propose_vault`, `cancel_move` |
| Rate Registry | one per network | publisher (a multisig of rule-pack maintainers); holds no money | `seed`, `publish`, `withdraw`, `set_admin`, `rate`, `rate_at`, `schedule`, `min_notice` |

## Paying through the Router

The payer signs once. The vault applies the owner's rule and pulls both parts from the payer; either every transfer happens or none does.

```mermaid
sequenceDiagram
  participant P as Payer
  participant R as Router
  participant V as Reserve Vault
  participant T as Token (USDC SAC)
  participant O as Owner wallet
  P->>R: pay(from, vault, token, 1210, ref)
  R->>V: receive(from, token, 1210, ref)
  V->>V: split: net 800, VAT 210, income tax 200
  V->>T: transfer(from, owner, 800)
  T-->>O: +800
  V->>T: transfer(from, vault, 410)
  V-->>R: Split (event "received", period booked)
  R-->>P: Split (event "paid" with the invoice reference)
```

## Paying into the Inbox

The payer only needs a SEP-41 transfer (x402 payments, anchors, Soroban-aware wallets). Classic payment operations cannot target contract addresses; those payers use an invoice link instead.

```mermaid
sequenceDiagram
  participant P as Payer
  participant I as Inbox
  participant K as Keeper (anyone)
  participant V as Reserve Vault
  P->>I: SEP-41 transfer(payer, inbox, 121)
  K->>I: sweep(token)
  I->>V: quote(121)
  I->>I: authorize exactly two transfers for the vault
  I->>V: receive(inbox, token, 121, 0x00..)
  V-->>I: net 80 to the owner, reserve 41 in the vault
```

If no keeper runs, the money waits in the inbox, can only ever go to the owner and the vault, and anyone can sweep it. A token the vault does not accept goes back to the owner through `return_unaccepted`.

## One fiscal period in the vault

```mermaid
stateDiagram-v2
  [*] --> Accruing: first payment of the period
  Accruing --> Accruing: receive() adds to the buckets
  Accruing --> Locked: period ends
  Locked --> Locked: pay_tax() to the tax destination (allowed any time)
  Locked --> Releasable: due date = period end + due offset
  Releasable --> [*]: release() returns what is left to the owner
```

Periods come from the rule pack: calendar months, quarters or years in UTC (quarters for Spain, years where income tax is annual), or a fixed number of seconds (used by the testnet demo). The due date is the end of the period plus the pack's offset.

## Changes with notice

`propose_rule` and `propose_destination` record a change that takes effect after the vault's notice period; `propose_rule_at(rule, effective_at)` sets a later date, used to follow a scheduled VAT change: the owner signs ahead and the vault switches on the day the new rate applies, never before the notice has run; until then the old rule and destination apply, and the owner can `cancel`. Both the proposal and the change emit events, so the user, an accountant or the app sees a change coming. A stolen key therefore cannot redirect the reserve at once.

## VAT that follows the law

A vault can follow one rate in the Rate Registry (`follow(registry, country, rate, max_bps)`). From then on `quote` and `receive` read the registry's rate for that moment, and the user's reserves stay as they are. When the law changes, the registry entry's date is the day the vault changes, with no signature.

```mermaid
sequenceDiagram
  participant M as Maintainers (multisig)
  participant R as Rate Registry
  participant V as Reserve Vault (follows ES/standard)
  participant C as Client
  M->>R: publish(ES, standard, from = legal date, 2200)
  Note over R: refused if from < now + min_notice
  C->>V: pay before the date: 21%
  C->>V: pay from the date: 22%, no owner action
```

The contract checks:
- `follow` is refused unless the registry's `min_notice` is at least the vault's notice. It is also refused unless the registry's rate today equals the vault's VAT, so following changes nothing on day one.
- A rate above the owner's `max_bps` is ignored, and the vault keeps its own rule.
- `unfollow` applies at once and keeps the VAT in force as the vault's own.
- In the registry, entries that have started to apply cannot be edited or withdrawn.

## Moving country

`propose_vault(new_vault)` on the inbox needs the vault owner's signature, and the new vault must belong to the same owner. The move takes effect after the current vault's notice, and `cancel_move` withdraws it until then. The payment address stays the same. The old vault keeps its reserves, pays the old country's taxes from them and releases the rest on its own due dates. No locked money moves between vaults.

## Storage

- Instance: config (owner, rule, tax destination, notice, period kind, due offset, accepted tokens) and pending changes. Extended on every write.
- Persistent, one entry per period and token: reserve per bucket, total reserved, paid to the tax destination, released. Extended on every write, to about 13 months.

## Errors

`InvalidRule`, `InvalidAmount`, `TokenNotAccepted`, `NotDue`, `NothingToRelease`, `ExceedsReserve`, `NoPendingChange`, `ChangeNotReady`, `UnknownBucket`, `NoTokens`, `AlreadyInForce`, `NotFollowing`, `RegistryNoticeTooShort`, `UnknownRate`, `RateMismatch` (vault); `NothingToSweep`, `TokenAccepted`, `NotSameOwner`, `NoPendingMove`, `AlreadyMoved` (inbox); `TooSoon`, `InvalidRate`, `AlreadyInForce`, `NotFound`, `AlreadySeeded`, `TooManyEntries` (registry).

## Security notes

- No admin keys over money and no upgrade path. A new version is a new contract the owner moves to by choice. The Rate Registry has a publisher but holds no money; it can only change the VAT of vaults that chose to follow it, never sooner than its fixed notice, never above each owner's ceiling, and owners can stop following at any time.
- Integer arithmetic in 128 bits; every bucket rounds down and the remainder goes to the net amount, so the parts always add up to the gross. Shared test vectors check the same results in Rust and TypeScript.
- Each vault accepts an allow-list of tokens (USDC and EURC Stellar Asset Contracts).
- The inbox authorizes only the two transfers the vault needs for a given sweep, with exact amounts and recipients.
- Not audited yet.
