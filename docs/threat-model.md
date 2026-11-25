# Kyros threat model

What the contracts protect, from whom, and the test that shows each threat
is handled. The adversarial suites live in
[`contracts/test-suites/tests`](../contracts/test-suites/tests); the review
history is in [security-review.md](security-review.md).

## What is at stake

| Asset | Where it lives | Who may move it |
| --- | --- | --- |
| The tax reserve (each bucket of each period) | The user's Reserve Vault, or lent through the strategy the owner chose | The tax destination, at any time (`pay_tax`, `run_scheduled`); the owner, only after the bucket's due date (`release`) or after notice (`apply_correction`) |
| The net amount of each payment | Goes straight to the payout address in the payer's transaction | Nobody else, ever |
| The vault's rules (rule, destination, payout address, tokens, strategy, conversion, due dates) | Instance storage | The owner, after the notice period |
| Earnings above the reserve | Vault or strategy | The owner (`harvest`) |

## Actors and trust

| Actor | Trusted for | Not trusted for |
| --- | --- | --- |
| Owner | Choosing the rules, the strategy, the swapper and the oracle (each with notice) | Taking reserve before it is due |
| Payer | Signing the amount they pay | Choosing their own terms, or paying less tax than the rule says |
| Anyone (keepers, bots) | Triggering the steps the owner already decided | Moving money anywhere else |
| Token contracts | Balances and transfers of accepted tokens | Calling back into the vault |
| Strategy, swapper, oracle | What the owner chose them for | Their reported figures beyond what the vault checks |
| Network (Soroban host) | Authorization, atomicity, refusing re-entry, archival rules | — |

## Threats and how they are handled

### Economic and accounting

| # | Threat | Handling | Test |
| --- | --- | --- | --- |
| E1 | Donation / first-deposit inflation: tokens sent straight to the vault to skew the books | No shares exist: the books count only what `receive` and `deposit` booked. A surplus goes only to the owner via `harvest` | `economic::a_donation_changes_no_books_and_only_the_owner_can_take_it` |
| E2 | Dust: splitting a payment into one-unit pieces to dodge the tax through rounding | VAT is what the base leaves, so it is never rounded down; other buckets lose less than one unit per payment, paid for in fees | `economic::dust_payments_cannot_drain_or_unbalance_the_reserve` |
| E3 | Amounts at the edge of i128 | Every amount operation is checked (`MathOverflow` = 40); ratios are taken in 256 bits, so every gross up to `i128::MAX` splits exactly; an overflowing call is refused before any token moves | `economic::the_largest_payment_splits_and_an_overflowing_one_is_refused_cleanly`; `kyros-types` property tests over the whole i128 range |
| E4 | Zero and negative amounts | `InvalidAmount` on every money path | `economic::zero_and_negative_amounts_are_refused_everywhere` |
| E5 | Overdrawing a bucket, or paying one bucket from another | `ExceedsReserve`; each bucket is booked separately | `economic::no_bucket_pays_more_than_it_holds` |
| E6 | A notice so long that dates overflow, or so short that a stolen owner key empties the reserve in one ledger | Notice capped at a year; on Stellar's public network at least a day, checked by the vault itself (`InvalidNotice` = 42) | `economic::an_unbounded_notice_is_refused`, `economic::a_mainnet_vault_without_notice_is_refused`, `economic::a_mainnet_vault_needs_a_whole_day_of_notice` |
| E7 | Conversion floor overflowing between currencies of different decimals | One division at the end, in 256 bits | `hostile::a_large_reserve_converts_into_an_18_decimal_currency` (failed with "attempt to multiply with overflow" before the fix) |
| E8 | A strategy above the owner's share after payments shrink the reserve or reserve comes due | `invest` keeps one rule, the share, which also keeps what is due soon in the vault; earnings come out of the strategy, never out of the reserve held | `invariants` (I8) and its regression `regression_reserve_coming_due_leaves_the_strategy_within_its_share`; vault tests `paying_from_the_vault_never_leaves_the_strategy_above_its_share`, `harvesting_takes_the_earnings_from_the_strategy_never_the_reserve` |

### Soroban-specific

