// Checks the rule packs' VAT tables against an independent, maintained dataset of
// EU and UK VAT rates (github.com/ibericode/vat-rates) and flags packs not reviewed
// recently. Prints a Markdown report; exits with 1 when something needs a look.
//
//   node scripts/check-vat-rates.mjs [--max-age-days 180] [--out report.md]
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DATASET = 'https://raw.githubusercontent.com/ibericode/vat-rates/master/vat-rates.json';
const here = dirname(fileURLToPath(import.meta.url));
const packDir = join(here, '..', '..', 'rule-packs');
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const maxAgeDays = Number(opt('--max-age-days', '180'));
const out = opt('--out');
const today = new Date().toISOString().slice(0, 10);

const packs = readdirSync(packDir)
  .filter((f) => f.endsWith('.json') && f !== 'schema.json')
  .map((f) => JSON.parse(readFileSync(join(packDir, f), 'utf8')));

const res = await fetch(DATASET);
if (!res.ok) throw new Error(`dataset: HTTP ${res.status}`);
const dataset = (await res.json()).items;

const inForce = (tables, day, from = (t) => t.from) =>
  tables.filter((t) => !t.proposed && from(t) <= day).sort((a, b) => (from(a) < from(b) ? 1 : -1))[0];
const bps = (pct) => Math.round(pct * 100);

const problems = [];
const lines = [];
for (const pack of packs.sort((a, b) => a.id.localeCompare(b.id))) {
  const age = pack.reviewed ? Math.floor((Date.parse(today) - Date.parse(pack.reviewed)) / 86_400_000) : Infinity;
  if (age > maxAgeDays) problems.push(`\`${pack.id}\`: last reviewed ${pack.reviewed ?? 'never'} (${age} days ago); check the rates against the sources.`);

  const ref = dataset[pack.country];
  if (!ref || !pack.vatRates) continue;
  const mine = inForce(pack.vatRates, today)?.rates ?? {};
  const theirs = inForce(ref, today, (t) => t.effective_from)?.rates ?? {};
  const theirValues = new Set(Object.values(theirs).map(bps));
  const issues = [];
  if (mine.standard !== bps(theirs.standard)) issues.push(`standard rate ${mine.standard} bps, dataset ${bps(theirs.standard)} bps`);
  for (const [k, v] of Object.entries(mine).filter(([k]) => !k.startsWith('regional_'))) {
    if (v !== 0 && !theirValues.has(v)) issues.push(`rate \`${k}\` ${v} bps is not in the dataset (${[...theirValues].join(', ')})`);
  }
  for (const t of ref.filter((t) => t.effective_from > today)) {
    if (!pack.vatRates.some((m) => m.from === t.effective_from)) issues.push(`the dataset lists a change from ${t.effective_from} (${JSON.stringify(t.rates)}) that the pack does not have`);
  }
  lines.push(`| ${pack.country} | ${Object.entries(mine).map(([k, v]) => `${k} ${v / 100}%`).join(', ')} | ${issues.length ? '⚠️ ' + issues.join('; ') : 'matches'} |`);
  for (const i of issues) problems.push(`\`${pack.id}\`: ${i}`);
}

const report = [
  `# VAT rate check, ${today}`,
  '',
  `Rule packs: ${packs.length}. EU and UK rates compared with [ibericode/vat-rates](https://github.com/ibericode/vat-rates); every pack is expected to be reviewed at least every ${maxAgeDays} days.`,
  '',
  '| Country | Rates in force (pack) | Dataset |',
  '| --- | --- | --- |',
  ...lines,
  '',
  problems.length ? '## Needs a look\n\n' + problems.map((p) => `- ${p}`).join('\n') : 'Nothing to update.',
  '',
].join('\n');

console.log(report);
if (out) writeFileSync(out, report);
process.exit(problems.length ? 1 : 0);
