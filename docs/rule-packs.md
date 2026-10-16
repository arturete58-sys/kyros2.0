# Rule packs

A rule pack is a JSON file per country ([schema](../rule-packs/schema.json)) that suggests a vault's split rule and fiscal calendar. The vault enforces percentages and dates; it does not compute taxes, and a new country needs no contract change.

| Field | Meaning |
| --- | --- |
| `period` | `Month`, `Quarter` or `Year` (UTC calendar) |
| `dueOffsetDays` | Days after the period ends until its reserve can be released |
| `presets[].vatBps` | VAT included in the gross amount, in basis points |
| `presets[].buckets[]` | Other reserves as a share of the taxable base (`name`, `bps`) |

## Spain (`es.json`)

| Preset | VAT | Income-tax prepayment |
| --- | --- | --- |
| `general` | 21% | 20% |
| `reduced-vat` | 10% | 20% |
| `super-reduced-vat` | 4% | 20% |
| `no-vat` (exports, EU B2B reverse charge) | 0% | 20% |
| `vat-only` | 21% | none |

Quarterly periods, due 30 days after each quarter. VAT (modelo 303) and the income-tax prepayment (modelo 130) are filed in the first 20 days after a quarter, and until 30 January for the fourth quarter; paying earlier is always allowed. The modelo 130 prepayment is 20% of the quarter's net profit; Kyros reserves 20% of the taxable base, which is never less than what is due, and the surplus is released after the due date.

Rule packs are information, not tax advice. The user confirms the percentages.

```ts
import { loadRulePack, termsFromPack } from 'kyros-sdk';
const terms = termsFromPack(loadRulePack('es'), 'general'); // { rule, period, dueOffsetSecs }
```
