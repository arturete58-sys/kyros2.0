# Stellar integration

| Building block | Used for | Where |
| --- | --- | --- |
| Soroban smart contracts (soroban-sdk 28) | Router, Inbox, Reserve Vault | `contracts/` |
| Constructors (`__constructor`) | Each vault and inbox is created with its terms in one deployment | `ReserveVault::__constructor`, `Inbox::__constructor` |
| Soroban authorization | One payer signature covers `Router.pay` and both transfers; the owner signs money out | `require_auth` in the Router and the vault |
| Contract authorization | The Inbox authorizes exactly the vault's two transfers for a sweep | `authorize_as_current_contract` in `Inbox::sweep` |
| SEP-41 token interface | Every amount moves through `transfer` on a Stellar Asset Contract (USDC, EURC) | `token::Client` in the vault |
| Contract events | Dashboard, accountant view, CSV export | `kyros_vault`, `kyros_router`, `kyros_inbox` topics; `sdk/src/events.ts` |
| Stellar RPC | Simulate, submit, follow transactions; read events | `sdk/src/client.ts` |
| SEP-7 transaction links | Invoice links a wallet opens and signs | `sdk/src/sep7.ts` |
| Circle's CCTP V2 | A client pays from Ethereum, Base, Arbitrum, OP or Avalanche | the Kyros CCTP receiver is `mintRecipient` and `destinationCaller`; `mint_and_pay` mints and pays the vault with the invoice reference in one transaction ([cross-chain payments](cross-chain-payments.md)) |
| x402 on Stellar | API sellers set their payment address to a Kyros inbox | the inbox accepts the SEP-41 transfer an x402 payment makes |
| Passkeys (secp256r1) | Seedless wallets in the web app | planned web app; pattern from the team's earlier work |
| SEP-1, SEP-10, SEP-24, SEP-6 | Paying the tax in euros through an anchor: stellar.toml, login, withdrawal | `sdk/src/anchor.ts` |
| Muxed addresses (CAP-67) | The vault pays an anchor with its memo as muxed id | `pay_tax_to(…, MuxedAddress)` |
| SEP-40 price oracles (Reflector) | Floor for converting the reserve into euros | `OracleApi` in `contracts/types`, `Conversion` in the vault |
| Soroswap | Swapping the reserve from USDC to EURC | `contracts/swap-soroswap` |
| Blend v2 | Lending part of the reserve | `contracts/yield-blend` |
| EURC (Circle) | The reserve in euros | `sdk/src/assets.ts` |
| SEP-55 build metadata | The testnet workflow builds with `source_repo` metadata | `.github/workflows/testnet-demo.yml` |

## Events

| Contract | Topics | Data |
| --- | --- | --- |
| Vault | `kyros_vault`, `received`, token, period | from, reference, gross, net, vat, parts, reserve |
| Vault | `kyros_vault`, `tax_paid`, token, period | bucket, amount, destination, memo |
| Vault | `kyros_vault`, `converted`, period | from_token, to_token, amount_in, amount_out, floor |
| Vault | `kyros_vault`, `invested` / `harvested`, token | amount |
| Vault | `kyros_vault`, `invoice_expected`, reference | terms |
| Vault | `kyros_vault`, `conversion_proposed` / `strategy_proposed` / `conversion_stopped` / `strategy_stopped` | the proposal and ready_at, or what came back |
| Vault | `kyros_vault`, `released`, token, period | amount |
| Vault | `kyros_vault`, `rule_proposed` / `destination_proposed` | new value, ready_at |
| Vault | `kyros_vault`, `rule_applied` / `destination_applied` / `change_cancelled` | new value or what was cancelled |
| Router | `kyros_router`, `paid`, vault, reference | from, token, gross, net, reserve |
| Inbox | `kyros_inbox`, `swept`, token | gross, net, reserve, ledger |
| Inbox | `kyros_inbox`, `returned`, token | amount |
