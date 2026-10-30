# Public money on Stellar

Kyros works with any Stellar asset, including money that a state issues: a central bank digital currency (CBDC), a government's digital dollar, or a digital sovereign bond paid out as a benefit. For a vault this is one more currency: it splits each payment in it, keeps the reserve in it and pays the tax in it.

## What exists (checked 30 October 2026)

| Country | Money | What it is | Status | How Kyros fits |
| --- | --- | --- | --- | --- |
| Bermuda | Bermuda Digital Dollar | A government-issued digital dollar on Stellar, backed by deposits at Bermuda's banks | Announced in 2026, not issued yet | Bermuda already accepts tax payments in USDC. With the tax office's Stellar account as the vault's destination, the payroll tax goes there directly. When the digital dollar is issued, the vault adds it as a currency. |
| Marshall Islands | USDM1 | A digital sovereign bond of the Republic, issued natively on Stellar and backed one to one by US Treasury bills; the universal basic income (ENRA) is paid in it to the Lomalo wallet | In use since November 2025 | A benefit is not a client's payment, so it goes to a wallet rather than a vault. If businesses come to be paid in USDM1, the vault adds it. |
| Ukraine | e-hryvnia | A 2021 pilot by TASCOMBANK on Stellar, with the Stellar Development Foundation and Bitt, under the National Bank of Ukraine's oversight | The pilot ended | If the National Bank issues it, a Ukrainian vault adds it. |

No country has a CBDC in use on Stellar yet. The list is in `sdk/src/sovereign.ts` (`SOVEREIGN_MONEY`), with its sources.

Rule packs cover the taxes of the two island states:

- **Bermuda** (`bm`): no income tax and no VAT. A self-employed person pays payroll tax at the standard rate on what they take out of the business, quarterly.
- **Marshall Islands** (`mh`): from 1 October 2026, a small business pays 3% gross revenue tax; above USD 300,000, or if registered, it pays 16% net profit tax and charges 12% consumption tax.

## How a vault takes it

1. **The currency.** The owner proposes the token with `propose_token`. It applies after the vault's notice, like any change, and the guardian shows it until then. The app does this from **Settings → Public money and CBDCs**.
2. **The issuer's authorization.** Public money is usually issued with `AUTH_REQUIRED`: only addresses the issuer authorizes can hold it. The vault (it keeps the reserve), every payment address (inboxes receive before they sweep) and the owner's wallet (or payout address) need authorization. `holdersToAuthorize` lists them, and the issuer calls `set_authorized` on the asset's contract (`KyrosClient.authorizeHolderOp`). Until the vault is authorized, a sweep fails and the payment waits in the inbox, where it can only ever go to the owner or the vault.
3. **Paying the tax.** Where the tax office has a Stellar account, it becomes the vault's destination (`propose_destination`, with notice). The tax then goes there in the same currency, with no anchor and no conversion.

## What the issuer can do

`readIssuerFlags` reads the asset's flags from Horizon and `issuerControls` translates them. The app shows them before the user accepts a currency:

- **authorization**: holding it needs the issuer's permission;
- **freeze** (`AUTH_REVOCABLE`): the issuer can freeze it, including inside the vault;
- **clawback** (`AUTH_CLAWBACK_ENABLED`): the issuer can take it back, including from the vault. The vault's buckets would then record more than it holds, and the last payments or releases in that currency would fail for the missing amount.

These powers belong to the issuer, not to Kyros. Kyros still has no key over any vault.

## Trying it on testnet

The testnet deployment issues **KDD**, a test digital dollar with the controls public money usually has (authorization required, freeze and clawback enabled). Its issuer key is published in `app/public/testnet.json` on purpose (testnet only, no value), so the app can act as the issuer: it authorizes the user's vault and addresses, and the user signs that the vault accepts KDD. After the notice, **Simulate a 1,210 KDD payment** splits a test client's payment.

The [testnet demo](testnet/README.md) runs the same flow with real transactions: a vault proposes a new currency, a payment in it is refused before the notice, the sweep waits until the issuer authorizes the vault, and the VAT is paid in that currency straight to the tax office's account.
