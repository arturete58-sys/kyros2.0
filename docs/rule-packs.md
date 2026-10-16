# Rule packs

A rule pack is a JSON file per jurisdiction ([schema](../rule-packs/schema.json)). It holds the country's VAT tables with their dates, suggested vault presets, the fiscal calendar and a simplified tax estimate. The vault enforces percentages and dates; it does not compute taxes, and a new country is a new file with no contract change.

| Field | Meaning |
| --- | --- |
| `vatRates[]` | The country's VAT, GST or sales-tax rates, each table with the date it applies from (`proposed: true` for announced changes that are not law yet) |
| `presets[].vatRate` | Which rate of the table a preset charges; the rule follows the table's dates |
| `presets[].buckets[]` | Suggested reserves as a share of the taxable base (`name`, `bps`) |
| `presets[].covers` | What the reserve is meant to cover: `incomeTax`, `social` or both |
| `estimate` | Simplified annual estimate (income-tax brackets, social contributions) used by the reserve check |
| `period`, `dueOffsetDays` | Calendar months, quarters or years (UTC) and the days after a period ends until its leftover reserve can be released |
| `reviewed` | Date the rates were last checked against the sources |

## The user chooses the reserve

Presets are a starting point. The user picks one of the country's VAT rates and sets the reserve they want, and `checkReserve` tells them whether it is enough for their country, regime, activity and income:

```ts
import { loadRulePack, customRule, checkReserve } from 'kyros-sdk';

const es = loadRulePack('es');
// A software freelancer in Spain expecting EUR 80,000 a year, choosing a 20% reserve.
const check = checkReserve(es, 'general', { revenue: 80_000, activity: 'software', reserveBps: 2000 });
// check.status: 'short' | 'ok' | 'generous' | 'unknown'
// check.requiredBps, check.owed, check.shortfall, check.lines (each tax and contribution)

const rule = customRule(es, { vatRate: 'standard', reserves: [{ name: 'irpf', bps: 2500 }] }); // VAT in force + the user's reserve
```

- **short**: the reserve is below the estimated tax; the app suggests the required percentage.
- **ok**: the reserve covers the estimate with less than 10 points to spare.
- **generous**: more than 10 points above; the surplus goes back to the user after the release date anyway.
- **unknown**: no estimate for that jurisdiction yet (Switzerland, Luxembourg and Argentina, where income tax depends on canton, tax class or twice-yearly indexation); the user compares with their adviser's figure.

Inputs are annual and in the pack's currency: expected revenue (VAT excluded), expenses (or an activity profile with typical costs: software, consulting, creative, education, e-commerce, hospitality), fixed contributions the user already knows (a flat monthly social fee), and an extra rate for regional, state, cantonal or church tax. Estimates cover national income tax for a single self-employed person and the main social contributions, with the simplifications stated in each pack. They are for planning, not a tax calculation.

## VAT tables follow their dates

`termsFromPack` and `customRule` take the rate in force on the day the vault is created. After that, `vatUpdatePlan` tells the app what to do so the vault keeps following the table:

| Action | When | What the owner signs |
| --- | --- | --- |
| `none` | the vault charges the rate in force and no enacted change is coming | nothing |
| `schedule` | an enacted change is coming | `propose_rule_at(rule, effectiveAt)`, any time before `signBy`; the vault switches at 00:00 UTC on the change date |
| `update` | the vault's rate is out of date | `propose_rule(rule)`; it applies after the notice |
| `review` | a change is only proposed, or the preset's rate ends | nothing yet; the user chooses |

The vault keeps the user's reserves as they are; only the VAT rate changes. The contract never applies a scheduled rule before its notice period has run, and the owner can `cancel` it until it takes effect. The [testnet demo](testnet/README.md) runs this with the Thailand pack: the owner signs 7% to 10% ahead, the vault keeps 7% until the change time and charges 10% from then on without another signature. Changes on file today:

- Vietnam: the temporary 8% rate ends after 31 December 2026; vaults on it are flagged for 10%.
- Thailand: 7% until 30 September 2027, then the statutory 10% unless extended again.
- Switzerland: 8.5% from 2028, proposed and subject to a popular vote, so reported but never applied.

