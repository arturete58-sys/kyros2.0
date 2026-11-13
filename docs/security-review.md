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
| App dependencies | `npm audit` fixes that do not change the API | Known issues in transitive packages | Stellar Wallets Kit 2.8.0 and `follow-redirects` updated | `npm audit` |

## Earlier incidents, now with regression tests

| Incident | Test |
| --- | --- |
| Protocol 30 (3 November 2026): ledger values with millisecond close times broke decoding and stopped the keeper | `Protocol 30 … decode` in `sdk/src/test/regressions.test.ts` |
| A lagging RPC handed out stale sequence numbers (`txBadSeq`) | `a stale sequence number … is built and sent again` |
| A transaction failed when applied after state moved | `… simulated and sent once more, not forever` |
| A transaction dropped by a busy network (`NOT_FOUND`) | `… is sent again until it lands` |
| One cent lost reclaiming input VAT at an exchange rate | `reserve-extras.test.ts` |

## Randomized checks

`every_split_adds_up_and_nothing_is_negative` runs 20,000 random rules, withholdings and amounts up to 10^18 units through the split: the parts always add up to the payment and nothing is negative. `every_timestamp_falls_in_its_period_and_is_due_after_it` runs 20,000 dates from 1970 to 2100 through every period kind and due rule.

## Accepted, with reasons

- **USDC minted to the CCTP receiver outside `mint_and_pay`** (a burn with no destination caller, redeemed at Circle directly) stays there: the receiver cannot tell which vault it belongs to. Kyros payment links always name the receiver as the destination caller, so only third-party burns can end up like this; the fix above stops anyone from taking it.
- **The issuer of public money** can freeze or claw back what a vault holds. That power is the issuer's, shown before a currency is accepted ([public-money.md](public-money.md)).
- **Testnet keys in the browser.** The app keeps testnet-only keys (test clients, the KDD issuer) in local storage on purpose. Nothing like it runs on mainnet.
- **Remaining `npm audit` entries** (zod 3, elliptic, stream-json) come from wallet connectors inside Stellar Wallets Kit (Reown/WalletConnect, NEAR, Solana, HOT) and have no fixed version that those connectors accept. They run in the buyer's browser only when the buyer picks one of those wallets. The vulnerable `uuid` under Solana's RPC client is overridden to 11.1.1.
