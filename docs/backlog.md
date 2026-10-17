# Backlog

Ideas noted and not built yet, with what each would need.

| Idea | What it is | Needs |
| --- | --- | --- |
| Payment platforms | An API so platforms that pay freelancers in stablecoins pay into the freelancer's Kyros inbox and show "taxes set aside" | Kyros only provides software; the money goes from the platform to the user's vault |
| Proof of income | A signed certificate of income received and tax set aside (rentals, loans, digital-nomad visas), later revealing only what is needed | Data protection (GDPR) design; selective disclosure |
| Accountant panel | Read-only view of all of an accountant's Kyros clients, with exports for the tax forms | Not a priority yet |
| Privacy | A public ledger shows income and clients; per-invoice addresses or confidential tokens would hide it | Protocol support for confidential transfers |
| Smart-wallet login at anchors | SEP-45 for passkey (contract) wallets | SDK work |
| Anchors with text or hash memos | A path for anchors that do not accept id memos | An intermediate account, or the anchor's support for muxed addresses |
| Issuing invoices (left out on purpose) | Facturae and UBL/Peppol invoices, VERI\*FACTU records and QR, sending to the AEAT and over Peppol. A first version, validated against the official schemas, is in the history at commit 6f51723 | Makes Kyros invoicing software under Spain's RD 1007/2023 (responsible declaration, AEAT submission with certificates); Spain only; better as an integration with existing invoicing tools |
| A payment without an invoice that is different | "This payment had no VAT" for a single payment that came without a registered invoice | Owner-signed reclassification of a received payment |
| Blend on testnet | The demo lending part of the reserve on a Blend testnet pool | A pool with the demo token and an active backstop |
| Rule packs | Italian regional and municipal surcharges, Liechtenstein communes, Luxembourg, local business taxes; official checks for the remaining ~20 countries; automated OECD brackets | Data work |
