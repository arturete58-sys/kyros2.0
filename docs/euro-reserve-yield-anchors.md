# Euro reserve, yield and paying through an anchor

Three opt-in features of the Reserve Vault, for a user who is paid in dollars but owes tax in euros, whose reserve sits idle for months, and who has to turn it into euros to pay. Each one keeps the vault's rules: Kyros holds nothing, and anything that decides where the reserve goes waits for the vault's notice period.

## Reserve in the tax's currency

A client pays 1,210 USDC; the vault keeps 410 for VAT and income tax. The tax is owed in euros, so if the dollar falls before the payment date the reserve falls short. With a conversion set, the reserve is swapped into EURC as soon as it arrives.

| Piece | What it is |
| --- | --- |
| `propose_conversion(Conversion)` | Owner. From and to token (both accepted by the vault), the swapper, the SEP-40 price oracle, how the oracle names each token and the tolerance. Applies after the notice. |
| `convert(period)` | Anyone (the keeper calls it after each payment). Swaps everything the period holds in the from-token. Each bucket keeps its share of what comes out. |
| `stop_conversion()` | Owner, at once. |
| Floor | The swap must return at least the oracle price minus `max_slippage_bps`, with a price no older than `max_age_secs`. Otherwise nothing moves (`SwapBelowFloor`, `PriceUnavailable`). |
| Swapper | [`contracts/swap-soroswap`](../contracts/swap-soroswap): swaps through the Soroswap router, holds nothing between calls, no admin. |
| Oracle | Reflector's fiat oracle (prices in USD, 14 decimals): `Other(USD)` is the base, `Other(EUR)` the euro. Addresses in [`sdk/src/assets.ts`](../sdk/src/assets.ts). |

A client can also pay in EURC directly; the vault accepts both tokens and books each one separately.

## Yield on the reserve

Income tax waits up to a year and VAT up to a quarter. Part of the reserve can be lent meanwhile.

| Piece | What it is |
| --- | --- |
| `propose_strategy(adapter, max_bps)` | Owner. A strategy instance whose owner is this vault, holding a token the vault accepts, may hold up to `max_bps` of the reserve in that token. Applies after the notice; one strategy at a time. |
| `invest()` | Anyone (the keeper). Moves liquid reserve into the strategy up to its share. |
| `harvest(token)` | Owner. Sends what the reserve has earned: liquid + invested − what the buckets hold. |
| `stop_strategy()` | Owner, at once. Brings everything back. |
| `position(token)` | What the vault owes (`held`), holds (`liquid`), has lent (`invested`) and has earned (`surplus`). |
| Payments out | `pay_tax`, `release` and `convert` withdraw from the strategy what they need. If the strategy cannot pay out at that moment, the payment fails with `Illiquid` and nothing moves. |
| Strategy | [`contracts/yield-blend`](../contracts/yield-blend): a plain (non-collateral) supply position in a Blend v2 pool, held by an instance that only the vault can move. It never borrows, so it cannot be liquidated. |

The buckets never change: the vault owes the same amounts whatever the strategy does. The interest belongs to the owner, and so does a loss.

**Risks the owner takes, and the app must show before turning it on:**
- The pool's bad debt, if borrowers' collateral falls faster than liquidations; Blend's backstop covers it first.
- A pool so fully lent that a withdrawal has to wait; then tax cannot be paid from the vault until borrowers repay or other lenders come in. A share below 100% (for example only the income-tax part) keeps some reserve liquid.
- Smart-contract risk in the pool and in the strategy.

**Regulatory point to check before offering it.** USDC and EURC are e-money tokens under MiCA, and article 50 forbids their issuers and crypto-asset service providers from granting interest on them. In this design the user lends from their own vault to a protocol and the return comes from borrowers; Kyros does not hold the funds, choose the strategy for the user or take a share of the return. Whether that keeps Kyros outside article 50, and outside portfolio management or investment advice, has to be confirmed by a legal review before the feature is offered in the EU.

## Paying the tax through an anchor

The vault's tax destination is a Stellar account; an anchor turns stablecoins into euros on the user's bank account, and the tax authority collects from there (in Spain, the direct debit of modelos 303 and 130).

1. `anchorInfo(domain)` reads the anchor's stellar.toml (SEP-1).
2. `anchorAuth(...)` logs in with the owner's key (SEP-10).
3. `startWithdrawal(...)` opens a euro withdrawal: SEP-24 (the anchor's web form, with its KYC and the bank account) or SEP-6.
4. `withdrawalStatus(...)` returns where to send the stablecoins: the anchor's account and memo.
5. `anchorPayout(target, taxDestination)` turns them into a muxed address (the memo as id) and refuses any account other than the vault's tax destination.
6. The owner signs `pay_tax_to(period, token, bucket, amount, muxed)`; the vault checks the account and sends the payment with the memo (CAP-67 muxed addresses).

The anchor's account becomes the tax destination once, through `propose_destination` and its notice. The anchor is the regulated party that exchanges and pays out; Kyros never receives the funds.

Limits: only id memos fit in a contract payment, so an anchor that asks for a text or hash memo cannot be paid from the vault directly. Smart-wallet (contract) owners log in with SEP-45, which the SDK does not cover yet.

## Testing against the real protocols

| What | How |
| --- | --- |
| Swapper | Against the Soroswap router, factory and pair whose wasm hashes are the ones deployed on mainnet (`4c3db3eb…`, `5db738b0…`, `18051456…`), and a vault converting 410 USDC into EURC through it. |
| Blend strategy | Against the Blend v2 pool, factory, backstop, emitter and Comet from `blend-contract-sdk` 2.22.0, set up as Blend's own fixture does: supply, interest from a borrower over a year, withdrawal to the vault, a vault paying all its tax with half its reserve lent, and a fully lent pool making the payment wait with `Illiquid`. |
| Vault | Mocks for the oracle, a fixed-rate swapper and a strategy, to test the floor, stale prices, proportional buckets, harvest and liquidity. |
| Testnet | The demo converts a KUSD reserve into KEUR through the Soroswap testnet router at Reflector's testnet EUR price, when that oracle has a fresh price. |

The wasm files and their licences are in [`contracts/vendor`](../contracts/vendor).
