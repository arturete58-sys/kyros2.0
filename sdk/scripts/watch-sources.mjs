// Watches the official pages each rule pack cites. For every source marked
// `official`, it fetches the page, keeps the figures that matter (every percentage
// and the amounts next to tax words) and compares them with the last snapshot in
// rule-packs/watch/sources.json. A changed page means a rate or threshold may
// have changed: a maintainer reviews it, updates the pack, and the rate registry
// is synced from the pack (sync-registry.mjs). Nothing changes without review.
//
//   node scripts/watch-sources.mjs [--out report.md] [--update]
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const packDir = join(here, '..', '..', 'rule-packs');
const snapFile = join(packDir, 'watch', 'sources.json');
const args = process.argv.slice(2);
const out = args.includes('--out') ? args[args.indexOf('--out') + 1] : undefined;
const update = args.includes('--update');
const today = new Date().toISOString().slice(0, 10);

const packs = readdirSync(packDir)
  .filter((f) => f.endsWith('.json') && f !== 'schema.json')
  .map((f) => JSON.parse(readFileSync(join(packDir, f), 'utf8')));
const snap = existsSync(snapFile) ? JSON.parse(readFileSync(snapFile, 'utf8')) : {};

const text = (html) =>
  html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/\s+/g, ' ');
// The figures a tax page is about: percentages, and numbers within a few words of a currency or tax word.
const figures = (t) => {
  const pct = t.match(/\d+(?:[.,]\d+)?\s?(?:%|per ?cent|Prozent|por ciento|pour cent)/gi) ?? [];
  const money = t.match(/(?:€|EUR|USD|\$|£|GBP|CHF|R|INR|₹|BHD|AED|SGD|JPY|¥)\s?\d[\d.,\s]{2,}\d/g) ?? [];
  return [...new Set([...pct, ...money].map((x) => x.replace(/\s+/g, '')))].sort();
};

const changed = [];
const failed = [];
const next = { ...snap };
let watched = 0;
for (const p of packs.sort((a, b) => a.id.localeCompare(b.id))) {
  for (const s of (p.sources ?? []).filter((s) => s.official)) {
    watched++;
    let figs;
    try {
      const r = await fetch(s.url, { headers: { 'user-agent': 'kyros-rule-pack-watch (+https://github.com/arturete58-sys/kyros2.0)' }, signal: AbortSignal.timeout(30_000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const type = r.headers.get('content-type') ?? '';
      if (!/html|text|xml|json/i.test(type)) {
        // PDFs and other binaries: compare the raw hash.
        figs = ['sha256:' + createHash('sha256').update(Buffer.from(await r.arrayBuffer())).digest('hex')];
      } else {
        figs = figures(text(await r.text()));
      }
    } catch (e) {
      failed.push(`\`${p.id}\` [${s.title}](${s.url}): ${e.message}`);
      continue;
    }
    const hash = createHash('sha256').update(figs.join('|')).digest('hex').slice(0, 16);
    const before = snap[s.url];
    if (before && before.hash !== hash) {
      const added = figs.filter((x) => !(before.figures ?? []).includes(x)).slice(0, 12);
      const removed = (before.figures ?? []).filter((x) => !figs.includes(x)).slice(0, 12);
      changed.push(`\`${p.id}\` [${s.title}](${s.url}): figures changed since ${before.seen}${added.length ? `; new: ${added.join(', ')}` : ''}${removed.length ? `; gone: ${removed.join(', ')}` : ''}`);
    }
    if (!before || update) next[s.url] = { pack: p.id, hash, figures: figs.slice(0, 200), seen: today };
  }
}

const first = Object.keys(snap).length === 0;
const report = [
  `# Official sources watch, ${today}`,
  '',
  `${watched} official pages cited by ${packs.length} rule packs. ${first ? 'First run: snapshot created.' : `${changed.length} changed, ${failed.length} could not be read.`}`,
  '',
  changed.length ? '## Changed: review the pack\n\n' + changed.map((x) => `- ${x}`).join('\n') + '\n' : '',
  failed.length ? '## Could not be read\n\n' + failed.map((x) => `- ${x}`).join('\n') + '\n' : '',
  'A change in a page is a prompt to review, not a rate change by itself. After review, update the pack (its `vatRates` with the new date), run `node scripts/watch-sources.mjs --update`, and sync the rate registry.',
  '',
].join('\n');
console.log(report);
if (out) writeFileSync(out, report);
if (first || update) {
  mkdirSync(dirname(snapFile), { recursive: true });
  writeFileSync(snapFile, JSON.stringify(next, null, 2) + '\n');
}
if (changed.length) process.exitCode = 1;
