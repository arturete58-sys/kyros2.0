# Rule packs

A rule pack is a JSON file per jurisdiction ([schema](../rule-packs/schema.json)) that suggests a vault's split rule and fiscal calendar. The vault enforces percentages and dates; it does not compute taxes, and a new country is a new file with no contract change.

| Field | Meaning |
| --- | --- |
| `period` | `Month`, `Quarter` or `Year` (UTC calendar), the period reserves are grouped by |
| `dueOffsetDays` | Days after a period ends until its leftover reserve can be released to the owner |
| `presets[].vatBps` | VAT, GST or sales tax included in the gross amount, in basis points |
| `presets[].buckets[]` | Other reserves as a share of the taxable base (`name`, `bps`) |
| `presets[].period`, `presets[].dueOffsetDays` | Optional per-preset calendar (e.g. UAE corporate tax is yearly, VAT quarterly) |

**How the calendar is chosen.** Each tax can be paid from the vault to the tax-payment destination whenever it is due, at any time. The release date only decides when what is left goes back to the owner, so a pack uses the latest deadline among the taxes it reserves: quarterly where every tax is settled quarterly (Spain, French micro-entrepreneurs), the annual income-tax deadline elsewhere. The release date is never earlier than the deadline it protects.

**Income-tax reserves are suggestions.** Income tax is progressive almost everywhere; the packs reserve a flat share of the taxable base, chosen to cover what most self-employed users owe, and the surplus goes back after the release date. VAT, GST and fixed-rate regimes (French URSSAF rates, Italian forfettario, Georgian 1%) are applied at their legal rates.

## Jurisdictions (17)

