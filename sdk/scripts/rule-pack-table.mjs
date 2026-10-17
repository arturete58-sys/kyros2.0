// Rewrites the jurisdiction table in docs/rule-packs.md from the rule packs,
// between the <!-- packs:start --> and <!-- packs:end --> markers.
//
//   node scripts/rule-pack-table.mjs
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { precisionOf } from '../dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const packs = readdirSync(join(root, 'rule-packs'))
  .filter((f) => f.endsWith('.json') && f !== 'schema.json')
  .map((f) => JSON.parse(readFileSync(join(root, 'rule-packs', f), 'utf8')))
  .sort((a, b) => a.country.localeCompare(b.country));

const today = new Date().toISOString().slice(0, 10);
const inForce = (p) =>
  (p.vatRates ?? []).filter((t) => !t.proposed && t.from <= today).sort((a, b) => (a.from < b.from ? 1 : -1))[0]?.rates ?? {};
const pct = (bps) => `${+(bps / 100).toFixed(3)}%`;
const country = (p) => p.name.split(':')[0];
const dueText = (d, fy) => {
  if (!d) return '';
  if ('days' in d) return `${d.days} days after the period`;
  if ('date' in d) return `${d.date} of FY+${d.yearsAfter}${fy && fy !== '01-01' ? ` (FY from ${fy})` : ''}`;
  const ex = d.except ? `; ${d.except.day} of +${d.except.monthsAfter} for periods ending in month ${d.except.periodEndMonth}` : '';
  return `day ${d.day} of month +${d.monthsAfter}${ex}`;
};
const WD = { next: 'weekend/holiday: next working day', previous: 'weekend/holiday: working day before', none: 'weekend/holiday: no move (shown: working day before)' };
const calText = (c) =>
  [`${c.period}`, c.vat ? `VAT: ${dueText(c.vat, c.fiscalYearStart)}` : '', `income: ${dueText(c.income, c.fiscalYearStart)}`, c.workdays ? `${WD[c.workdays.rule]}${c.workdays.verified ? '' : ' (not verified)'}` : '']
    .filter(Boolean)
    .join('; ');

const rows = packs.map((p) => {
  const rates = Object.values(inForce(p)).filter((v) => v > 0).sort((a, b) => b - a);
  const vat = rates.length ? `${p.vatName ?? 'VAT'} ${rates.map(pct).join(' / ')}` : p.vatName ? `${p.vatName}: see notes` : 'none';
  const changes = (p.vatRates ?? []).filter((t) => t.from > today).map((t) => `${t.from}${t.proposed ? ' (proposed)' : ''}`);
  const LABEL = { exact: 'exact', presumptive: 'presumptive', 'exact-on-profit': 'exact on profit', estimate: 'estimate', none: 'none' };
  const presets = p.presets.map((x) => `\`${x.id}\` (${LABEL[precisionOf(p, x.id)]})`).join(', ');
  const official = (p.sources ?? []).filter((x) => x.official).length;
  const checked = (p.sources ?? []).filter((x) => x.checked).length;
  return `| [${p.country}](../rule-packs/${p.id}.json) | ${country(p)} | ${p.currency} | ${vat}${changes.length ? `; changes ${changes.join(', ')}` : ''} | ${calText(p.calendar)} | ${presets} | ${official} official, ${checked} checked ${p.reviewed ?? ''} |`;
});

const table = [
  `## Jurisdictions (${packs.length})`,
  '',
  '| Pack | Jurisdiction | Currency | Consumption tax in force | Calendar | Presets (precision of the reserve check) | Sources |',
  '| --- | --- | --- | --- | --- | --- | --- |',
  ...rows,
].join('\n');

const file = join(root, 'docs', 'rule-packs.md');
const doc = readFileSync(file, 'utf8');
const start = '<!-- packs:start -->';
const end = '<!-- packs:end -->';
const i = doc.indexOf(start);
const j = doc.indexOf(end);
if (i < 0 || j < 0) throw new Error('markers not found in docs/rule-packs.md');
writeFileSync(file, `${doc.slice(0, i + start.length)}\n${table}\n${doc.slice(j)}`);
console.log(`${packs.length} packs written to docs/rule-packs.md`);
