# Security review, November 2026

A review of the contracts, the SDK and keeper, the app and the checkout plugins. Each problem found was first reproduced with a test that failed, then fixed; the tests stay in the suites so it cannot come back. Earlier incidents are covered the same way.

## Found and fixed

| Where | Problem | What could happen | Fix | Test |
| --- | --- | --- | --- | --- |
| `reserve-vault` `invest` (reported on r/Stellar) | It topped the strategy up to `max_bps` without looking at due dates | A pool fully lent on the due date left the tax payment waiting (`Illiquid`) | Reserve due within 14 days stays in the vault and is brought back from the strategy; the keeper checks hourly | `reserve_due_soon_comes_back_from_the_strategy_before_the_due_date`, `a_fully_lent_pool_is_asked_again_on_the_next_call`, `only_the_reserve_not_due_soon_is_invested` |
| `cctp-pay` `mint_and_pay` | It trusted the split the named vault quoted | USDC left in the receiver (a burn someone redeemed straight at Circle's transmitter) could be taken by a fake "vault" quoting more than the payment | The split may not move more than what was just minted, and nothing held before may leave (`BadSplit`) | `a_fake_vault_cannot_take_more_than_the_payment` |
| `reserve-vault` `propose_conversion` | Any tolerance up to 100% and any price age were accepted | `convert` is permissionless: with a high tolerance or a stale feed, a bad market could take most of the reserve | Tolerance at most 10%, price age between 1 second and 1 day | `a_conversion_cannot_risk_the_reserve` |
| `types` `validate_withholding` | A 100% withholding with no VAT was accepted | Splitting divided by zero: every payment with that invoice or payer failed | Refused (`InvalidTerms`) | `a_full_withholding_with_no_vat_is_refused` |
| `yield-ondo` `withdraw` | Asking for what `balance` reports left the slippage margin unsold | Stopping the strategy would leave about 0.5% of the USDY stranded in the adapter | Asking for at least `balance` sells everything | `withdrawing_what_balance_reports_leaves_no_usdy_behind` |
| `inbox` `return_unaccepted` | It returned a currency the vault was about to accept | Anyone could send a client's payment to the owner without its tax reserve during the notice | Refused while that token is pending (`TokenPending`); it is swept once the notice ends | `an_inbox_sweeps_a_currency_the_vault_added_after_the_notice` |
| Shopify server | A transaction hash was checked, then marked used | The same payment posted to two orders at once marked both paid | Each hash is locked while it is checked | `one transaction posted to two orders at the same time pays only one` |
| Shopify server | If Shopify failed while marking the order paid, the hash was used but nothing saved | The order stayed unpaid for ever | Saved first; the next status call marks it paid | `if Shopify fails when marking the order paid, the next check marks it` |
| WooCommerce | The same race as Shopify | The same payment could pay two orders | The hash is claimed atomically in the options table before the check, and freed if it pays nothing | `tests/wp-integration.php` |
| x402 plugin | The buyer's declared country came before the CDN's | A consumer could declare another country to pay no VAT | When they disagree, neither counts (seller's rate); optional `verifyVatId` | `a buyer cannot declare another country or a fake VAT number to pay less VAT` |
| App payment links | `BigInt` of the link's amount ran unchecked while rendering | A malformed link (`a=abc`) left the app blank | `parsePayLink` in the SDK checks the vault, reference and amount | `a payment link is read only when every part is well formed` |
| Shopify, WooCommerce and the checkout widget | A transfer was matched by address and amount only | Anyone could claim a transfer another buyer made (it is public on chain) for their own order of the same amount, and get the goods unpaid | The widget names the paying wallet before the buyer signs; only transfers from that wallet, made after that moment, pay the order | `a transfer someone else made cannot be claimed for another order`; `tests/wp-integration.php` |
| Checkout widget | Error text from wallets and the network was inserted as HTML | Markup in an error message would run in the shop's page | Shown as text | build |
| `reserve-vault` `stop_strategy` | It failed while the strategy could not pay out | With a fully lent pool or a stale USDY price the owner could not stop the strategy at all | It brings back what it can and marks the strategy as stopping: it takes nothing more, and `invest` (the keeper, hourly) brings the rest back and removes it | `a_strategy_stopped_while_its_pool_is_lent_out_finishes_stopping_later`, `a_stopping_strategy_emptied_by_payments_is_removed_on_the_next_call` |
| `types` `valid_due` | `Due::After` took any delay | `After(u64::MAX)` overflowed every due date: release, `invest` and payments stopped for the whole vault | At most four years | `a_due_rule_that_would_overflow_the_clock_is_invalid`, `a_due_date_past_the_clock_is_refused` |
| `reserve-vault` constructor | Calendar due dates were accepted on fixed-length periods | A weekly period ending on the 25th had its tax "due" on the 20th, before it ended | Fixed-length periods take only `After` | `a_calendar_due_date_on_fixed_length_periods_is_refused`, found by `every_timestamp_falls_in_its_period_and_is_due_after_it` |
| App amounts | Each screen read typed amounts its own way | "1.210" (Spanish for 1,210) became 1.21: paying a tax of 1.210 € paid 1.21 €; "1.210,50" was not read at all | One reader, `normalizeAmount`, for every screen | `amounts typed the Spanish way are read as meant` |
| SDK `formatAmount` | Wrong with 0 decimals | 1210 shown as ".121" | Fixed | `a token with no decimals is shown whole` |
| App | Nothing stopped the testnet build from running against mainnet | Browser-kept keys and the published faucet key on the public network | The app refuses the public network | build |
| SDK `inboxMoves` (guardian) | It read one page of the inbox's events | On a busy inbox (an x402 seller sweeps every few seconds) a proposal to move the payment address to another vault was not seen | Asks for the two move events by topic, page by page | `a move proposal on a busy inbox is not missed` |
| SDK `vaultEvents` (guardian) | The guardian read every event of the day, up to 10,000 | With more payments than that in a day, a proposal (new payout address, new destination) after them was not seen | The guardian asks the RPC for proposals only (`GUARD_EVENT_KINDS`), with a full read as fallback; the testnet demo checks it against the real RPC | `the guardian finds a proposal on a busy vault`; demo step |
| App due dates | The day was formatted in the device's time zone from a UTC end-of-day | In Spain every due date showed one day late ("pay before 21 April" for 20 April): a user could pay a day late | The contract's own (UTC) day, `dayString` | `a due date is shown on its own day in Spain, not the next one` |
| x402 plugin `verifyVatId` | A check that threw failed the request | VIES down meant no sales | A failed check counts as not verified: the VAT is charged | `when the VAT number check is down, the VAT is charged` |
| App dependencies | `npm audit` fixes that do not change the API | Known issues in transitive packages | Stellar Wallets Kit 2.8.0 and `follow-redirects` updated | `npm audit` |

## Earlier incidents, now with regression tests

| Incident | Test |
| --- | --- |
| Protocol 30 (3 November 2026): ledger values with millisecond close times broke decoding and stopped the keeper | `Protocol 30 … decode` in `sdk/src/test/regressions.test.ts` |
| A lagging RPC handed out stale sequence numbers (`txBadSeq`) | `a stale sequence number … is built and sent again` |
| A transaction failed when applied after state moved | `… simulated and sent once more, not forever` |
| A transaction dropped by a busy network (`NOT_FOUND`) | `… is sent again until it lands` |
| One cent lost reclaiming input VAT at an exchange rate | `reserve-extras.test.ts` |

## Soroban, Stellar and Rust

A pass focused on what is particular to Soroban: the network's per-transaction limits, rent and archival, Stellar Asset Contract behaviour, and Rust arithmetic. The tests run with Stellar mainnet's limits enforced (soroban-sdk 28 does so by default: 400 ledger entries, 200 written, 132 KB written, 16 KB of events, 400 M instructions per transaction).

| Where | Problem | What could happen | Fix | Test |
| --- | --- | --- | --- | --- |
| `reserve-vault` `invest` / `due_soon` | It read the date set by hand for every bucket of every open period: up to 36 × 8 entries | On a monthly vault with many buckets it read 336 ledger entries (the limit is 400) and ran out of the test budget: `invest` could fail, and with it bringing reserve back before a due date | One read per period (`EarliestSet`, the earliest date set by hand for any of its buckets); a hand-set date never makes reserve count as later | `the_heaviest_vault_stays_within_the_network_limits` (now 84 entries) |
| SDK `PAYOUTS_PER_RUN` | `pay_many` runs of 20 payments | Each payment emits about 1.4 KB of events; 20 need 29 KB against a 16 KB limit: every full payroll run would fail on mainnet | Runs of 8 | `a_full_payout_run_fits_in_one_transaction` |
| Shared wasm and contracts | Nothing extended the rent of the wasm shared by all vaults and inboxes, or of the Router, the Registry, the CCTP receiver and the swapper (each vault and inbox extends only its own instance) | Once archived, the next transaction to need one would first restore it and pay for the whole wasm | `keepAlive` (SDK) extends them before they run low; the hourly testnet keeper does it, and `kyros-keeper --keep-alive` does it on mainnet | `the shared wasm and contracts are extended before they are archived`; keeper run |
| `reserve-vault` `propose_payout` / `propose_destination` | Any address was accepted | A Stellar account without the trustline cannot receive a classic asset: after the notice every client payment through the Router failed, and sweeps left the money in the inbox | A payout address must be able to hold every currency of the vault, a tax destination at least one (`CannotHold`) | `an_address_that_cannot_receive_the_tokens_is_refused` |
| `reserve-vault` `set_due` | It read every period's current lock (which may ask the registry for holidays) before the cheap check | Up to 24 registry calls for a date that needs no check | The cheap check first | `the_heaviest_vault_stays_within_the_network_limits` |
| `types` `valid_period` | `Seconds(len)` took any length above zero | A huge length overflowed the period's end and stopped the vault | From a minute to ten years | `a_fixed_length_period_that_would_overflow_the_clock_is_invalid` |
| `rate-registry` `set_holidays` | Years before 1970 accepted | Day numbers are unsigned and would wrap around | Years 1970 to 9999 | `holidays` test |

Checked and fine as they are:

- **Storage.** No temporary storage. Persistent entries extend their TTL when they are written; extensions above the network's maximum are clamped by the host. Instance storage holds only bounded data (at most 8 tokens, 8 buckets, 40 scheduled payments and 20 corrections).
- **Archival.** Since Protocol 23 an archived entry is restored automatically by the transaction that needs it; reads by simulation still work.
- **Authorization.** Every function that moves money or changes a setting requires the owner, or is permissionless and can only pay the owner, the vault or the tax destination. The inbox and the CCTP receiver authorize exactly the token transfers of the split they were given.
- **Stellar Asset Contract.** Muxed tax destinations (anchor memos), issuer flags (authorization, freeze, clawback) and trustlines are handled as described in [public-money.md](public-money.md) and above.
- **Rust.** Release builds keep overflow checks on (an overflow aborts the transaction instead of wrapping); the remaining `unwrap`s read the contract's own configuration, written by its constructor.

## Third pass: line by line, and the code's shape

A reading of every contract line by line, looking for the smallest faults as well as the large ones, and for how the code reads to someone reviewing it for the first time.

| Where | Problem | What could happen | Fix | Test |
| --- | --- | --- | --- | --- |
| `reserve-vault` `invest` | It only compared the strategy with its share when putting more in | Paying tax from the vault's own liquid reserve left the strategy holding far more than the owner's `max_bps` (in the test, 100% instead of 50%) and nothing brought it back | The reserve the vault does not hold itself is kept at `max_bps` of what is not due soon; `invest` brings the excess back | `paying_from_the_vault_never_leaves_the_strategy_above_its_share` |
| `reserve-vault` `harvest` | Earnings were paid from the vault's liquid balance first | With the pool fully lent, `harvest` paid the owner out of tax due within days, leaving the vault short when the tax was due | Earnings come out of the strategy; the reserve the vault held stays in it | `harvesting_takes_the_earnings_from_the_strategy_never_the_reserve` |
| `reserve-vault` `invest` / `due_soon` | Once a token had more than 36 open periods, `OpenFull` kept all its reserve "due soon" for ever | Yield stopped for good after one busy stretch | `OpenFull` clears itself once the tracked periods hold all the reserve again | `more_open_periods_than_tracked_keep_everything_liquid_until_paid` |
| `reserve-vault` `propose_token` | The payout address was not checked | A new classic asset without a trustline on the payout address would make every payment in it fail after the notice | `CannotHold` | `a_currency_the_payout_address_cannot_hold_is_refused` |
| `reserve-vault` `forget_invoice`, `forget_payer`, `cancel_correction` | No event | An indexer or the app's guardian could not see terms removed or a correction withdrawn | `InvoiceForgotten`, `PayerForgotten`, `CorrectionCancelled` | the terms and corrections tests check each event |
| `reserve-vault` conversion floor | The oracle quotient was rounded before scaling up to the output token's decimals | The floor could be up to 10^(difference in decimals) units lower than the tolerance allows | One division at the end | conversion tests |
| `reserve-vault` `due_date` | Read the stored config, not the one in force | Buckets from fixed amounts whose notice had passed but not been applied yet were left out of the view | Reads the config in force | — |
| `yield-ondo` constructor | Prices compare the two tokens unit for unit, with no check that they have the same decimals | A token with other decimals would be valued wrongly | Refused (`InvalidSetup`) | `tokens_with_different_decimals_are_refused` |
| `rate-registry` `add_holiday` | No year bound, unlike `set_holidays` | A typo could create a list for a year no other call accepts | Years up to 9999 | `holidays` test |
| `yield-blend`, `yield-ondo` `withdraw` | Only `deposit` extended the instance's TTL | A strategy being emptied for months could be archived in between (restored automatically, but paid for) | Both extend it | — |

The code's shape:

- **The vault in modules.** The 2,600-line `lib.rs` is split into fifteen modules by concern (storage, terms, calendar, money in and out, scheduled payments, corrections, changes with notice, conversion, yield, reads, internal steps), each adding its own `#[contractimpl]` block. The layout is in [contracts/README.md](../contracts/README.md) and in the crate docs. Withdrawing and applying changes moved from the yield module to the changes module; removing a strategy is no longer a method on the contract type.
- **One source for the TTL policy.** `DAY_IN_LEDGERS`, `TTL_EXTEND_TO` and `TTL_THRESHOLD` live in `types`; every contract uses them, and the inbox and the yield adapters extend their instance through one helper each.
- **Events grouped by area,** and every public function, error and field documented. These docs end up in the contract spec, so explorers and generated bindings show them.
- **Contract metadata.** Every wasm carries `Description` and `Source` (`contractmeta!`).
- **CI gates.** Formatting, clippy with warnings as errors, rustdoc with warnings as errors, the tests with mainnet limits, the build, and each wasm's size against the network's 128 KiB limit.
- **Checked and kept:** the swapper receives the output of the swap itself and forwards it, because Soroswap's router requires the recipient to sign; a direct payout to the vault fails authorization (tried and reverted, with a comment in the code).

## Randomized checks

`every_split_adds_up_and_nothing_is_negative` runs 20,000 random rules, withholdings and amounts up to 10^18 units through the split: the parts always add up to the payment and nothing is negative. `every_timestamp_falls_in_its_period_and_is_due_after_it` runs 20,000 dates from 1970 to 2100 through every period kind and due rule.

## Accepted, with reasons

- **USDC minted to the CCTP receiver outside `mint_and_pay`** (a burn with no destination caller, redeemed at Circle directly) stays there: the receiver cannot tell which vault it belongs to. Kyros payment links always name the receiver as the destination caller, so only third-party burns can end up like this; the fix above stops anyone from taking it.
- **The issuer of public money** can freeze or claw back what a vault holds. That power is the issuer's, shown before a currency is accepted ([public-money.md](public-money.md)).
- **Testnet keys in the browser.** The app keeps testnet-only keys (test clients, the KDD issuer) in local storage on purpose. Nothing like it runs on mainnet.
- **Remaining `npm audit` entries** (zod 3, elliptic, stream-json) come from wallet connectors inside Stellar Wallets Kit (Reown/WalletConnect, NEAR, Solana, HOT) and have no fixed version that those connectors accept. They run in the buyer's browser only when the buyer picks one of those wallets. The vulnerable `uuid` under Solana's RPC client is overridden to 11.1.1.