A [weekly workflow](../.github/workflows/vat-rates.yml) compares the EU and UK tables with an independent, maintained dataset ([ibericode/vat-rates](https://github.com/ibericode/vat-rates)) and flags any pack not reviewed in 180 days; when something differs it opens an issue.

## How the calendar is chosen

Each tax can be paid from the vault to the tax-payment destination whenever it is due. The release date only decides when what is left goes back to the owner, so a pack uses the latest deadline among the taxes it reserves: monthly or quarterly where every tax is settled that way (Georgia, Spain, Ukraine, Vietnam, French micro-entrepreneurs), the annual income-tax deadline elsewhere. Where the fiscal year is not the calendar year (India, Pakistan, Australia, South Africa, the UK), the offset reaches the return deadline for the last months of the calendar year. The release date is never earlier than the deadline it protects.

<!-- packs:start -->
## Jurisdictions (42)

| Pack | Jurisdiction | Currency | Consumption tax in force | Calendar | Presets | Reserve check |
| --- | --- | --- | --- | --- | --- | --- |
| [AD](../rule-packs/ad.json) | Andorra | EUR | IGI 4.5% / 1% | Year + 212 days | `standard`, `not-igi-registered` | yes |
| [AE](../rule-packs/ae.json) | United Arab Emirates | AED | VAT 5% | Quarter + 28 days | `vat-only`, `vat-and-corporate-tax` | yes |
| [AR](../rule-packs/ar.json) | Argentina | ARS | IVA 27% / 21% / 10.5% | Year + 181 days | `responsable-inscripto`, `exportacion-servicios`, `monotributo` | no |
| [AU](../rule-packs/au.json) | Australia | AUD | GST 10% | Year + 304 days | `gst`, `not-gst-registered` | yes |
| [BR](../rule-packs/br.json) | Brazil | BRL | ISS / CBS / IBS: see notes | Month + 20 days | `simples-anexo-iii`, `simples-anexo-v`, `pessoa-fisica` | yes |
| [BS](../rule-packs/bs.json) | The Bahamas | BSD | VAT 10% | Quarter + 21 days | `vat-only` | yes |
| [CA](../rule-packs/ca.json) | Canada | CAD | GST/HST 15% / 14.98% / 14% / 13% / 5% | Year + 120 days | `gst`, `hst-13`, `hst-14`, `hst-15`, `gst-qst`, `small-supplier` | yes |
| [CH](../rule-packs/ch.json) | Switzerland | CHF | MWST / TVA / IVA 8.1% / 3.8% / 2.6%; changes 2028-01-01 (proposed) | Year + 120 days | `standard`, `reduced-vat`, `accommodation-vat`, `not-vat-registered` | no |
| [CO](../rule-packs/co.json) | Colombia | COP | IVA 19% / 5% | Year + 293 days | `responsable-iva`, `no-responsable-iva` | yes |
| [CY](../rule-packs/cy.json) | Cyprus | EUR | VAT 19% / 9% / 5% | Year + 396 days | `standard`, `reduced-vat`, `not-vat-registered` | yes |
| [DE](../rule-packs/de.json) | Germany | EUR | USt 19% / 7% | Year + 300 days | `standard`, `reduced-vat`, `small-business` | yes |
| [EE](../rule-packs/ee.json) | Estonia | EUR | Käibemaks 24% / 13% / 9% | Year + 274 days | `standard`, `accommodation-vat`, `not-vat-registered` | yes |
| [ES](../rule-packs/es.json) | Spain | EUR | IVA 21% / 10% / 4% | Quarter + 30 days | `general`, `reduced-vat`, `super-reduced-vat`, `no-vat`, `vat-only` | yes |
| [FR](../rule-packs/fr.json) | France | EUR | TVA 20% / 10% / 5.5% / 2.1% | Quarter + 31 days | `micro-bnc`, `micro-bnc-vl`, `micro-bic-services`, `micro-bnc-vat` | yes |
| [GB](../rule-packs/gb.json) | United Kingdom | GBP | VAT 20% / 5% | Year + 396 days | `standard`, `reduced-vat`, `not-vat-registered` | yes |
| [GE](../rule-packs/ge.json) | Georgia | GEL | VAT 18% | Month + 15 days | `small-business`, `small-business-vat` | yes |
| [HK](../rule-packs/hk.json) | Hong Kong | HKD | none | Year + 365 days | `profits-tax` | yes |
| [ID](../rule-packs/id.json) | Indonesia | IDR | PPN 12% / 11% | Year + 90 days | `umkm-final`, `pkp-umkm`, `regular` | yes |
| [IE](../rule-packs/ie.json) | Ireland | EUR | VAT 23% / 13.5% / 9% / 4.8% | Year + 304 days | `standard`, `reduced-vat`, `second-reduced-vat`, `not-vat-registered` | yes |
| [IN](../rule-packs/in.json) | India | INR | GST 40% / 18% / 5% | Year + 212 days | `presumptive-gst`, `presumptive-export`, `regular-gst` | yes |
| [IT](../rule-packs/it.json) | Italy | EUR | IVA 22% / 10% / 5% / 4% | Year + 181 days | `forfettario`, `forfettario-startup`, `ordinario` | yes |
| [JP](../rule-packs/jp.json) | Japan | JPY | Consumption tax 10% / 8% | Year + 90 days | `taxable`, `exempt` | yes |
| [KE](../rule-packs/ke.json) | Kenya | KES | VAT 16% | Year + 181 days | `turnover-tax`, `vat`, `no-vat` | yes |
| [KR](../rule-packs/kr.json) | South Korea | KRW | VAT 10% | Year + 151 days | `general`, `vat-exempt-freelancer` | yes |
| [LU](../rule-packs/lu.json) | Luxembourg | EUR | TVA 17% / 14% / 8% / 3% | Year + 365 days | `standard`, `intermediate-vat`, `reduced-vat`, `franchise` | no |
| [MT](../rule-packs/mt.json) | Malta | EUR | VAT 18% / 7% / 5% | Year + 181 days | `standard`, `reduced-vat`, `article-11` | yes |
| [MX](../rule-packs/mx.json) | México | MXN | IVA 16% / 8% | Year + 120 days | `resico`, `resico-frontera`, `resico-exportacion`, `actividad-empresarial` | yes |
| [NG](../rule-packs/ng.json) | Nigeria | NGN | VAT 7.5% | Year + 90 days | `freelancer`, `vat-registered` | yes |
| [NL](../rule-packs/nl.json) | Netherlands | EUR | BTW 21% / 9% | Year + 120 days | `standard`, `reduced-vat`, `kor` | yes |
| [PA](../rule-packs/pa.json) | Panama | USD | ITBMS 7% | Year + 75 days | `itbms`, `itbms-foreign-source`, `no-itbms` | yes |
| [PH](../rule-packs/ph.json) | Philippines | PHP | VAT 12% | Year + 105 days | `eight-percent`, `graduated-non-vat`, `vat-registered` | yes |
| [PK](../rule-packs/pk.json) | Pakistan | PKR | Sales tax 18% | Year + 273 days | `it-export-pseb`, `it-export`, `local-services` | yes |
| [PR](../rule-packs/pr.json) | Puerto Rico | USD | IVU 11.5% / 4% | Year + 105 days | `act-60-export-services`, `ivu`, `b2b-services` | yes |
| [PT](../rule-packs/pt.json) | Portugal | EUR | IVA 23% / 13% / 6% | Year + 181 days | `standard`, `intermediate-vat`, `reduced-vat`, `vat-exempt` | yes |
| [SG](../rule-packs/sg.json) | Singapore | SGD | GST 9% | Year + 365 days | `gst`, `not-gst-registered` | yes |
| [SV](../rule-packs/sv.json) | El Salvador | USD | IVA 13% | Year + 120 days | `iva`, `exportacion` | yes |
| [TH](../rule-packs/th.json) | Thailand | THB | VAT 7%; changes 2027-10-01 | Year + 98 days | `vat-registered`, `not-vat-registered` | yes |
| [TR](../rule-packs/tr.json) | Türkiye | TRY | KDV 20% / 10% / 1% | Year + 212 days | `kdv-standard`, `kdv-reduced`, `export-services` | yes |
| [UA](../rule-packs/ua.json) | Ukraine | UAH | VAT (ПДВ) 20% / 14% / 7% | Quarter + 50 days | `fop-group-3`, `fop-group-3-vat` | yes |
| [US](../rule-packs/us.json) | United States | USD | none | Year + 105 days | `no-state-income-tax`, `with-state-income-tax`, `with-sales-tax-example` | yes |
| [VN](../rule-packs/vn.json) | Vietnam | VND | VAT (GTGT) 10% / 8% / 5%; changes 2027-01-01 | Quarter + 30 days | `household-services`, `company-vat`, `company-vat-8` | yes |
| [ZA](../rule-packs/za.json) | South Africa | ZAR | VAT 15% | Year + 273 days | `vat`, `not-vat-registered` | yes |
<!-- packs:end -->

## Coverage

- **Crypto hubs and friendly regimes:** UAE, Switzerland, Singapore, Hong Kong, Malta, Cyprus (8% on crypto gains from 2026), Estonia, Portugal, Georgia, Andorra, El Salvador, Panama (territorial), Puerto Rico (Act 60), the Bahamas (no income tax).
- **Highest crypto adoption** (Chainalysis 2025 Global Crypto Adoption Index): India, the United States, Pakistan, Vietnam, Brazil, Nigeria, Indonesia, Ukraine, the Philippines, the United Kingdom, Japan, Argentina, South Korea, Thailand; plus Türkiye, Mexico, Colombia, Kenya and South Africa.
- **Major economies:** Germany, France, Italy, Spain, the Netherlands, Ireland, Luxembourg, Canada, Australia.

Russia is not included: sanctions restrict the stablecoin and anchor services a vault depends on. Jurisdictions with no tax on income and no consumption tax (Cayman Islands, Bermuda) need no vault.

Rule packs are information, not tax advice. The user confirms the percentages; the vault enforces what the user chose.