| # | Threat | Handling | Test |
| --- | --- | --- | --- |
| S1 | Calling owner functions without the owner's signature | `require_auth` on the owner before any check | `auth::every_owner_call_needs_the_owner` |
| S2 | Someone else's signature on the owner's call | The owner's address is fixed in storage; another signer does not satisfy it | `auth::someone_elses_signature_does_not_count` |
| S3 | A payer signature replayed for another amount, or used to choose its own terms | Signatures cover the exact arguments; terms are the owner's | `auth::a_payer_signature_covers_only_the_amount_signed`, `auth::a_payer_cannot_choose_its_own_terms` |
| S4 | Keepers redirecting permissionless calls | Those calls take no recipient: they pay the destination or the owner, once | `auth::calls_anyone_may_make_pay_only_where_the_owner_decided` |
| S5 | Re-entry from a token with hooks, a strategy or a swapper | The host refuses re-entry; the vault also books before it transfers. The call fails whole, books unchanged | `hostile::a_token_with_hooks_cannot_re_enter_the_vault`, `hostile::a_strategy_cannot_re_enter_the_vault`, `hostile::a_swapper_cannot_re_enter_the_vault` |
| S6 | An external contract reporting absurd figures | Its figures are checked (`MathOverflow`), and payments never depend on them | `hostile::a_strategy_lying_about_its_balance_breaks_no_payment` |
| S7 | Entries archived while still needed | Every write extends to the network's maximum (`TTL_EXTEND_TO`); the shared wasm is extended by the keeper; archived entries are restored by the transaction that needs them (Protocol 23). No temporary storage is used for anything that must survive | `ttl_and_limits::what_a_vault_writes_lives_as_long_as_the_network_allows` |
| S8 | A vault left idle | Its next use restores every entry it touches to full life | `ttl_and_limits::an_idle_vault_comes_back_to_full_life_on_its_next_use` |

### Denial of service

| # | Threat | Handling | Test |
| --- | --- | --- | --- |
| D1 | Making payments more expensive by paying a lot | Each payment touches a fixed set of entries of fixed size | `ttl_and_limits::the_cost_of_a_payment_does_not_grow_with_the_number_of_payments` |
| D2 | Lists growing until a call exceeds the network's limits | Every list has a cap with its own error (`TooMany`); the heaviest vault is measured against mainnet limits | `ttl_and_limits::every_list_has_a_cap_with_a_clear_error`; vault `the_heaviest_vault_stays_within_the_network_limits` |
| D3 | Junk tokens in an Inbox | Each token is swept on its own; junk never blocks the real currency | `ttl_and_limits::junk_in_the_inbox_does_not_block_real_payments` |
| D4 | A payroll run too large for one transaction | The SDK sends runs of eight; the Router test measures the event limit | router `a_full_payout_run_fits_in_one_transaction` |

### Router

| # | Threat | Handling | Test |
| --- | --- | --- | --- |
| R1 | A signature reused for another amount, or for more than the payment | The payer signs one tree: the Router call, the vault's `receive` and the two exact transfers | `router::the_payer_signs_exact_transfers_and_nothing_else` |
| R2 | A contract posing as a vault pulling more than the payment | Its transfer is not in the signed tree: refused, nothing moves | `router::a_fake_vault_cannot_pull_more_than_the_payer_signed` |
| R3 | A payroll run with one bad payout | All or nothing | `router::a_run_to_a_non_vault_moves_nothing` |
| R4 | Accounting drift over many payments and runs | Conservation checked after every step of random sequences (three vaults, one refusing the token) | `router::every_unit_is_accounted_for` |

### Inbox

| # | Threat | Handling | Test |
| --- | --- | --- | --- |
| N1 | A sweep redirected, or paid twice | `sweep` takes no recipient and pays only the split; a second sweep finds nothing | `inbox::anyone_sweeps_and_only_the_split_is_paid` |
| N2 | Moving someone's Inbox to another vault | Only the owner, only to a vault of the same owner, only after notice, cancellable until then | `inbox::only_the_owner_moves_it_to_their_own_vault_after_notice` |
| N3 | Junk tokens used to extract the accepted token, or returned to the wrong address | Junk goes back only to the owner's payout address; the accepted token is never "returned" | `inbox::junk_goes_back_to_the_owner_only` |
| N4 | Any sequence of payments, junk, sweeps, returns and moves | Conservation, the vault in force and refusals checked after every step | `inbox::every_unit_is_accounted_for` |

### CCTP receiver

