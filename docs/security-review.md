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
| App dependencies | `npm audit` fixes that do not change the API | Known issues in transitive packages | Stellar Wallets Kit 2.8.0 and `follow-redirects` updated | `npm audit` |

## Earlier incidents, now with regression tests

| Incident | Test |
| --- | --- |
| Protocol 30 (3 November 2026): ledger values with millisecond close times broke decoding and stopped the keeper | `Protocol 30 … decode` in `sdk/src/test/regressions.test.ts` |
| A lagging RPC handed out stale sequence numbers (`txBadSeq`) | `a stale sequence number … is built and sent again` |
| A transaction failed when applied after state moved | `… simulated and sent once more, not forever` |
| A transaction dropped by a busy network (`NOT_FOUND`) | `… is sent again until it lands` |
| One cent lost reclaiming input VAT at an exchange rate | `reserve-extras.test.ts` |

## Accepted, with reasons

- **USDC minted to the CCTP receiver outside `mint_and_pay`** (a burn with no destination caller, redeemed at Circle directly) stays there: the receiver cannot tell which vault it belongs to. Kyros payment links always name the receiver as the destination caller, so only third-party burns can end up like this; the fix above stops anyone from taking it.
- **`stop_strategy` fails while the strategy cannot pay out** (a fully lent pool, a stale USDY price). Removing the strategy then would strand what it holds, so the owner retries; payments that need the money wait with `Illiquid`.
- **The issuer of public money** can freeze or claw back what a vault holds. That power is the issuer's, shown before a currency is accepted ([public-money.md](public-money.md)).
- **Testnet keys in the browser.** The app keeps testnet-only keys (test clients, the KDD issuer) in local storage on purpose. Nothing like it runs on mainnet.
- **Remaining `npm audit` entries** come from wallet connectors inside Stellar Wallets Kit (Reown/WalletConnect, NEAR, Solana) and need a new major of those packages upstream. They run in the user's browser only when the user picks one of those wallets.
