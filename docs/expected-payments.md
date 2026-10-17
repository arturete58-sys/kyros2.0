# Expected payments: a payment the vault splits exactly

A payment that carries an invoice's reference is split by that payment's own terms, not by the vault's general rule. This matters most in Spain, where a business client withholds 15% IRPF from a freelancer's invoice and pays it to the tax authority itself: the client pays base + VAT − 15%, and a split that assumed base + VAT would reserve too little VAT.

| Invoice: base 1,000, VAT 21%, IRPF 15% withheld | Client pays | VAT reserved | Income-tax reserve | To the freelancer |
| --- | --- | --- | --- | --- |
| Split by the general rule (VAT 21% + 20%) | 1,060 | 184 | 175 | 701 |
| Split by the payment's terms (VAT 21%, withholding 15%, reserve 5%) | 1,060 | **210** | 50 | 800 |

**Kyros does not issue invoices.** The user invoices with the tool they already use (their accountant's, Holded, Quipu…). Kyros only needs the invoice number, the amounts and the rates, to tell the vault how to split that payment and to send the client a payment request. A payment request without an invoice number series and the legally required invoice data is not an invoice, so Kyros stays outside the rules for invoicing software (in Spain, Real Decreto 1007/2023 and VERI\*FACTU).

## How

1. The SDK computes the totals (`sdk/src/payment-request.ts`): each line to the cent, VAT per rate, then the withholding.
2. `requestTerms(request, buckets)` gives the terms; the owner signs `expect_invoice(reference, terms)`, where the reference is sha256 of the invoice number (the number itself never goes onchain).
3. The client pays through the Router with that reference; the vault applies `split_withheld`:

```text
base = floor(gross * 10000 / (10000 + vat_bps - withholding_bps))
vat  = floor(base * vat_bps / 10000)
part = floor(base * bps / 10000)        net = gross - vat - sum(part)
```

The withholding and the buckets together may not exceed the base, so the net amount is never negative. Payments without a registered reference (and plain transfers into the Inbox, which carry no reference) still follow the vault's rule. Payments from clients abroad or reverse-charged in the EU register 0% VAT the same way.

The testnet demo runs this case with real transactions: terms registered, 1,060 paid, 210 VAT and 50 income tax reserved, 800 to the freelancer ([latest run](testnet)).
