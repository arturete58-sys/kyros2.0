// Watches the official pages each rule pack cites. For every source marked
// `official`, it fetches the page, keeps the figures that matter (every percentage
// and the amounts next to tax words) and compares them with the last snapshot in
// rule-packs/watch/sources.json. A changed page means a rate or threshold may
// have changed: a maintainer reviews it, updates the pack, and the rate registry
// is synced from the pack (sync-registry.mjs). Nothing changes without review.
//
// Pages that refuse plain requests (HTTP 403, bot walls, timeouts) are read with
// a real browser (headless Chromium, when Playwright is installed), and failing
// that from the Internet Archive's latest copy of the same page; the report says
// which way each page was read.
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
const MONTHS =
  'January|February|March|April|May|June|July|August|September|October|November|December|' +
  'enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre|' +
  'Januar|Februar|März|Mai|Juni|Juli|Oktober|Dezember|' +
  'janvier|février|mars|avril|mai|juin|juillet|août|septembre|octobre|novembre|décembre|' +
  'gennaio|febbraio|aprile|maggio|giugno|luglio|settembre|ottobre|dicembre|' +
  'janeiro|fevereiro|março|maio|junho|julho|setembro|outubro|novembro|dezembro|' +
  'januari|februari|maart|mei|augustus|oktober';
const DATES = new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th|\\.)?\\s(?:de\\s)?(?:${MONTHS})\\b|\\b(?:${MONTHS})\\s\\d{1,2}\\b|\\b\\d{1,2}[./]\\d{1,2}[./]\\d{2,4}\\b`, 'gi');
// The figures a tax page is about: percentages, and numbers within a few words of a currency or tax word;
// for the calendar pages a pack cites, also the dates (a moved deadline changes them).
const figures = (t, dates = false) => {
  const pct = t.match(/\d+(?:[.,]\d+)?\s?(?:%|per ?cent|Prozent|por ciento|pour cent)/gi) ?? [];
  const money = t.match(/(?:€|EUR|USD|\$|£|GBP|CHF|R|INR|₹|BHD|AED|SGD|JPY|¥)\s?\d[\d.,\s]{2,}\d/g) ?? [];
  const days = dates ? (t.match(DATES) ?? []).map((x) => x.toLowerCase()) : [];
  return [...new Set([...pct, ...money, ...days].map((x) => x.replace(/\s+/g, '')))].sort();
};

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
let browser;
async function viaBrowser(url, dates = false) {
  if (browser === null) throw new Error('no browser');
  if (!browser) {
    try {
      const { chromium } = await import('playwright');
      browser = await chromium.launch();
    } catch {
      browser = null;
      throw new Error('no browser');
    }
  }
  const page = await browser.newPage({ userAgent: UA, locale: 'en-GB' });
  try {
    const r = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    if (r && r.status() >= 400) throw new Error(`browser HTTP ${r.status()}`);
    await page.waitForTimeout(2_000);
    return figures(text(await page.content()), dates);
  } finally {
    await page.close();
  }
}
async function viaArchive(url, dates = false) {
  const a = await fetch(`https://archive.org/wayback/available?url=${encodeURIComponent(url)}`, { signal: AbortSignal.timeout(30_000) });
  const snap = (await a.json())?.archived_snapshots?.closest;
  if (!snap?.available) throw new Error('no archived copy');
  const raw = snap.url.replace(/\/web\/(\d+)\//, '/web/$1id_/');
  const r = await fetch(raw, { signal: AbortSignal.timeout(60_000) });
  if (!r.ok) throw new Error(`archive HTTP ${r.status}`);
  return { figs: figures(text(await r.text()), dates), when: snap.timestamp.slice(0, 8) };
}
async function direct(url, dates = false) {
  const r = await fetch(url, { headers: { 'user-agent': UA, 'accept-language': 'en' }, signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const type = r.headers.get('content-type') ?? '';
  if (!/html|text|xml|json/i.test(type)) return ['sha256:' + createHash('sha256').update(Buffer.from(await r.arrayBuffer())).digest('hex')];
  return figures(text(await r.text()), dates);
}
const via = {};
const changed = [];
const failed = [];
const next = { ...snap };
let watched = 0;
for (const p of packs.sort((a, b) => a.id.localeCompare(b.id))) {
  // Official rate sources, and every source of the tax calendar and its weekend/holiday rule.
  const cal = [...(p.calendar?.sources ?? []), ...(p.calendar?.workdays?.sources ?? [])].map((s) => ({ ...s, dates: true }));
  const seenUrls = new Set();
  for (const s of [...(p.sources ?? []).filter((s) => s.official), ...cal]) {
    if (seenUrls.has(s.url)) continue;
    seenUrls.add(s.url);
    watched++;
    let figs;
    const errors = [];
    try {
      figs = await direct(s.url, s.dates);
      via[s.url] = 'direct';
    } catch (e) {
      errors.push(e.message);
    }
    if (!figs && !/\.pdf($|\?)/i.test(s.url)) {
      try {
        figs = await viaBrowser(s.url, s.dates);
        via[s.url] = 'browser';
      } catch (e) {
        errors.push(e.message);
      }
    }
    if (!figs) {
      try {
        const a = await viaArchive(s.url, s.dates);
        figs = a.figs;
        via[s.url] = `archive ${a.when}`;
      } catch (e) {
        errors.push(e.message);
      }
    }
    if (!figs) {
      failed.push(`\`${p.id}\` [${s.title}](${s.url}): ${errors.join('; ')}`);
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
  `${watched} official pages cited by ${packs.length} rule packs. ${first ? 'First run: snapshot created.' : `${changed.length} changed, ${failed.length} could not be read.`} Read directly: ${Object.values(via).filter((v) => v === 'direct').length}; with a browser: ${Object.values(via).filter((v) => v === 'browser').length}; from the Internet Archive: ${Object.values(via).filter((v) => v.startsWith('archive')).length}.`,
  '',
  changed.length ? '## Changed: review the pack\n\n' + changed.map((x) => `- ${x}`).join('\n') + '\n' : '',
  failed.length ? '## Could not be read\n\n' + failed.map((x) => `- ${x}`).join('\n') + '\n' : '',
  'A change in a page is a prompt to review, not a rate change by itself. After review, update the pack (its `vatRates` with the new date), run `node scripts/watch-sources.mjs --update`, and sync the rate registry.',
  '',
].join('\n');
if (browser) await browser.close();
console.log(report);
if (out) writeFileSync(out, report);
if (first || update) {
  mkdirSync(dirname(snapFile), { recursive: true });
  writeFileSync(snapFile, JSON.stringify(next, null, 2) + '\n');
}
if (changed.length) process.exitCode = 1;
