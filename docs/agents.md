# Agents and the assistant

Kyros's contracts enforce the split on-chain. Around them, ten agents do the tax work that happens off-chain: they read, check, explain and prepare transactions. None of them holds funds or keys, and none of them signs. Every operation they prepare is signed by the person it belongs to, in their own wallet.

All of them are plain TypeScript in the SDK (`sdk/src/agents/`), with no language model and no server. In the app they run in the user's browser, so documents and questions stay on the device.

| Agent | What it does | Where it runs | What it prepares (someone else signs) |
| --- | --- | --- | --- |
| Law agent (`law.ts`, `scripts/law-agent.mjs`) | Turns the weekly law watch's findings into rule-pack changes: an official standard VAT rate that differs (TEDB), and new holiday data. Lists what the Rate Registry needs. | GitHub Actions, every Monday | A pull request a maintainer reviews. Registry transactions (`seed`, `publish`, `withdraw`, `set_holidays`, `add_holiday`) for the publisher's offline key. |
| Document agent (`invoice.ts`, with `notice.ts`) | Reads a tax office notice (payment date, amount, tax year) and an invoice (number, base, VAT, withholding, reverse charge, exemption, small-business franchise). Tells the two apart. | The user's browser (the PDF's text layer) | `set_due` for the notice's tax year, plus a scheduled payment when it states an amount. `expect_invoice` with the invoice's exact terms. |
| Treasury agent (`treasury.ts`, `blend.ts`) | For a dollar reserve owed in euros: compares the swap the vault would make now (a simulation of `convert`) with the oracle's fair price and the days to the due date. Says convert now, wait, or set up the conversion first. For yield, reads the Blend v2 pool with the pool's own interest model (utilization, borrow and supply APR, free liquidity). Says lend, not worth it (too close to the due date or too little yield), pool too full, or bring it back before the due date. | The user's browser (reads only) | `convert`, which anyone may run. The vault still refuses a swap below its oracle floor. |
| Payout agent (`payouts.ts`, `scripts/payouts.mjs`) | Reads a payroll or grants CSV in six languages. Catches invalid addresses, wallets that are not vaults (the payment would not split), ambiguous amounts (1.234), too many decimals and duplicates. Asks each vault whether it takes the token and what it sets aside. | The browser or the command line | `Router::pay_many`, in runs of 20 payments, for the payer to sign once per run. |
| Reconciliation agent (`reconcile.ts`) | Ties every amount set aside, paid or returned to its transaction, period by period. Answers "why was 2,591 set aside for income tax in Q3?" with the payments and hashes behind it. Checks a Koinly, CoinTracking, Crypto Tax Calculator or CoinLedger export against the chain: missing, unknown, different amounts. | The user's browser | Nothing: it only reads. |
| Residence agent (`residence.ts`) | Counts the days in each country against each country's residence test (its threshold and window: calendar year, tax year, rolling 12 months, continuous stay). Warns before a threshold and gives the day it would be crossed. Explains the treaty tie-breaker when two countries claim the user. Plans the move: with the same tax calendar, the new rule applies on the exact date (`propose_rule_at`); otherwise a new vault takes the same payment address (`propose_vault`), signed one notice before the day. The app's **Change country** screen (Settings, or the assistant's button) shows the plan and what will be signed; once the move takes effect the app switches to the new vault and keeps the earlier one, with its reserve, under **Earlier vaults**. | The user's browser (the chat parses "150 days in Portugal and 40 in Spain") | `propose_rule_at` (after `unfollow` if the vault followed the registry), or a new vault, `expect_payer` for the address for clients abroad, and `propose_vault` on each inbox. `cancel` or `cancel_move` withdraws it before it applies. |
| x402 billing agent (`x402.ts`) | For API sellers on x402: the VAT of each sale from the buyer's country and status (reverse charge for EU businesses, the buyer's rate for EU consumers above the EUR 10,000 OSS threshold, none outside the EU). Prices the endpoint so the seller's net is constant, and picks the Kyros inbox whose payer terms split that VAT. The 27 EU standard rates are checked against TEDB every week. | The seller's server | `expect_payer` for one inbox per VAT rate (the owner signs once per rate). |
| Expense agent (`expenses.ts`) | Reads supplier invoices and receipts as expenses (base, input VAT, category; the user confirms), or takes them by hand. Applies the user's country's rules (`deductionSummary`): on profit, every expense lowers income tax and contributions, and it shows the estimated saving; presumptive and turnover regimes (France's micro, Italy's forfettario, Argentina's monotributo, Mexico's RESICO...) say that real expenses do not change the income tax; Portugal's simplified regime checks the 15% of revenue that must be justified. Input VAT comes back when the user charges VAT (or exports zero-rated); not registered, or a sales tax (US, Puerto Rico), it is part of the cost. Prepayments: Spain's modelo 130 recomputed; prior-year prepayments name the procedure to lower them (Germany's Herabsetzungsantrag, the UK's SA303, Australia's PAYG variation...); prepayments that follow the reserve go down with it. When the expenses justify a lower reserve, prepares it. The app's **Expenses and deductions** screen (Home) shows all of it and keeps the list on the device; the modelo 130 instalment uses the recorded expenses. | The user's browser (kept on the device) | `propose_rule`, applying after the notice. |
| Guardian agent (`watchdog.ts`) | Flags every pending change that would move money elsewhere: tax destination, a rule that stops reserving, yield adapter, swapper, correction, inbox move. Changes made from the owner's device are marked as theirs. Shown on Home and Alerts. The keeper's `--guard` mode sends alerts to the owner's Telegram bot or a webhook. | The user's browser, and the keeper | `cancel`, `stop_strategy`, `stop_conversion`, `cancel_correction` or the inbox's `cancel_move`. |
| Settlement agent (`settlement.ts`) | Before each deadline: checks the IBAN the tax office collects from (length and check digits), that the anchor takes withdrawals and at what fee, that the anchor's account is the vault's destination and its memo fits a vault payment, and the day to start (working days ahead). | The user's browser | `pay_tax_to` per bucket, to the anchor's account with its memo. The memo always comes from the anchor. |

## What is switched on

`catalog.ts` lists every agent and whether it is on. The app and the assistant only offer the active ones.

| Agent | Status | Why |
| --- | --- | --- |
| Assistant | Active | Every user's way to the other agents. |
| Documents | Active | Notices and invoices are the most common paperwork. |
| Reconciliation | Active | Every figure explained; exports checked. |
| Law | Active | Keeps 46 packs current every Monday. |
| Guardian | Active | Non-custody holds only if a stolen key cannot redirect the reserve unseen. |
| Expenses | Active | Every country's deductions: the saving, input VAT, prepayments and a lower reserve when justified. |
| Residence | Active | Freelancers who move: days, tests, and the change of country signed from the app. |
| Payouts | Active | Platforms and DAOs paying many freelancers. |
| Treasury: euros | Active | Users paid in dollars who owe euros. |
| Treasury: yield | Ready | Needs a Blend v2 pool for the reserve's asset and the owner's strategy; until then it projects with a rate the user gives. |
| x402 billing | Active | The `@kyros/x402` plugin runs it in the seller's server; the app's Sell online screen makes one payment address per VAT rate (the same addresses serve the WooCommerce plugin, see `plugins/`). |
| Settlement | Ready | Needs a regulated anchor paying out euros (mainnet); on testnet the destination is a test account. |

## The assistant

The **Assistant** tab is a chat about the user's own taxes (`assistant.ts`, words in `assistant-text.ts`).

It understands questions in Spanish, English, Portuguese, French, German and Italian:

- the next deadlines and what is set aside for each;
- why a figure, in a quarter or a month;
- whether the reserve is enough for a given revenue (`checkReserve`);
- which VAT to charge and the dated changes;
- clients abroad and withholding;
- notices and invoices (attached);
- exports for the accountant or Koinly (attached to be checked);
- converting the reserve to euros, and yield;
- bulk payouts (attached CSV);
- what changed in the law (the pack's notes and dated changes);
- moving country (with the date, and a button to review and sign it), residence days and treaties;
- expenses and what they save under the country's rules (income tax, contributions, input VAT, prepayments, the reserve);
- pending changes in the vault (the guardian), custody and late payment;
- x402 billing and paying through an anchor (it checks an IBAN typed in the chat).

Every answer comes from the country's rule pack and the user's vault. When an answer leads to an operation, the chat shows a button; the user's wallet asks for confirmation.

The conversation lives in memory while the app is open and is never stored. It is not tax advice, and it says so in its first message.

## What the agents never do

- They never hold or move funds, and never see a private key. The law agent's registry transactions are prepared for the publisher's key, which stays offline.
- They never merge or apply a law change by themselves. A person reviews every pull request, and proposals that are not law yet are never published to the registry.
- They never send a document, a question or a figure anywhere: no model, no server, no analytics.

## Commands

```bash
# Guardian alerts for a vault and its inbox, to the owner's Telegram bot and/or a webhook (no secret needed):
TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=... kyros-keeper --network testnet --guard C...vault:C...inbox --notify-webhook https://...
```


```bash
# Pack edits from the official VAT findings (the law watch runs this):
node sdk/scripts/check-vat-official.mjs --json tedb.json
node sdk/scripts/law-agent.mjs --findings tedb.json --apply --out pr.md

# Registry transactions for the publisher to sign:
node sdk/scripts/law-agent.mjs --registry C... --publisher G... --out registry-txs.json

# A payout run from a CSV, prepared for the payer:
node sdk/scripts/payouts.mjs --csv payroll.csv --router C... --from G... --token C... --out payouts-txs.json
```
