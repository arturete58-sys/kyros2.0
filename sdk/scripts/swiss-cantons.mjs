// Builds the Swiss rule pack's income-tax estimate from the Federal Tax
// Administration's own calculator (swisstaxcalculator.estv.admin.ch): for each
// canton capital it asks ESTV the federal, cantonal and communal income tax of
// a single person without church membership at a ladder of taxable incomes, and
// turns the amounts into marginal brackets. The amounts are ESTV's; only the
// straight lines between the ladder's points are ours.
//
//   node scripts/swiss-cantons.mjs [--year 2026]
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = 'https://swisstaxcalculator.estv.admin.ch/delegate/ost-integration/v1/lg-proxy/operation/c3b67379_ESTV';
const here = dirname(fileURLToPath(import.meta.url));
const packFile = join(here, '..', '..', 'rule-packs', 'ch.json');
const args = process.argv.slice(2);
const today = new Date().toISOString().slice(0, 10);

const CAPITALS = [
  ['ZH', 'Zürich', '8001'], ['BE', 'Bern', '3011'], ['LU', 'Luzern', '6003'], ['UR', 'Altdorf', '6460'],
  ['SZ', 'Schwyz', '6430'], ['OW', 'Sarnen', '6060'], ['NW', 'Stans', '6370'], ['GL', 'Glarus', '8750'],
  ['ZG', 'Zug', '6300'], ['FR', 'Fribourg', '1700'], ['SO', 'Solothurn', '4500'], ['BS', 'Basel', '4051'],
  ['BL', 'Liestal', '4410'], ['SH', 'Schaffhausen', '8200'], ['AR', 'Herisau', '9100'], ['AI', 'Appenzell', '9050'],
  ['SG', 'St. Gallen', '9000'], ['GR', 'Chur', '7000'], ['AG', 'Aarau', '5000'], ['TG', 'Frauenfeld', '8500'],
  ['TI', 'Bellinzona', '6500'], ['VD', 'Lausanne', '1003'], ['VS', 'Sion', '1950'], ['NE', 'Neuchâtel', '2000'],
  ['GE', 'Genève', '1204'], ['JU', 'Delémont', '2800'],
];
const LADDER = [0, 15000, 25000, 35000, 50000, 65000, 80000, 100000, 125000, 150000, 200000, 250000, 300000, 400000, 500000, 750000, 1000000];

async function call(op, payload) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch(`${BASE}/${op}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': 'kyros-rule-packs (+https://github.com/arturete58-sys/kyros2.0)' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(60_000),
    }).catch((e) => ({ ok: false, status: e.message }));
    if (r.ok) {
      const j = await r.json();
      if (j && 'response' in j) return j.response;
    }
    await new Promise((res) => setTimeout(res, 1000 * 2 ** attempt));
  }
  throw new Error(`ESTV ${op} failed`);
}

async function taxes(year, locId, income) {
  const r = await call('API_calculateSimpleTaxes', {
    SimKey: null, TaxYear: year, TaxLocationID: locId, Relationship: 1, Confession1: 4, Confession2: 0,
    Children: [], TaxableIncomeCanton: income, TaxableIncomeFed: income, TaxableFortune: 0,
  });
  return { fed: Number(r.IncomeTaxFed ?? 0), canton: Number(r.IncomeTaxCanton ?? 0) + Number(r.IncomeTaxCity ?? 0) };
}

function toBrackets(points) {
  const out = [];
  for (let i = 1; i < points.length; i++) {
    const [x0, t0] = points[i - 1];
    const [x1, t1] = points[i];
    out.push([x1, Math.max(0, Math.round(((t1 - t0) / (x1 - x0)) * 10_000))]);
  }
  out[out.length - 1][0] = null;
  const merged = [];
  for (const b of out) {
    if (merged.length && merged[merged.length - 1][1] === b[1]) merged[merged.length - 1][0] = b[0];
    else merged.push(b);
  }
  return merged;
}

let year = Number(args.includes('--year') ? args[args.indexOf('--year') + 1] : new Date().getUTCFullYear());
let loc0;
for (; year >= 2024; year--) {
  try {
    const found = await call('API_searchLocation', { Search: '8001', Language: 1, TaxYear: year });
    if (found?.length) { loc0 = found; break; }
  } catch { /* try the year before */ }
}
if (!loc0) throw new Error('ESTV: no tax year with locations');
console.log(`ESTV tax year ${year}`);

const regions = [];
let federal;
for (const [canton, city, zip] of CAPITALS) {
  const found = await call('API_searchLocation', { Search: zip, Language: 1, TaxYear: year });
  const loc = found.find((f) => (f.BfsName ?? f.City ?? '').startsWith(city.split(' ')[0])) ?? found.find((f) => f.Canton === canton) ?? found[0];
  const fedPts = [];
  const cantPts = [];
  for (const x of LADDER) {
    const t = await taxes(year, loc.TaxLocationID, x);
    fedPts.push([x, t.fed]);
    cantPts.push([x, t.canton]);
  }
  federal ??= toBrackets(fedPts);
  regions.push({
    id: canton,
    name: `${loc.BfsName ?? loc.City ?? city} (${canton})`,
    items: [{ name: `canton_${canton.toLowerCase()}`, kind: 'incomeTax', brackets: toBrackets(cantPts),
      label: `Cantonal and communal income tax ${year}, ${loc.BfsName ?? city}, single, no church tax (ESTV calculator)` }],
  });
  console.log(canton, loc.BfsName ?? city, 'at 100k:', cantPts.find(([x]) => x === 100000)[1]);
}

const pack = JSON.parse(readFileSync(packFile, 'utf8'));
pack.estimate = {
  year,
  socialDeductible: true,
  items: [
    { name: 'ahv_iv_eo', kind: 'social', brackets: [[null, 1000]], min: 530, label: 'AHV/IV/EO for the self-employed: about 10% of income (lower on a sliding scale below about CHF 60,000), minimum CHF 530' },
    { name: 'federal_tax', kind: 'incomeTax', scope: 'central', brackets: federal, label: `Direct federal tax ${year}, single (ESTV calculator)` },
    { name: 'canton', kind: 'incomeTax', brackets: regions.find((r) => r.id === 'ZH').items[0].brackets, label: `Cantonal and communal income tax ${year}: choose your canton (default: Zürich)` },
  ],
  notes: [
    'Choose your canton: the estimate uses its capital. Other communes apply their own multiplier, often lower outside the capital. Church tax (for members) and the deductions that lead from profit to taxable income (pillar 3a, insurance premiums) are not included.',
  ],
};
for (const r of regions) r.replaces = ['canton'];
pack.regions = regions;
pack.notes = (pack.notes ?? []).filter((n) => !n.startsWith('No reserve estimate'));
pack.sources = (pack.sources ?? []).filter((s) => !s.url.startsWith('https://swisstaxcalculator'));
pack.sources.push({ title: `ESTV tax calculator: federal, cantonal and communal income tax ${year} (official)`, url: 'https://swisstaxcalculator.estv.admin.ch/', official: true, checked: today });
writeFileSync(packFile, JSON.stringify(pack, null, 2) + '\n');
console.log(`ch.json updated: ${regions.length} cantons`);
