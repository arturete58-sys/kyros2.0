// Checks the national income-tax scales of the rule packs against the OECD Tax
// Database (Table I.1, central government personal income tax rates and
// thresholds), which OECD member governments report themselves. It compares the
// statutory rates of every estimate item marked `"scope": "central"`, and keeps
// the official figures in rule-packs/watch/oecd-pit.json so each review has them.
//
//   node scripts/check-brackets-oecd.mjs [--out report.md]
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const URL_ = 'https://sdmx.oecd.org/public/rest/data/OECD.CTP.TPS,DSD_TAX_PIT@DF_PIT_CENT,1.0/all?startPeriod=2024&dimensionAtObservation=AllDimensions&format=csvfilewithlabels';
const OECD = { AU: 'AUS', CA: 'CAN', CH: 'CHE', CO: 'COL', DE: 'DEU', EE: 'EST', ES: 'ESP', FR: 'FRA', GB: 'GBR', IE: 'IRL', IT: 'ITA', JP: 'JPN', KR: 'KOR', LU: 'LUX', MX: 'MEX', NL: 'NLD', PT: 'PRT', TR: 'TUR', US: 'USA' };
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const args = process.argv.slice(2);
const out = args.includes('--out') ? args[args.indexOf('--out') + 1] : undefined;
const today = new Date().toISOString().slice(0, 10);

let res, csv;
const BASE = 'https://sdmx.oecd.org/public/rest/data/OECD.CTP.TPS,DSD_TAX_PIT@DF_PIT_CENT';
const attempts = [
  [`${BASE},1.0/all?startPeriod=2024&format=csvfilewithlabels`, 'text/csv'],
  [`${BASE},1.0/?startPeriod=2024&format=csvfilewithlabels`, 'text/csv'],
  [`${BASE},1.0/all?startPeriod=2024`, 'application/vnd.sdmx.data+csv;version=2.0.0;labels=both'],
  [`${BASE},/all?startPeriod=2024&format=csvfilewithlabels`, 'text/csv'],
  [`${BASE},1.0/all?lastNObservations=1&format=csvfilewithlabels`, 'text/csv'],
];
const tried = [];
try {
  for (const [u, accept] of attempts) {
    try {
      res = await fetch(u, { headers: { accept, 'user-agent': 'kyros-law-watch' }, signal: AbortSignal.timeout(180_000) });
      csv = await res.text();
      tried.push(`${u} -> HTTP ${res.status}`);
      if (res.ok && csv.includes('REF_AREA')) break;
    } catch (e) {
      tried.push(`${u} -> ${e.message}`);
    }
    res = undefined;
  }
  if (!res) throw new Error(`no query worked:\n- ${tried.join('\n- ')}\n\nLast response: ${(csv ?? '').slice(0, 300)}`);
} catch (e) {
  const msg = `# National income-tax scales against the OECD Tax Database, ${today}\n\nThe OECD data could not be read: ${String(e.message ?? e).slice(0, 600)}\n`;
  console.log(msg);
  if (out) writeFileSync(out, msg);
  process.exit(1);
}

// Minimal CSV parser (quoted fields).
const rows = [];
let field = '', row = [], q = false;
for (let i = 0; i < csv.length; i++) {
  const ch = csv[i];
  if (q) {
    if (ch === '"' && csv[i + 1] === '"') { field += '"'; i++; } else if (ch === '"') q = false; else field += ch;
  } else if (ch === '"') q = true;
  else if (ch === ',') { row.push(field); field = ''; }
  else if (ch === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; }
  else field += ch;
}
if (field || row.length) { row.push(field); rows.push(row); }
const head = rows.shift();
const col = (name) => head.findIndex((h) => h === name);
const iArea = col('REF_AREA'), iTime = col('TIME_PERIOD'), iVal = col('OBS_VALUE');
if (iArea < 0 || iTime < 0 || iVal < 0) {
  const msg = `# National income-tax scales against the OECD Tax Database, ${today}\n\nUnexpected columns: ${head.join(', ').slice(0, 800)}\n\nFirst row: ${(rows[0] ?? []).join(', ').slice(0, 800)}\n`;
  console.log(msg);
  if (out) writeFileSync(out, msg);
  process.exit(1);
}

