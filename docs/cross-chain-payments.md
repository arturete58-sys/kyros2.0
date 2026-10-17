# Getting paid from another chain

A client whose USDC is on Ethereum, Base, Arbitrum, OP or Avalanche can pay a Kyros vault without touching Stellar. They use the wallet they already have (MetaMask, Rabby, Coinbase Wallet, Phantom, OKX…), and the payment is split on arrival like any other: net to the owner, reserve to the vault, by the invoice's own terms when the owner registered them.

It runs on Circle's Cross-Chain Transfer Protocol (CCTP V2), which has served Stellar since 2026: USDC is burned on the source chain and minted natively on Stellar, with no wrapped token and no bridge custody.

## Flow

1. **Source chain.** The client opens the payment link, picks the network and their wallet (found through EIP-6963), and signs two transactions:
   - `approve` of USDC to Circle's TokenMessengerV2, for exactly the amount;
   - `depositForBurnWithHook`, to Stellar (domain 27), with the **Kyros CCTP receiver** as both `mintRecipient` and `destinationCaller`, and the vault and invoice reference in the hook data.
2. **Circle** attests the burn. With fast transfers (`minFinalityThreshold` 1000) this takes seconds; Circle keeps a small fee, which the app adds to the amount so the full invoice arrives.
3. **Stellar.** Anyone submits `mint_and_pay(message, attestation)` to the receiver. In one transaction it mints the USDC to itself through Circle's MessageTransmitter and pays it into the vault with the reference. The app does this from the payer's browser; if the page closed, opening the link again finishes it, and the keeper CLI can too:

   ```bash
   KEEPER_SECRET=S... npx kyros-keeper --network testnet --relay-cctp <receiver> --source-domain 6 --tx 0x<burn tx>
   ```

## The receiver (`contracts/cctp-pay`)

- **No admin and no balance.** It holds USDC only inside `mint_and_pay`, between the mint and the vault's pull.
- **The client fixes where the money goes.** The vault and the reference come from the hook data of the burn the client signed; the relayer only pays the Stellar fee.
- **Only it can redeem its messages.** It is the `destinationCaller`, so nobody can mint a Kyros payment to it without paying the vault in the same transaction.
- **Exact authorization.** It predicts the vault's split (the invoice terms if registered, the vault's rule otherwise) and authorizes exactly those two transfers, as the Inbox does.
- **Nothing is lost if the vault refuses.** If the vault does not accept the token, the whole call reverts and the attested message stays redeemable.

Hook data (its first 32 bytes follow the layout of Circle's own forwarder, with a zero magic so Circle does not relay it):

| Bytes | Content |
| --- | --- |
| 0–23 | zero |
| 24–27 | version, `1` (u32, big-endian) |
| 28–31 | `64` (u32, big-endian) |
| 32–63 | the vault's contract id |
| 64–95 | the invoice reference (zero for none) |

Amounts: CCTP uses 6 decimals and Stellar USDC 7; CCTP mints `amount × 10`, and the SDK rounds up when converting so the vault never gets less.

## On testnet

The [App on testnet](../.github/workflows/app-testnet.yml) workflow deploys the receiver over Circle's testnet CCTP (TokenMessengerMinter `CDNG7HXA…`, MessageTransmitter `CBJ6MTCK…`), and new vaults accept Circle's testnet USDC as well as the test KUSD. Source networks: Base Sepolia, Ethereum Sepolia, Arbitrum Sepolia, OP Sepolia and Avalanche Fuji; free test USDC is at [faucet.circle.com](https://faucet.circle.com). Addresses are in [`sdk/src/cctp.ts`](../sdk/src/cctp.ts), from Circle's [Stellar contracts](https://developers.circle.com/cctp/references/stellar-contracts), [contract addresses](https://developers.circle.com/cctp/references/contract-addresses) and [USDC addresses](https://developers.circle.com/stablecoins/usdc-contract-addresses) pages.

The automated tests cover the receiver against mock Circle contracts (minting, invoice terms, Circle's fee, replay, wrong recipient or caller, foreign hook data, a refusing vault), the EVM encoding against viem, and, in the browser, wallet discovery and Circle's attestation service answering the page. A real burn on a source testnet needs test USDC from Circle's faucet, which a person has to claim.

## Wallets for the vault owner

The owner signs in with any wallet that signs on Stellar: LOBSTR, xBull, Freighter, Albedo, Hana, Rabet, Klever, Scopuly, multichain wallets that support Stellar (MetaMask, Bitget, OneKey, HOT) and Ledger, through Stellar Wallets Kit, or with a passkey (Face ID). Owning a vault from a wallet that only signs on Ethereum or Solana is in the [backlog](backlog.md).