| # | Threat | Handling | Test |
| --- | --- | --- | --- |
| C1 | Replayed or out-of-order nonces | Each message pays once (Circle's transmitter tracks nonces; a replay reverts the whole call) | cctp `nonces_out_of_order_each_pay_once`, `a_message_cannot_be_paid_twice` |
| C2 | Messages from another domain or for another token | Refused before anything is minted (`UnknownToken`) | cctp `an_unknown_domain_or_token_mints_nothing` |
| C3 | A hook that names something other than a vault | The whole call reverts, the mint with it | cctp `a_hook_naming_a_non_vault_reverts_the_mint` |
| C4 | Corrupted or truncated messages | Refused with nothing moved, or paid exactly, never partly | cctp `any_corrupted_message_is_refused_or_pays_exactly` (property); fuzz target `cctp_message` |
| C5 | Fees and amounts at any value | The split adds up to what was minted; nothing stays in the receiver | cctp `any_amount_and_fee_settle_exactly` (property) |
| C6 | A fake vault taking more than the payment | `BadSplit`, checked arithmetic | cctp `a_fake_vault_cannot_take_more_than_the_payment` |

### Rate Registry

| # | Threat | Handling | Test |
| --- | --- | --- | --- |
| G1 | Rates out of range | 0% and 100% accepted, above refused (`InvalidRate`) | `registry::rates_at_the_edges` |
| G2 | A change applied early, late, or mid-payment | Applies from its date to the second; each transaction reads the rate at its own ledger time (Soroban transactions do not interleave) | `registry::a_change_applies_exactly_on_its_date` |
| G3 | A rate the vault's owner never agreed to (e.g. 100%) | Above the vault's ceiling it is ignored; the vault keeps its own rule | `registry::a_rate_above_the_ceiling_is_ignored` |
| G4 | Someone other than the publisher writing, or history rewritten | Only the publisher signs; a rate in force or past cannot be withdrawn | `registry::only_the_publisher_writes_and_history_is_final` |
| G5 | Any sequence of publications, withdrawals and time | History final, notice held, schedule sorted, the vault's VAT right at every moment | `registry::the_registry_holds_under_any_sequence` |

## Invariants

Checked after every step of random sequences of operations, whether the
step succeeded or was refused. The scenarios live in
`contracts/test-suites/src/scenarios` and run twice: under proptest on every
CI run (with shrinking), and under libFuzzer every night
(`contracts/fuzz`, coverage-guided). The vault's
(`invariants::the_books_hold_under_any_sequence_of_operations`):

1. `held` equals the sum of every bucket of every period.
2. Each period balances: reserved = buckets + paid + released + converted.
3. The vault and its strategy together hold at least `held`.
4. A refused call changes nothing.
5. The tax destination has received exactly what the books say was paid.
6. The owner has received exactly the net amount of each payment, plus what
   was released, corrected or harvested.
7. Nothing is released before its bucket's due date.
8. After `invest`, the strategy holds no more than its share of the reserve
   not due soon, unless it cannot pay out.

The suite was checked against injected bugs: dropping one bookkeeping line
in `release` broke invariant 1, and releasing before the due date broke
invariant 7. Each was caught and shrunk to a short sequence. It also found
a real one: when reserve came due, `invest` brought back only what was due
soon and could leave the strategy above its share (invariant 8). The fix
and the shrunk sequence, kept as a regression test, are in the security
review.

## Rounding

| Where | Rounds | In favour of |
| --- | --- | --- |
| Base of a payment | Down | The tax: VAT, what the base leaves, rounds up |
| Each other bucket | Down, less than one unit | The payer, by less than one unit per bucket |
| Strategy share (`max_bps`) | Down | The reserve: the strategy never gets more than its share |
| Conversion floor | Down | Liveness: a fair swap is never refused for one unit |
| Converted amount between buckets | Down, last bucket takes the remainder | Exactness: the shares add up to what came out |
| Ondo purchase (`min_out`) | Down | Liveness |
| Ondo sale (USDY to sell) | Up | The reserve: enough is sold to cover what is asked |
| Blend position value | Down | The reserve: never counts on more than a withdrawal returns |

## Accepted risks

- The owner chooses the strategy, the swapper and the oracle (with notice).
  A malicious one chosen by the owner can lose what it is given; the notice
  is what protects against a stolen owner key.
- A stolen owner key can redirect the reserve after the notice period. The
  guardian in the SDK watches every proposal and alerts the user.
- Tokens accepted by the vault are trusted for balances and transfers.
