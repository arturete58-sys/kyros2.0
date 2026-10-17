# Integrating Kyros

Kyros is a building block for anyone who pays or gets paid in stablecoins on Stellar: whoever pays sends the money to a Kyros address, and the user's vault splits it on arrival (net to the user, VAT and income tax set aside until they are due). The payer does not need to know the user's tax rules; the vault holds them.

There are three ways in, from no integration at all to a full payout run.

| Who | How they pay | Integration |
| --- | --- | --- |
| Anyone, any wallet, an exchange withdrawal, an x402 API | A plain USDC or EURC transfer to the user's **payment address** (their Inbox contract) | None. The Inbox splits whatever arrives; anyone can trigger the split (the app and the keeper do) |
| A client paying one invoice | The payment link, from a Stellar wallet (Router `pay`) or from Ethereum, Base, Arbitrum, OP or Avalanche ([cross-chain payments](cross-chain-payments.md)) | None; the link carries the invoice reference so its own terms apply |
| A platform paying many people (payroll, bounties, grants, marketplace payouts) | Router `pay_many`: one signature, every payment split by its own vault, all or nothing | A few lines with the SDK |

## Platforms: a payout run

```ts
import { KyrosClient } from 'kyros-sdk';

const kyros = new KyrosClient({ rpcUrl, networkPassphrase });
const op = kyros.payManyOp(ROUTER, {
  from: platformAccount,          // signs once
  token: USDC,                    // the SAC of the stablecoin paid
  payouts: [
    { vault: aliceVault, amount: 1_500_0000000n, reference: invoiceReference('PAYOUT-2027-03-alice') },
    { vault: bobVault,   amount:   800_0000000n, reference: invoiceReference('PAYOUT-2027-03-bob') },
  ],
});
const { hash } = await kyros.send(platformKeypair, op);
```

- **What the platform gets:** its contractors and freelancers are paid with their taxes already set aside, in the same transaction; a payout to a Kyros user costs the platform nothing extra to handle.
- **What it does not take on:** Kyros never holds the platform's or the user's funds and gives no tax advice; each user chose their own rule.
- **Limits:** a run is one Soroban transaction, so keep it to a few dozen payouts and split larger runs. If any vault refuses (for example, it does not accept the token), nothing in that run is paid.
- **Users without Kyros:** pay them as usual; only addresses that are Kyros vaults go in the run.

The [testnet demo](testnet) runs a payout run to two vaults in different countries.

## x402 sellers

An API that charges per request through x402 sets the user's **payment address** as `payTo`. Each micropayment is a SEP-41 transfer to the Inbox, and the Inbox splits it. The keeper (or the app) sweeps the Inbox as payments arrive:

```bash
KEEPER_SECRET=S... npx kyros-keeper --network testnet --watch <inbox>:<usdc-token>
```

## People paid by the Stellar ecosystem

Bounty hunters, DAO contributors and grant recipients often get paid in USDC with nothing set aside for tax. They can give their Kyros payment address as the payout address, wherever the payer can send to a contract address (Soroban `C…` address). A payer whose system only sends to classic `G…` accounts cannot pay an Inbox directly yet; that is in the [backlog](backlog.md).

## Tax software

Kyros sets the money aside; the user's tax software files the return. The app exports the vault's events for Koinly (its universal CSV) and CoinTracking (its CSV import), and as a plain CSV for an accountant: each payment's base is income, its VAT is held apart, tax paid leaves as a withdrawal, conversions are trades. See [`sdk/src/tax-exports.ts`](../sdk/src/tax-exports.ts).
