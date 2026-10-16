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
| `regions[]` | Parts of a country with their own income tax (the 50 US states and DC), added when the user picks one |
| `prepayment` | How the law sets income-tax prepayments objectively: a share of last year's tax, or of each period's profit |
| `reviewed` | Date the rates were last checked against the sources |
| `sources[]` | Where each figure comes from; `official: true` for tax authorities, legislators and other public bodies, `checked` for the date it was last compared |

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
- **unknown**: no estimate for that jurisdiction yet (Switzerland, Liechtenstein, Luxembourg and Argentina, where income tax depends on canton, commune, tax class or twice-yearly indexation); the user compares with their adviser's figure.

### How far the check can be trusted

`checkReserve` returns a `precision` for every preset, shown in the table below:

| Precision | Meaning | Examples |
| --- | --- | --- |
| `exact` | The tax follows from revenue alone, or there is nothing to reserve beyond VAT | UAE, Bahrain, Monaco and the Cayman Islands (no income tax), French micro-entrepreneur, Italian forfettario, Georgia 1%, Ukraine group 3, Pakistan IT exports, Mexico RESICO, Indonesia 0.5%, Philippines 8%, Kenya turnover tax, Brazil Simples Nacional, Vietnamese households |
| `presumptive` | Progressive rates on a profit the law presumes from revenue; only personal allowances and other income change it | Portugal's simplified regime, India's section 44ADA |
| `exact-on-profit` | One rate on profit: exact once expenses are known | Estonia, Hong Kong, Puerto Rico Act 60, UAE corporate tax, Vietnamese companies |
| `estimate` | Progressive income tax with deductions and personal circumstances | Spain, Germany, the Netherlands, Ireland, the UK, the US, Canada, Australia, Japan, Korea and others |
| `none` | The tax depends on things the pack cannot know | Switzerland, Liechtenstein, Luxembourg, Argentina |

### Objective targets from last year's tax

Where the law sets prepayments from objective figures, the pack says how (`prepayment`) and the check returns the amount: meeting it avoids penalties whatever this year's final bill turns out to be.

