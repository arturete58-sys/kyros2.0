// Checks the EU rule packs against the European Commission's official database of
// VAT rates (TEDB, "Taxes in Europe Database"), through its public VAT Retrieval
// web service. Prints a Markdown report; exits with 1 when a rate differs.
//
//   node scripts/check-vat-official.mjs [--out report.md] [--json findings.json] [--debug]
//
// `--json` writes the differences as findings for the law agent (law-agent.mjs).
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ENDPOINT = 'https://ec.europa.eu/taxation_customs/tedb/ws/';
const EU = new Set(['AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'GR', 'ES', 'FI', 'FR', 'HR', 'HU', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK']);
const here = dirname(fileURLToPath(import.meta.url));
const packDir = join(here, '..', '..', 'rule-packs');
const args = process.argv.slice(2);
const out = args.includes('--out') ? args[args.indexOf('--out') + 1] : undefined;
const debug = args.includes('--debug');
const jsonOut = args.includes('--json') ? args[args.indexOf('--json') + 1] : undefined;
const findings = [];
const today = new Date().toISOString().slice(0, 10);

const packs = readdirSync(packDir)
  .filter((f) => f.endsWith('.json') && f !== 'schema.json')
  .map((f) => JSON.parse(readFileSync(join(packDir, f), 'utf8')))
  .filter((p) => EU.has(p.country) && p.vatRates);

const envelope = (codes) => `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
  xmlns:urn="urn:ec.europa.eu:taxud:tedb:services:v1:IVatRetrievalService"
  xmlns:urn1="urn:ec.europa.eu:taxud:tedb:services:v1:IVatRetrievalService:types">
  <soapenv:Header/>
  <soapenv:Body>
    <urn:retrieveVatRatesReqMsg>
      <urn1:memberStates>${codes.map((c) => `<urn1:isoCode>${c === 'GR' ? 'EL' : c}</urn1:isoCode>`).join('')}</urn1:memberStates>
      <urn1:situationOn>${today}</urn1:situationOn>
    </urn:retrieveVatRatesReqMsg>
  </soapenv:Body>
</soapenv:Envelope>`;

const res = await fetch(ENDPOINT, {
  method: 'POST',
  headers: { 'content-type': 'text/xml; charset=utf-8', SOAPAction: 'urn:ec.europa.eu:taxud:tedb:services:v1:VatRetrievalService/RetrieveVatRates' },
  // Every member state: the packs, and the standard-rate table the x402 billing agent uses.
  body: envelope([...EU]),
});
const xml = await res.text();
if (debug) console.error(xml.slice(0, 6000));
if (!res.ok) throw new Error(`TEDB: HTTP ${res.status}: ${xml.slice(0, 500)}`);

// Each result names a member state, a rate type and a value; namespaces vary, so match on local names.
const local = (tag) => new RegExp(`<(?:[\\w-]+:)?${tag}>([\\s\\S]*?)</(?:[\\w-]+:)?${tag}>`, 'g');
const results = [...xml.matchAll(local('vatRateResults'))].map((m) => m[1]);
const official = {};
for (const r of results) {
  const ms = local('memberState').exec(r)?.[1]?.trim();
  const type = local('type').exec(r)?.[1]?.trim() ?? '';
  const value = Number(local('value').exec(r)?.[1]);
  if (!ms || !Number.isFinite(value)) continue;
  const code = ms === 'EL' ? 'GR' : ms;
  (official[code] ??= { standard: new Set(), all: new Set() });
  official[code].all.add(Math.round(value * 100));
  if (/STANDARD/i.test(type) || /DEFAULT/i.test(r.match(/<(?:[\w-]+:)?rate>[\s\S]*?<\/(?:[\w-]+:)?rate>/)?.[0] ?? '')) official[code].standard.add(Math.round(value * 100));
}
if (!Object.keys(official).length) throw new Error(`TEDB: no rates parsed; response starts: ${xml.slice(0, 800)}`);

const inForce = (tables) => tables.filter((t) => !t.proposed && t.from <= today).sort((a, b) => (a.from < b.from ? 1 : -1))[0];
const problems = [];
const lines = [];
for (const p of packs.sort((a, b) => a.id.localeCompare(b.id))) {
  const mine = inForce(p.vatRates)?.rates ?? {};
  const o = official[p.country];
  if (!o) {
    problems.push(`\`${p.id}\`: TEDB returned no rates for ${p.country}`);
    continue;
  }
  const issues = [];
  if (o.standard.size && !o.standard.has(mine.standard)) {
    issues.push(`standard ${mine.standard / 100}%, TEDB ${[...o.standard].map((x) => x / 100 + '%').join('/')}`);
    findings.push({ pack: p.id, country: p.country, rate: 'standard', packBps: mine.standard, officialBps: [...o.standard], source: 'European Commission TEDB' });
  }
  for (const [k, v] of Object.entries(mine).filter(([k]) => !k.startsWith('regional_') && k !== 'standard')) {
    if (v !== 0 && !o.all.has(v)) {
      issues.push(`\`${k}\` ${v / 100}% is not a TEDB rate`);
      findings.push({ pack: p.id, country: p.country, rate: k, packBps: v, officialBps: [...o.all], source: 'European Commission TEDB' });
    }
  }
  lines.push(`| ${p.country} | ${Object.entries(mine).map(([k, v]) => `${k} ${v / 100}%`).join(', ')} | ${[...o.all].sort((a, b) => b - a).map((x) => x / 100 + '%').join(', ')} | ${issues.length ? '⚠️ ' + issues.join('; ') : 'matches'} |`);
  for (const i of issues) problems.push(`\`${p.id}\`: ${i}`);
}

// The x402 billing agent's table of standard rates (all 27 states), when the SDK is built.
const sdk = await import('../dist/index.js').catch(() => null);
const tableLines = [];
if (sdk?.EU_STANDARD_VAT) {
  for (const [c, bps] of Object.entries(sdk.EU_STANDARD_VAT).sort()) {
    const o = official[c];
    if (!o || !o.standard.size) continue;
    if (!o.standard.has(bps)) {
      tableLines.push(`- ${c}: table ${bps / 100}%, TEDB ${[...o.standard].map((x) => x / 100 + '%').join('/')}`);
      problems.push(`\`EU_STANDARD_VAT\` (sdk/src/agents/x402.ts) ${c}: ${bps / 100}%, TEDB ${[...o.standard].map((x) => x / 100 + '%').join('/')}`);
    }
  }
}

const report = [
  `# EU VAT rates against the official TEDB, ${today}`,
  '',
  `Source: European Commission, Taxes in Europe Database, VAT Retrieval Service (rates in force on ${today}).`,
  '',
  '| Country | Rule pack | TEDB rates | Result |',
  '| --- | --- | --- | --- |',
  ...lines,
  '',
  sdk?.EU_STANDARD_VAT ? (tableLines.length ? '' : 'The x402 agent\'s table of the 27 standard rates matches TEDB.') : '',
  '',
  problems.length ? '## To review\n\n' + problems.map((x) => `- ${x}`).join('\n') : 'Every EU pack matches the official rates.',
  '',
].join('\n');
console.log(report);
if (out) writeFileSync(out, report);
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(findings, null, 2) + '\n');
if (problems.length) process.exitCode = 1;
