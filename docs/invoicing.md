# Invoices that the vault splits exactly

A payment that carries an invoice's reference is split by that invoice's own terms, not by the vault's general rule. This matters most in Spain, where a business client withholds 15% IRPF from a freelancer's invoice and pays it to the tax authority itself: the client pays base + VAT − 15%, and a split that assumed base + VAT would reserve too little VAT.

| Invoice: base 1,000, VAT 21%, IRPF 15% withheld | Client pays | VAT reserved | Income-tax reserve | To the freelancer |
| --- | --- | --- | --- | --- |
| Split by the general rule (VAT 21% + 20%) | 1,060 | 184 | 175 | 701 |
| Split by the invoice's terms (VAT 21%, withholding 15%, reserve 5%) | 1,060 | **210** | 50 | 800 |

## How

1. The SDK builds the invoice (`sdk/src/invoice.ts`) and computes its totals with the rounding EN 16931 prescribes.
2. `vaultTerms(invoice, buckets)` gives the terms; the owner signs `expect_invoice(reference, terms)`, where the reference is sha256 of the invoice number (the invoice itself never goes onchain).
3. The client pays through the Router with that reference; the vault applies `split_withheld`:

```text
base = floor(gross * 10000 / (10000 + vat_bps - withholding_bps))
vat  = floor(base * vat_bps / 10000)
part = floor(base * bps / 10000)        net = gross - vat - sum(part)
```

The withholding and the buckets together may not exceed the base, so the net amount is never negative. Payments without a registered reference (and plain transfers into the Inbox, which carry no reference) still follow the vault's rule. Invoices to clients abroad or reverse-charged in the EU register 0% VAT the same way.

## Formats

| Output | Function | Use |
| --- | --- | --- |
| UBL 2.1, Peppol BIS Billing 3.0 (EN 16931) | `toUbl` | EU and international clients. The Stellar payment goes in PaymentMeans (code ZZZ) with the invoice number as payment reference. EN 16931 has no withholding, so invoices with IRPF are refused here. |
| Facturae 3.2.2, unsigned | `toFacturae` | Spanish clients, including IRPF withholding (tax type 04). A signature is needed only for the public sector (FACe). |
| VERI\*FACTU registration record | `verifactuAlta`, `verifactuHash` | The chained SHA-256 record a Spanish billing system must keep, with Madrid time and its offset. |
| VERI\*FACTU QR | `verifactuQrUrl` | The AEAT verification URL printed as a QR on the invoice. |

**Checked against the official artefacts.** The `invoice-formats` CI job writes sample invoices with the SDK and validates them: Facturae against the Facturae 3.2.2 XSD; UBL against the OASIS UBL 2.1 XSD and the EN 16931 and Peppol BIS 3.0 Schematron rules (OpenPEPPOL release 2026.5). The VERI\*FACTU hash reproduces the test vectors of an independent implementation (josemmo/Verifactu-PHP).

**Not done yet.** Sending VERI\*FACTU records to the AEAT (it needs the issuer's certificate), signing Facturae, and sending invoices over Peppol or Spain's public e-invoicing solution. A product that issues invoices is a billing system under Spain's Real Decreto 1007/2023, and its producer has to sign the responsible declaration that the software complies.

## The calendar (as of October 2026)

| Rule | Date | Source |
| --- | --- | --- |
| VERI\*FACTU for companies paying corporate income tax | 1 January 2027 | Real Decreto-ley 15/2025, which postponed the original dates ([summary](https://invoo.es/es/blog/guias/verifactu-aplazado-2027-que-cambia-autonomos/)) |
| VERI\*FACTU for freelancers and everyone else | 1 July 2027 | same |
| Hacienda's announced plan to move VERI\*FACTU to October 2028, with B2B e-invoicing | not approved | needs a regulatory change that has not been published |
| Spain B2B e-invoicing (Ley 18/2022 "Crea y Crece") | 12 months (turnover above €8M) and 24 months (others) after the Ministerial Order enters into force | Real Decreto 238/2026 sets the system; the Order was a draft at the time of writing ([B2BRouter](https://www.b2brouter.net/es/ley-crea-crece-factura-electronica/)) |
| EU: member states may impose domestic e-invoicing without derogation, on EN 16931 | since 14 April 2025 | Directive (EU) 2025/516 (ViDA) ([summary](https://www.eurofiscalis.com/en/intra-eu-e-invoicing-2030/)) |
| EU: structured e-invoices and real-time reporting for intra-EU B2B | 1 July 2030 | same |

Dates change: check them before relying on them.