| Pack | Rule | Official source |
| --- | --- | --- |
| US | 100% of last year's tax in four instalments, 110% above USD 150,000 of AGI | [IRS Publication 505](https://irs.gov/media/167296) |
| UK | Two payments on account, each half of last year's bill | [GOV.UK](https://www.gov.uk/understand-self-assessment-bill/payments-on-account) |
| Ireland | Preliminary tax: 100% of last year's tax (or 90% of this year's) | [Revenue](https://www.revenue.ie/en/self-assessment-and-self-employment/guide-to-self-assessment/what-is-preliminary-tax.aspx) |
| Germany | Quarterly prepayments set by the Finanzamt from the last assessment | [§ 37 EStG](https://www.gesetze-im-internet.de/estg/__37.html) |
| Spain | Modelo 130: 20% of the net profit since 1 January, each quarter | [AEAT](https://sede.agenciatributaria.gob.es/Sede/ayuda/manuales-videos-folletos/manuales-practicos/folleto-actividades-economicas/3-impuesto-sobre-renta-personas-fisicas/3_7-pagos-fraccionados.html) |

```ts
checkReserve(loadRulePack('us'), 'self-employed', { revenue: 100_000, region: 'TX', lastYearTax: 20_000, lastYearIncome: 160_000 });
// prepayment: { amount: 22000, requiredBps: 2200, covered: true }: 110% of last year's tax
```

### United States

The US pack computes federal income tax for 2026 ([Rev. Proc. 2025-32](https://www.irs.gov/pub/irs-drop/rp-25-32.pdf)) after the standard deduction (USD 16,100), half of the self-employment tax and the 20% qualified business income deduction, which phases out between USD 201,750 and 276,750 of taxable income for a sole proprietor without employees. Self-employment tax is 15.3% on 92.35% of profit up to the 2026 wage base ([SSA: USD 184,500](https://www.ssa.gov/cola/factsheets/2026.html)), then 2.9%, plus 0.9% above USD 200,000. The user picks their state: the 9 states without an income tax add nothing; the others add their 2026 brackets for a single filer ([Tax Foundation, 1 January 2026](https://taxfoundation.org/data/all/state/state-income-tax-rates-2026/)). Local taxes (New York City, Maryland counties, many Ohio and Pennsylvania cities) are entered as an extra rate.

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
- Switzerland and Liechtenstein: 8.5% from 2028, proposed and subject to a popular vote, so reported but never applied.
- Japan: food at 1% from April 2027 to March 2029 (Cabinet decision of 15 September 2026), proposed until the Diet passes it.

## VAT that follows the law with no signature

Signing each change is safe but asks something of the user. A vault can instead **follow** the Kyros Rate Registry, a public contract that lists each country's rates with the dates they apply from:

1. A maintainer reviews a change against the official source and updates the rule pack.
2. `sync-registry.mjs` publishes the change to the registry from the pack. The contract refuses any rate that would apply sooner than its fixed notice, and proposals are never published.
3. Every vault that follows that rate charges it from the legal date, with no signature. The user's reserves are not touched.

The safeguards are in the contracts. A vault only follows a registry whose notice is at least its own, so the owner always sees a change before it applies. Following changes nothing on the day it starts: the registry's rate must equal the vault's. The owner sets a ceiling, and a rate above it is ignored. `unfollow` works at once and keeps the VAT in force as the vault's own. History in the registry is final; only future entries can be corrected or withdrawn (a reform voted down).

```ts
client.followOp(vault, { registry, country: 'ES', rate: 'standard', maxBps: 2500 }); // signed once by the owner
```

## Watching the law

The [law watch](../.github/workflows/law-watch.yml) runs every Monday and opens an issue when something needs review:

1. **EU packs against the official database.** The European Commission's Taxes in Europe Database (TEDB), through its VAT Retrieval web service.
2. **EU and UK packs against an independent dataset**, [ibericode/vat-rates](https://github.com/ibericode/vat-rates).
3. **Every official page the packs cite.** The percentages and amounts on each page are compared with the last snapshot, so a new rate or threshold on a tax authority's page prompts a review in any country.

A change is reviewed by a person before it reaches the registry; nothing changes a rate automatically from a web page.

## Moving to another country

`changeCountryPlan` turns a move into steps. With the same calendar, the vault takes the new country's rule with the usual notice. With a different calendar, the user gets a new vault from the new pack and moves their inbox to it with `propose_vault`: the payment address stays the same, it pays into the new vault after the notice, and the old vault keeps its reserves and releases them on its own dates. No locked money is moved.

## How the calendar is chosen

Each tax can be paid from the vault to the tax-payment destination whenever it is due. The release date only decides when what is left goes back to the owner, so a pack uses the latest deadline among the taxes it reserves: monthly or quarterly where every tax is settled that way (Georgia, Spain, Ukraine, Vietnam, French micro-entrepreneurs), the annual income-tax deadline elsewhere. Where the fiscal year is not the calendar year (India, Pakistan, Australia, South Africa, the UK), the offset reaches the return deadline for the last months of the calendar year. The release date is never earlier than the deadline it protects.

<!-- packs:start -->
## Jurisdictions (46)

| Pack | Jurisdiction | Currency | Consumption tax in force | Calendar | Presets (precision of the reserve check) | Sources |
| --- | --- | --- | --- | --- | --- | --- |
| [AD](../rule-packs/ad.json) | Andorra | EUR | IGI 4.5% / 1% | Year + 212 days | `standard` (estimate), `not-igi-registered` (estimate) | 1 official, 0 checked 2026-10-16 |
| [AE](../rule-packs/ae.json) | United Arab Emirates | AED | VAT 5% | Quarter + 28 days | `vat-only` (exact), `vat-and-corporate-tax` (exact on profit) | 1 official, 0 checked 2026-10-16 |
| [AR](../rule-packs/ar.json) | Argentina | ARS | IVA 27% / 21% / 10.5% | Year + 181 days | `responsable-inscripto` (none), `exportacion-servicios` (none), `monotributo` (none) | 1 official, 0 checked 2026-10-16 |
| [AU](../rule-packs/au.json) | Australia | AUD | GST 10% | Year + 304 days | `gst` (estimate), `not-gst-registered` (estimate) | 2 official, 1 checked 2026-10-16 |
| [BH](../rule-packs/bh.json) | Bahrain | BHD | VAT 10% | Quarter + 31 days | `vat-only` (exact), `not-vat-registered` (exact) | 1 official, 1 checked 2026-10-16 |
| [BR](../rule-packs/br.json) | Brazil | BRL | ISS / CBS / IBS: see notes | Month + 20 days | `simples-anexo-iii` (exact), `simples-anexo-v` (exact), `pessoa-fisica` (estimate) | 1 official, 0 checked 2026-10-16 |
| [BS](../rule-packs/bs.json) | The Bahamas | BSD | VAT 10% | Quarter + 21 days | `vat-only` (exact) | 0 official, 0 checked 2026-10-16 |
| [CA](../rule-packs/ca.json) | Canada | CAD | GST/HST 15% / 14.98% / 14% / 13% / 5% | Year + 120 days | `gst` (estimate), `hst-13` (estimate), `hst-14` (estimate), `hst-15` (estimate), `gst-qst` (estimate), `small-supplier` (estimate) | 2 official, 1 checked 2026-10-16 |
| [CH](../rule-packs/ch.json) | Switzerland | CHF | MWST / TVA / IVA 8.1% / 3.8% / 2.6%; changes 2028-01-01 (proposed) | Year + 120 days | `standard` (none), `reduced-vat` (none), `accommodation-vat` (none), `not-vat-registered` (none) | 2 official, 1 checked 2026-10-16 |
| [CO](../rule-packs/co.json) | Colombia | COP | IVA 19% / 5% | Year + 293 days | `responsable-iva` (estimate), `no-responsable-iva` (estimate) | 1 official, 0 checked 2026-10-16 |
| [CY](../rule-packs/cy.json) | Cyprus | EUR | VAT 19% / 9% / 5% | Year + 396 days | `standard` (estimate), `reduced-vat` (estimate), `not-vat-registered` (estimate) | 1 official, 0 checked 2026-10-16 |
| [DE](../rule-packs/de.json) | Germany | EUR | USt 19% / 7% | Year + 300 days | `standard` (estimate), `reduced-vat` (estimate), `small-business` (estimate) | 2 official, 1 checked 2026-10-16 |
| [EE](../rule-packs/ee.json) | Estonia | EUR | Käibemaks 24% / 13% / 9% | Year + 274 days | `standard` (exact on profit), `accommodation-vat` (exact on profit), `not-vat-registered` (exact on profit) | 1 official, 0 checked 2026-10-16 |
| [ES](../rule-packs/es.json) | Spain | EUR | IVA 21% / 10% / 4% | Quarter + 30 days | `general` (estimate), `reduced-vat` (estimate), `super-reduced-vat` (estimate), `no-vat` (estimate), `vat-only` (exact) | 4 official, 1 checked 2026-10-16 |
| [FR](../rule-packs/fr.json) | France | EUR | TVA 20% / 10% / 5.5% / 2.1% | Quarter + 31 days | `micro-bnc` (exact), `micro-bnc-vl` (exact), `micro-bic-services` (exact), `micro-bnc-vat` (exact) | 2 official, 0 checked 2026-10-16 |
| [GB](../rule-packs/gb.json) | United Kingdom | GBP | VAT 20% / 5% | Year + 396 days | `standard` (estimate), `reduced-vat` (estimate), `not-vat-registered` (estimate) | 2 official, 1 checked 2026-10-16 |
| [GE](../rule-packs/ge.json) | Georgia | GEL | VAT 18% | Month + 15 days | `small-business` (exact), `small-business-vat` (exact) | 1 official, 0 checked 2026-10-16 |
| [HK](../rule-packs/hk.json) | Hong Kong | HKD | none | Year + 365 days | `profits-tax` (exact on profit) | 1 official, 0 checked 2026-10-16 |
| [ID](../rule-packs/id.json) | Indonesia | IDR | PPN 12% / 11% | Year + 90 days | `umkm-final` (exact), `pkp-umkm` (exact), `regular` (estimate) | 3 official, 2 checked 2026-10-16 |
| [IE](../rule-packs/ie.json) | Ireland | EUR | VAT 23% / 13.5% / 9% | Year + 304 days | `standard` (estimate), `reduced-vat` (estimate), `second-reduced-vat` (estimate), `not-vat-registered` (estimate) | 3 official, 2 checked 2026-10-16 |
| [IN](../rule-packs/in.json) | India | INR | GST 40% / 18% / 5% | Year + 212 days | `presumptive-gst` (presumptive), `presumptive-export` (presumptive), `regular-gst` (estimate) | 1 official, 0 checked 2026-10-16 |
| [IT](../rule-packs/it.json) | Italy | EUR | IVA 22% / 10% / 5% / 4% | Year + 181 days | `forfettario` (exact), `forfettario-startup` (exact), `ordinario` (estimate) | 2 official, 0 checked 2026-10-16 |
| [JP](../rule-packs/jp.json) | Japan | JPY | Consumption tax 10% / 8%; changes 2027-04-01 (proposed), 2029-04-01 (proposed) | Year + 90 days | `taxable` (estimate), `exempt` (estimate) | 2 official, 2 checked 2026-10-16 |
| [KE](../rule-packs/ke.json) | Kenya | KES | VAT 16% | Year + 181 days | `turnover-tax` (exact), `vat` (estimate), `no-vat` (estimate) | 1 official, 0 checked 2026-10-16 |
| [KR](../rule-packs/kr.json) | South Korea | KRW | VAT 10% | Year + 151 days | `general` (estimate), `vat-exempt-freelancer` (estimate) | 1 official, 0 checked 2026-10-16 |
| [KY](../rule-packs/ky.json) | Cayman Islands | KYD | VAT: see notes | Year + 0 days | `no-tax` (exact), `us-person` (none) | 1 official, 1 checked 2026-10-16 |
| [LI](../rule-packs/li.json) | Liechtenstein | CHF | MWST 8.1% / 3.8% / 2.6%; changes 2028-01-01 (proposed) | Year + 120 days | `standard` (none), `reduced-vat` (none), `accommodation-vat` (none), `not-vat-registered` (none) | 1 official, 1 checked 2026-10-16 |
| [LU](../rule-packs/lu.json) | Luxembourg | EUR | TVA 17% / 14% / 8% / 3% | Year + 365 days | `standard` (none), `intermediate-vat` (none), `reduced-vat` (none), `franchise` (none) | 1 official, 0 checked 2026-10-16 |
| [MC](../rule-packs/mc.json) | Monaco | EUR | TVA 20% / 10% / 5.5% / 2.1% | Quarter + 31 days | `standard` (exact), `reduced-vat` (exact), `isb` (exact on profit) | 1 official, 1 checked 2026-10-16 |
| [MT](../rule-packs/mt.json) | Malta | EUR | VAT 18% / 7% / 5% | Year + 181 days | `standard` (estimate), `reduced-vat` (estimate), `article-11` (estimate) | 1 official, 0 checked 2026-10-16 |
| [MX](../rule-packs/mx.json) | México | MXN | IVA 16% / 8% | Year + 120 days | `resico` (exact), `resico-frontera` (exact), `resico-exportacion` (exact), `actividad-empresarial` (estimate) | 1 official, 0 checked 2026-10-16 |
| [NG](../rule-packs/ng.json) | Nigeria | NGN | VAT 7.5% | Year + 90 days | `freelancer` (estimate), `vat-registered` (estimate) | 0 official, 1 checked 2026-10-16 |
| [NL](../rule-packs/nl.json) | Netherlands | EUR | BTW 21% / 9% | Year + 120 days | `standard` (estimate), `reduced-vat` (estimate), `kor` (estimate) | 2 official, 0 checked 2026-10-16 |
| [PA](../rule-packs/pa.json) | Panama | USD | ITBMS 7% | Year + 75 days | `itbms` (estimate), `itbms-foreign-source` (exact), `no-itbms` (estimate) | 1 official, 0 checked 2026-10-16 |
| [PH](../rule-packs/ph.json) | Philippines | PHP | VAT 12% | Year + 105 days | `eight-percent` (exact), `graduated-non-vat` (estimate), `vat-registered` (estimate) | 1 official, 0 checked 2026-10-16 |
| [PK](../rule-packs/pk.json) | Pakistan | PKR | Sales tax 18% | Year + 273 days | `it-export-pseb` (exact), `it-export` (exact), `local-services` (estimate) | 1 official, 0 checked 2026-10-16 |
| [PR](../rule-packs/pr.json) | Puerto Rico | USD | IVU 11.5% / 4% | Year + 105 days | `act-60-export-services` (exact on profit), `ivu` (estimate), `b2b-services` (estimate) | 1 official, 0 checked 2026-10-16 |
| [PT](../rule-packs/pt.json) | Portugal | EUR | IVA 23% / 13% / 6% | Year + 181 days | `standard` (presumptive), `intermediate-vat` (presumptive), `reduced-vat` (presumptive), `vat-exempt` (presumptive) | 2 official, 0 checked 2026-10-16 |
| [SG](../rule-packs/sg.json) | Singapore | SGD | GST 9% | Year + 365 days | `gst` (estimate), `not-gst-registered` (estimate) | 1 official, 0 checked 2026-10-16 |
| [SV](../rule-packs/sv.json) | El Salvador | USD | IVA 13% | Year + 120 days | `iva` (estimate), `exportacion` (estimate) | 1 official, 0 checked 2026-10-16 |
| [TH](../rule-packs/th.json) | Thailand | THB | VAT 7%; changes 2027-10-01 | Year + 98 days | `vat-registered` (estimate), `not-vat-registered` (estimate) | 1 official, 1 checked 2026-10-16 |
| [TR](../rule-packs/tr.json) | Türkiye | TRY | KDV 20% / 10% / 1% | Year + 212 days | `kdv-standard` (estimate), `kdv-reduced` (estimate), `export-services` (estimate) | 1 official, 0 checked 2026-10-16 |
| [UA](../rule-packs/ua.json) | Ukraine | UAH | VAT (ПДВ) 20% / 14% / 7% | Quarter + 50 days | `fop-group-3` (exact), `fop-group-3-vat` (exact) | 1 official, 0 checked 2026-10-16 |
| [US](../rule-packs/us.json) | United States | USD | none | Year + 105 days | `self-employed` (estimate), `with-sales-tax-example` (estimate) | 5 official, 1 checked 2026-10-16 |
| [VN](../rule-packs/vn.json) | Vietnam | VND | VAT (GTGT) 10% / 8% / 5%; changes 2027-01-01 | Quarter + 30 days | `household-services` (exact), `company-vat` (exact on profit), `company-vat-8` (exact on profit) | 1 official, 1 checked 2026-10-16 |
| [ZA](../rule-packs/za.json) | South Africa | ZAR | VAT 15% | Year + 273 days | `vat` (estimate), `not-vat-registered` (estimate) | 2 official, 1 checked 2026-10-16 |
<!-- packs:end -->

## Coverage

- **Crypto hubs and friendly regimes:** UAE, Switzerland, Singapore, Hong Kong, Malta, Cyprus (8% on crypto gains from 2026), Estonia, Portugal, Georgia, Andorra, El Salvador, Panama (territorial), Puerto Rico (Act 60), the Bahamas (no income tax).
- **Highest crypto adoption** (Chainalysis 2025 Global Crypto Adoption Index): India, the United States, Pakistan, Vietnam, Brazil, Nigeria, Indonesia, Ukraine, the Philippines, the United Kingdom, Japan, Argentina, South Korea, Thailand; plus Türkiye, Mexico, Colombia, Kenya and South Africa.
- **Major economies:** Germany, France, Italy, Spain, the Netherlands, Ireland, Luxembourg, Canada, Australia.

Russia is not included: sanctions restrict the stablecoin and anchor services a vault depends on. Jurisdictions with no tax on income and no consumption tax (Cayman Islands, Bermuda) need no vault.

Rule packs are information, not tax advice. The user confirms the percentages; the vault enforces what the user chose.