| Pack | Jurisdiction | Currency | Calendar | Presets |
| --- | --- | --- | --- | --- |
| [AD](../rule-packs/ad.json) | Andorra | EUR | Year + 212 days | `standard`: IGI 4.5% + IRPF reserve 10%<br>`not-igi-registered`: No IGI charged + IRPF reserve 10% |
| [AE](../rule-packs/ae.json) | United Arab Emirates | AED | Quarter + 28 days | `vat-only`: VAT 5%, no personal income tax<br>`vat-and-corporate-tax`: VAT 5% + corporate tax 9% (taxable profit above AED 375,000) |
| [CH](../rule-packs/ch.json) | Switzerland | CHF | Year + 120 days | `standard`: VAT 8.1% + income tax and AHV reserve 25%<br>`reduced-vat`: VAT 2.6% + reserve 25%<br>`accommodation-vat`: Accommodation VAT 3.8% + reserve 25%<br>`not-vat-registered`: Below the VAT registration threshold: reserve 25% |
| [DE](../rule-packs/de.json) | Germany | EUR | Year + 300 days | `standard`: VAT 19% + income tax reserve 30%<br>`reduced-vat`: Reduced VAT 7% + income tax reserve 30%<br>`small-business`: Small-business exemption (Kleinunternehmer, §19 UStG): no VAT + income tax reserve 30% |
| [EE](../rule-packs/ee.json) | Estonia | EUR | Year + 274 days | `standard`: VAT 24% + income and social tax reserve 40%<br>`accommodation-vat`: Accommodation VAT 13% + reserve 40%<br>`not-vat-registered`: Below the VAT registration threshold: reserve 40% |
| [ES](../rule-packs/es.json) | Spain | EUR | Quarter + 30 days | `general`: General VAT 21% + income-tax prepayment 20%<br>`reduced-vat`: Reduced VAT 10% + income-tax prepayment 20%<br>`super-reduced-vat`: Super-reduced VAT 4% + income-tax prepayment 20%<br>`no-vat`: No VAT charged (exports, EU B2B reverse charge) + income-tax prepayment 20%<br>`vat-only`: VAT 21% only (income tax handled elsewhere) |
| [FR](../rule-packs/fr.json) | France | EUR | Quarter + 31 days | `micro-bnc`: Liberal profession (BNC, non-regulated), VAT franchise: URSSAF 25.8%<br>`micro-bnc-vl`: BNC with versement libératoire: URSSAF 25.8% + income tax 2.2%<br>`micro-bic-services`: Services (BIC), VAT franchise: URSSAF 21.5%<br>`micro-bnc-vat`: BNC above the VAT franchise: VAT 20% + URSSAF 25.8% |
| [GB](../rule-packs/gb.json) | United Kingdom | GBP | Year + 396 days | `standard`: VAT 20% + income tax and Class 4 NIC reserve 30%<br>`reduced-vat`: VAT 5% + reserve 30%<br>`not-vat-registered`: Below the VAT registration threshold: reserve 30% |
| [GE](../rule-packs/ge.json) | Georgia | GEL | Month + 15 days | `small-business`: Small business status: 1% of turnover, no VAT<br>`small-business-vat`: Small business status registered for VAT: VAT 18% + 1% of turnover |
| [HK](../rule-packs/hk.json) | Hong Kong | HKD | Year + 365 days | `profits-tax`: No VAT + profits tax reserve 15% (two-tier: 7.5% then 15%) |
| [IE](../rule-packs/ie.json) | Ireland | EUR | Year + 304 days | `standard`: VAT 23% + income tax, USC and PRSI reserve 35%<br>`reduced-vat`: VAT 13.5% + reserve 35%<br>`second-reduced-vat`: VAT 9% + reserve 35%<br>`not-vat-registered`: Below the VAT registration threshold: reserve 35% |
| [IT](../rule-packs/it.json) | Italy | EUR | Year + 181 days | `forfettario`: Flat-rate regime (forfettario, 15%), no VAT: tax and INPS reserve 32%<br>`forfettario-startup`: Flat-rate regime for start-ups (5%), no VAT: reserve 24%<br>`ordinario`: Ordinary regime: IVA 22% + income tax and INPS reserve 35% |
| [LU](../rule-packs/lu.json) | Luxembourg | EUR | Year + 365 days | `standard`: VAT 17% + income tax reserve 30%<br>`intermediate-vat`: VAT 14% + income tax reserve 30%<br>`reduced-vat`: VAT 8% + income tax reserve 30%<br>`franchise`: VAT franchise for small businesses: no VAT + income tax reserve 30% |
| [NL](../rule-packs/nl.json) | Netherlands | EUR | Year + 120 days | `standard`: BTW 21% + income tax reserve 30%<br>`reduced-vat`: BTW 9% + income tax reserve 30%<br>`kor`: Small-business scheme (KOR): no VAT + income tax reserve 30% |
| [PT](../rule-packs/pt.json) | Portugal | EUR | Year + 181 days | `standard`: IVA 23% (mainland) + income tax and social security reserve 30%<br>`intermediate-vat`: IVA 13% + reserve 30%<br>`reduced-vat`: IVA 6% + reserve 30%<br>`vat-exempt`: VAT exemption for small businesses (art. 53 CIVA): reserve 30% |
| [SG](../rule-packs/sg.json) | Singapore | SGD | Year + 365 days | `gst`: GST 9% + income tax reserve 15%<br>`not-gst-registered`: Below the GST registration threshold: income tax reserve 15% |
| [US](../rule-packs/us.json) | United States | USD | Year + 105 days | `no-state-income-tax`: Federal income tax + self-employment tax, state without income tax: reserve 30%<br>`with-state-income-tax`: Federal + state income tax + self-employment tax: reserve 35%<br>`with-sales-tax-example`: Example: 8% sales tax collected + federal reserve 30% |

Lower-tax jurisdictions popular with crypto entrepreneurs are covered by the same mechanism: the UAE (VAT 5%, no personal income tax), Switzerland (VAT 8.1%), Hong Kong (no VAT, profits tax from 7.5%), Georgia (1% of turnover under small-business status), Andorra (IGI 4.5%, IRPF up to 10%) and Singapore (GST 9%). Jurisdictions with no tax on the income at all need no vault.

Each pack lists its sources and the date of the rates (`version` 2026.1, October 2026). Rates change; packs are versioned and a vault only changes rule through `propose_rule`, with notice.

Rule packs are information, not tax advice. The user confirms the percentages; the vault enforces what the user chose.

```ts
import { listRulePacks, loadRulePack, termsFromPack } from 'kyros-sdk';
listRulePacks();                                        // ['ad', 'ae', 'ch', 'de', 'ee', 'es', ...]
const terms = termsFromPack(loadRulePack('de'), 'standard'); // { rule, period, dueOffsetSecs }
```