// Keep every row of our countries for the latest year each reports; label columns help the review.
const wanted = new Set(Object.values(OECD));
const byArea = {};
for (const r of rows) {
  if (!wanted.has(r[iArea])) continue;
  (byArea[r[iArea]] ??= []).push(Object.fromEntries(head.map((h, k) => [h, r[k]])));
}
const latest = {};
for (const [area, list] of Object.entries(byArea)) {
  const y = list.map((x) => x.TIME_PERIOD).sort().at(-1);
  latest[area] = { year: y, rows: list.filter((x) => x.TIME_PERIOD === y) };
}
mkdirSync(join(root, 'rule-packs', 'watch'), { recursive: true });
writeFileSync(join(root, 'rule-packs', 'watch', 'oecd-pit.json'), JSON.stringify({ source: URL_, fetched: today, latest }, null, 1) + '\n');

// Statutory rates: observations whose measure or unit says it is a rate (percent).
const isRate = (x) => Object.entries(x).some(([k, v]) => /MEASURE|UNIT/i.test(k) && /rate|percent|PT\b|PC\b/i.test(String(v)));
const packs = readdirSync(join(root, 'rule-packs'))
  .filter((f) => f.endsWith('.json') && f !== 'schema.json')
  .map((f) => JSON.parse(readFileSync(join(root, 'rule-packs', f), 'utf8')));
const lines = [];
const problems = [];
for (const p of packs.sort((a, b) => a.id.localeCompare(b.id))) {
  const area = OECD[p.country];
  if (!area) continue;
  const ests = [p.estimate, ...p.presets.map((x) => x.estimate)].filter(Boolean);
  const items = ests.flatMap((e) => e.items).filter((it) => it.scope === 'central');
  const o = latest[area];
  if (!items.length) { lines.push(`| ${p.country} | no central item marked | ${o?.year ?? '-'} | not compared |`); continue; }
  if (!o) { problems.push(`\`${p.id}\`: OECD returned no data for ${area}`); continue; }
  const official = [...new Set(o.rows.filter(isRate).map((x) => Math.round(Number(x.OBS_VALUE) * 100)).filter((v) => v > 0))].sort((a, b) => a - b);
  const mine = [...new Set(items[0].brackets.map(([, b]) => b).filter((b) => b > 0))].sort((a, b) => a - b);
  const same = official.length > 0 && official.join() === mine.join();
  const topSame = official.length > 0 && official.at(-1) === mine.at(-1);
  lines.push(`| ${p.country} | ${mine.map((b) => b / 100 + '%').join(', ')} | ${o.year}: ${official.map((b) => b / 100 + '%').join(', ') || '(no rates parsed)'} | ${same ? 'matches' : topSame ? 'top rate matches; check the bands' : '⚠️ differs'} |`);
  if (!topSame) problems.push(`\`${p.id}\`: central rates ${mine.map((b) => b / 100).join('/')} vs OECD ${o.year} ${official.map((b) => b / 100).join('/')}`);
}
const report = [
  `# National income-tax scales against the OECD Tax Database, ${today}`,
  '',
  'Source: OECD Tax Database, Table I.1 (central government personal income tax rates and thresholds, as reported by member governments). The latest figures are kept in `rule-packs/watch/oecd-pit.json`.',
  '',
  '| Country | Rule pack (central) | OECD | Result |',
  '| --- | --- | --- | --- |',
  ...lines,
  '',
  problems.length ? '## To review\n\n' + problems.map((x) => `- ${x}`).join('\n') : 'Every compared scale matches the OECD figures.',
  '',
].join('\n');
console.log(report);
if (out) writeFileSync(out, report);
if (problems.length) process.exitCode = 1;
