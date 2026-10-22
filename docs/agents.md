# Agents and the assistant

Kyros's contracts enforce the split on-chain. Around them, five agents do the tax work that happens off-chain: they read, check, explain and prepare transactions. None of them holds funds or keys, and none of them signs. Every operation they prepare is signed by the person it belongs to, in their own wallet.

All five are plain TypeScript in the SDK (`sdk/src/agents/`), with no language model and no server. In the app they run in the user's browser, so documents and questions stay on the device.

| Agent | What it does | Where it runs | What it prepares (someone else signs) |
| --- | --- | --- | --- |
| Law agent (`law.ts`, `scripts/law-agent.mjs`) | Turns the weekly law watch's findings into rule-pack changes: an official standard VAT rate that differs (TEDB), and new holiday data. Lists what the Rate Registry needs. | GitHub Actions, every Monday | A pull request a maintainer reviews. Registry transactions (`seed`, `publish`, `withdraw`, `set_holidays`, `add_holiday`) for the publisher's offline key. |
| Document agent (`invoice.ts`, with `notice.ts`) | Reads a tax office notice (payment date, amount, tax year) and an invoice (number, base, VAT, withholding, reverse charge, exemption, small-business franchise). Tells the two apart. | The user's browser (the PDF's text layer) | `set_due` for the notice's tax year, plus a scheduled payment when it states an amount. `expect_invoice` with the invoice's exact terms. |
| Treasury agent (`treasury.ts`) | For a dollar reserve owed in euros: compares the swap the vault would make now (a simulation of `convert`) with the oracle's fair price and the days to the due date. Says convert now, wait, or set up the conversion first. Projects the yield until the due date (the vault's observed yield, or a rate the user gives). | The user's browser (reads only) | `convert`, which anyone may run. The vault still refuses a swap below its oracle floor. |
| Payout agent (`payouts.ts`, `scripts/payouts.mjs`) | Reads a payroll or grants CSV in six languages. Catches invalid addresses, wallets that are not vaults (the payment would not split), ambiguous amounts (1.234), too many decimals and duplicates. Asks each vault whether it takes the token and what it sets aside. | The browser or the command line | `Router::pay_many`, in runs of 20 payments, for the payer to sign once per run. |
| Reconciliation agent (`reconcile.ts`) | Ties every amount set aside, paid or returned to its transaction, period by period. Answers "why was 2,591 set aside for income tax in Q3?" with the payments and hashes behind it. Checks a Koinly, CoinTracking, Crypto Tax Calculator or CoinLedger export against the chain: missing, unknown, different amounts. | The user's browser | Nothing: it only reads. |

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
- moving country, custody and late payment.

Every answer comes from the country's rule pack and the user's vault. When an answer leads to an operation, the chat shows a button; the user's wallet asks for confirmation.

The conversation lives in memory while the app is open and is never stored. It is not tax advice, and it says so in its first message.

## What the agents never do

- They never hold or move funds, and never see a private key. The law agent's registry transactions are prepared for the publisher's key, which stays offline.
- They never merge or apply a law change by themselves. A person reviews every pull request, and proposals that are not law yet are never published to the registry.
- They never send a document, a question or a figure anywhere: no model, no server, no analytics.

## Commands

```bash
# Pack edits from the official VAT findings (the law watch runs this):
node sdk/scripts/check-vat-official.mjs --json tedb.json
node sdk/scripts/law-agent.mjs --findings tedb.json --apply --out pr.md

# Registry transactions for the publisher to sign:
node sdk/scripts/law-agent.mjs --registry C... --publisher G... --out registry-txs.json

# A payout run from a CSV, prepared for the payer:
node sdk/scripts/payouts.mjs --csv payroll.csv --router C... --from G... --token C... --out payouts-txs.json
```
