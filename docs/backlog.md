# Backlog

Ideas noted and not built yet, with what each would need.

| Idea | What it is | Needs |
| --- | --- | --- |
| Proof of income | A signed certificate of income received and tax set aside (rentals, loans, digital-nomad visas), later revealing only what is needed | Data protection (GDPR) design; selective disclosure |
| Accountant panel | Read-only view of all of an accountant's Kyros clients, with exports for the tax forms | Not a priority yet |
| Privacy | A public ledger shows income and clients; per-invoice addresses or confidential tokens would hide it | Protocol support for confidential transfers |
| Vault owner with an Ethereum or Solana-only wallet | Phantom, Rabby or Coinbase Wallet (EVM) owning a vault, not just paying one | A smart-wallet contract that verifies secp256k1 (EIP-191/712) or Solana ed25519 message signatures as the owner; security review and audit before use |
| Paying from Solana | The same cross-chain payment from Solana wallets | CCTP's Solana programs instead of the EVM calls |
| Payers that only send to G accounts | Some payout systems (exchanges, some grant and payroll tools) only pay classic `G…` accounts, not an Inbox contract | A per-user classic account that forwards to the Inbox, or the payer's support for contract addresses |
| Readable payment address | `name*kyros.app` instead of a `C…` address (SEP-2 federation) | A domain and a small federation server (a cost to approve); SEP-2 answers with accounts, so it pairs with the item above |
| Blockpit export | Blockpit's import template | Its template's exact columns |
| Smart-wallet login at anchors | SEP-45 for passkey (contract) wallets | SDK work |
| Anchors with text or hash memos | A path for anchors that do not accept id memos | An intermediate account, or the anchor's support for muxed addresses |
| Issuing invoices (left out on purpose) | Facturae and UBL/Peppol invoices, VERI\*FACTU records and QR, sending to the AEAT and over Peppol. A first version, validated against the official schemas, is in the history at commit 6f51723 | Makes Kyros invoicing software under Spain's RD 1007/2023 (responsible declaration, AEAT submission with certificates); Spain only; better as an integration with existing invoicing tools |
| A payment without an invoice that is different | "This payment had no VAT" for a single payment that came without a registered invoice | Owner-signed reclassification of a received payment |
| Blend on testnet | The demo lending part of the reserve on a Blend testnet pool | A pool with the demo token and an active backstop |
| Rule packs | Italian regional and municipal surcharges, Liechtenstein communes, Luxembourg tax classes 1a and 2, local business taxes; official checks for the remaining ~20 countries; automated OECD brackets | Data work |
