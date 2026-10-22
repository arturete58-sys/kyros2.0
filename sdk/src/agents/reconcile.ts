/**
 * Reconciliation agent: ties every amount the vault set aside, paid or
 * returned to the transaction that did it, period by period, and answers
 * the questions a user or their accountant asks ("why was 2,715 set aside
 * for income tax in Q3?") with the payments behind the figure and their
 * transaction hashes. It also checks a tax-tool export (Koinly, CoinTracking,
 * Crypto Tax Calculator, CoinLedger) against the chain: what is missing from
 * the file, what the file has that the vault does not, and amounts that
 * differ.
 *
 * Everything here is arithmetic on events already read (`vaultEvents`);
 * nothing is sent anywhere.
 */
import type { VaultEventRow } from '../events.js';
import { periodOf, periodStart, periodEnd, periodLabel, type PeriodKind } from '../periods.js';
import { formatAmount } from '../split.js';

export interface LedgerEntry {
  date: string;
  kind: 'received' | 'tax_paid' | 'released' | 'converted' | 'harvested' | 'correction_applied';
  token?: string;
  /** For `received`: the bucket an amount went to (`vat` or an income-tax bucket). */
  bucket?: string;
  amount: bigint;
  /** For `received`: the whole payment. */
  gross?: bigint;
  reference?: string;
  tx: string;
}

export interface PeriodLedger {
  period: number;
  label: string;
  /** Payments received: count and gross per token. */
  received: { count: number; gross: Record<string, bigint> };
  /** Set aside per bucket per token (VAT under `vat`). */
  reserved: Record<string, Record<string, bigint>>;
  paid: Record<string, Record<string, bigint>>;
  released: Record<string, bigint>;
  entries: LedgerEntry[];
}

const add = (m: Record<string, bigint>, k: string, x: bigint) => (m[k] = (m[k] ?? 0n) + x);

/**
 * The vault's history by period. `buckets` names the income-tax buckets in
 * the order of the vault's rule, to label the `parts` of each payment.
 */
export function buildLedger(rows: VaultEventRow[], o: { buckets: string[]; periodKind?: PeriodKind | null }): PeriodLedger[] {
  const by = new Map<number, PeriodLedger>();
  const get = (p: number) => {
    let l = by.get(p);
    if (!l) {
      l = { period: p, label: o.periodKind ? periodLabel(o.periodKind, p) : `#${p}`, received: { count: 0, gross: {} }, reserved: {}, paid: {}, released: {}, entries: [] };
      by.set(p, l);
    }
    return l;
  };
  for (const r of rows) {
    if (r.period === undefined) continue;
    const l = get(r.period);
    const tk = r.token ?? '';
    if (r.kind === 'received' && r.gross !== undefined) {
      l.received.count++;
      add(l.received.gross, tk, r.gross);
      if (r.vat && r.vat > 0n) {
        add((l.reserved.vat ??= {}), tk, r.vat);
        l.entries.push({ date: r.closedAt, kind: 'received', token: tk, bucket: 'vat', amount: r.vat, gross: r.gross, reference: r.reference, tx: r.txHash });
      }
      (r.parts ?? []).forEach((x, i) => {
        if (x <= 0n) return;
        const b = o.buckets[i] ?? `part${i + 1}`;
        add((l.reserved[b] ??= {}), tk, x);
        l.entries.push({ date: r.closedAt, kind: 'received', token: tk, bucket: b, amount: x, gross: r.gross, reference: r.reference, tx: r.txHash });
      });
    } else if (r.kind === 'tax_paid' && r.amount !== undefined) {
      add((l.paid[r.bucket ?? '?'] ??= {}), tk, r.amount);
      l.entries.push({ date: r.closedAt, kind: 'tax_paid', token: tk, bucket: r.bucket, amount: r.amount, tx: r.txHash });
    } else if (r.kind === 'released' && r.amount !== undefined) {
      add(l.released, tk, r.amount);
      l.entries.push({ date: r.closedAt, kind: 'released', token: tk, amount: r.amount, tx: r.txHash });
    } else if (r.kind === 'converted' && r.amount !== undefined) {
      l.entries.push({ date: r.closedAt, kind: 'converted', token: tk, amount: r.amount, tx: r.txHash });
    }
  }
  return [...by.values()].sort((a, b) => a.period - b.period);
}

export type AskedTax = 'vat' | 'income' | 'all';
export type AskedMetric = 'reserved' | 'paid' | 'received';

export interface ReserveQuestion {
  /** Calendar range asked about (UNIX seconds, end exclusive). */
  from?: bigint;
  to?: bigint;
  /** How the range was named, e.g. "2026-Q3". */
  label?: string;
  tax: AskedTax;
  metric: AskedMetric;
  /** An amount the user quoted, to match against. */
  amount?: number;
}

const ORD: Record<string, number> = {
  primer: 1, primero: 1, first: 1, '1st': 1, premier: 1, erste: 1, ersten: 1, primo: 1, primeiro: 1,
  segundo: 2, second: 2, '2nd': 2, zweite: 2, zweiten: 2, secondo: 2, deuxième: 2, deuxieme: 2,
  tercer: 3, tercero: 3, third: 3, '3rd': 3, troisième: 3, troisieme: 3, dritte: 3, dritten: 3, terzo: 3, terceiro: 3,
  cuarto: 4, fourth: 4, '4th': 4, quatrième: 4, quatrieme: 4, vierte: 4, vierten: 4, quarto: 4,
};
const MONTH_WORDS: [RegExp, number][] = [
  [/\b(enero|january|janvier|januar|gennaio|janeiro)\b/i, 1], [/\b(febrero|february|f[ée]vrier|februar|febbraio|fevereiro)\b/i, 2],
  [/\b(marzo|march|mars|m[äa]rz|mar[çc]o)\b/i, 3], [/\b(abril|april|avril|aprile)\b/i, 4], [/\b(mayo|may|mai|maggio|maio)\b/i, 5],
  [/\b(junio|june|juin|juni|giugno|junho)\b/i, 6], [/\b(julio|july|juillet|juli|luglio|julho)\b/i, 7], [/\b(agosto|august|ao[uû]t)\b/i, 8],
  [/\b(septiembre|setiembre|september|septembre|settembre|setembro)\b/i, 9], [/\b(octubre|october|octobre|oktober|ottobre|outubro)\b/i, 10],
  [/\b(noviembre|november|novembre|novembro)\b/i, 11], [/\b(diciembre|december|d[ée]cembre|dezember|dicembre|dezembro)\b/i, 12],
];

const utc = (y: number, m: number) => BigInt(Date.UTC(y, m - 1, 1) / 1000);

/** Reads which period, tax and figure a question asks about, in any of the app's languages. */
export function parseReserveQuestion(q: string, now: Date = new Date()): ReserveQuestion {
  const s = q.toLowerCase();
  const tax: AskedTax = /\b(iva|vat|mwst|ust|tva|btw|igic|303|iva trimestral)\b/.test(s)
    ? 'vat'
    : /(irpf|renta|income|130|131|ganancias|einkommen|imp[ôo]t sur le revenu|irpef|\birs\b|impuesto sobre la renta|retenci)/.test(s)
      ? 'income'
      : 'all';
  const metric: AskedMetric = /(pag[aoué]|paid|bezahlt|pay[ée]|versat|ingres[ée] a hacienda)/.test(s) && !/(apart|reserv|set aside|guard)/.test(s)
    ? 'paid'
    : /(cobr|recib|received|factur[ée]|erhalten|re[çc]u|ricevut|recebid|ingresos?\b)/.test(s) && !/(apart|reserv|set aside|guard)/.test(s)
      ? 'received'
      : 'reserved';
  const yearM = /\b(20\d{2})\b/.exec(s);
  let year = yearM ? Number(yearM[1]) : now.getUTCFullYear();
  let quarter: number | undefined;
  const qm = /\b(?:q|t)\s?([1-4])\b|\b([1-4])\s?(?:t|q|º\s*t|er\s*t)\b|\btrimestre\s+([1-4])\b|\bquarter\s+([1-4])\b|\b([1-4])\.?\s*quartal\b|\b([1-4])\s*(?:º|°)?\s*trimestre\b/.exec(s);
  if (qm) quarter = Number(qm.slice(1).find((x) => x));
  else {
    const om = /\b(primer|primero|first|1st|premier|erste[n]?|primo|primeiro|segundo|second|2nd|zweite[n]?|secondo|deuxi[èe]me|tercer|tercero|third|3rd|troisi[èe]me|dritte[n]?|terzo|terceiro|cuarto|fourth|4th|quatri[èe]me|vierte[n]?|quarto)\s+(trimestre|quarter|quartal)\b/.exec(s);
    if (om) quarter = ORD[om[1]];
  }
  const thisQ = Math.floor(now.getUTCMonth() / 3) + 1;
  if (!quarter && /(este trimestre|this quarter|ce trimestre|dieses quartal|questo trimestre|neste trimestre)/.test(s)) quarter = thisQ;
  if (!quarter && /([úu]ltimo trimestre|last quarter|previous quarter|trimestre pass[ée]|trimestre dernier|dernier trimestre|letzten quartal|vorigen quartal|trimestre scorso|scorso trimestre|ultimo trimestre|trimestre anterior|trimestre pasado)/.test(s)) {
    quarter = thisQ === 1 ? 4 : thisQ - 1;
    if (thisQ === 1 && !yearM) year--;
  }
  const amountM = /(\d{1,3}(?:[.,\s]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)\s*(?:€|eur|eurc|usdc|usd|\$)/i.exec(q);
  const amount = amountM ? Number(amountM[1].replace(/[\s.](?=\d{3}\b)/g, '').replace(/,(?=\d{3}\b)/g, '').replace(',', '.')) : undefined;
  if (quarter) {
    // A quarter asked without a year is the latest one that has started.
    if (!yearM && quarter > thisQ && !/(último|ultimo|last|previous|pass|dernier|letzten|vorigen|scorso|anterior|pasado)/.test(s)) year--;
    return { from: utc(year, quarter * 3 - 2), to: quarter === 4 ? utc(year + 1, 1) : utc(year, quarter * 3 + 1), label: `${year}-Q${quarter}`, tax, metric, amount };
  }
  for (const [re, m] of MONTH_WORDS) {
    if (re.test(s)) {
      if (!yearM && m > now.getUTCMonth() + 1) year--;
      return { from: utc(year, m), to: m === 12 ? utc(year + 1, 1) : utc(year, m + 1), label: `${year}-${String(m).padStart(2, '0')}`, tax, metric, amount };
    }
  }
  if (yearM) return { from: utc(year, 1), to: utc(year + 1, 1), label: String(year), tax, metric, amount };
  return { tax, metric, amount };
}

export interface ReserveAnswer {
  question: ReserveQuestion;
  periods: PeriodLedger[];
  /** Total per token of the figure asked. */
  totals: Record<string, bigint>;
  /** The entries behind it, newest first. */
  entries: LedgerEntry[];
  /** The entry or payment that matches the amount the user quoted, if any. */
  matches?: LedgerEntry[];
}

/** Answers a question about the vault's figures from its ledger. */
export function answerReserveQuestion(q: ReserveQuestion, ledger: PeriodLedger[], o: { periodKind?: PeriodKind | null; incomeBuckets: string[]; decimals?: number }): ReserveAnswer {
  const inRange = (p: PeriodLedger) => {
    if (q.from === undefined || q.to === undefined || !o.periodKind) return true;
    const s = periodStart(o.periodKind, p.period);
    const e = periodEnd(o.periodKind, p.period);
    return s < q.to && e > q.from;
  };
  // Without a period, the latest one with activity.
  let periods = ledger.filter(inRange);
  if (q.from === undefined && periods.length) periods = [periods[periods.length - 1]];
  const wantBucket = (b?: string) => (q.tax === 'vat' ? b === 'vat' : q.tax === 'income' ? !!b && b !== 'vat' && (o.incomeBuckets.length === 0 || o.incomeBuckets.includes(b)) : true);
  const totals: Record<string, bigint> = {};
  const entries: LedgerEntry[] = [];
  for (const p of periods) {
    if (q.metric === 'received') {
      for (const [tk, x] of Object.entries(p.received.gross)) add(totals, tk, x);
      const seen = new Set<string>();
      for (const e of p.entries) if (e.kind === 'received' && !seen.has(e.tx + e.date)) {
        seen.add(e.tx + e.date);
        entries.push({ ...e, amount: e.gross ?? e.amount, bucket: undefined });
      }
      continue;
    }
    const src = q.metric === 'paid' ? p.paid : p.reserved;
    for (const [b, m] of Object.entries(src)) if (wantBucket(b)) for (const [tk, x] of Object.entries(m)) add(totals, tk, x);
    for (const e of p.entries) if ((q.metric === 'paid' ? e.kind === 'tax_paid' : e.kind === 'received') && wantBucket(e.bucket)) entries.push(e);
  }
  entries.sort((a, b) => (a.date < b.date ? 1 : -1));
  let matches: LedgerEntry[] | undefined;
  if (q.amount !== undefined) {
    const d = o.decimals ?? 7;
    const near = (x: bigint) => Math.abs(Number(formatAmount(x, d)) - q.amount!) <= 0.01;
    matches = entries.filter((e) => near(e.amount) || (e.gross !== undefined && near(e.gross)));
  }
  return { question: q, periods, totals, entries, matches };
}

// ---- tax-tool exports against the chain ----

export interface ExportCheck {
  tool: 'koinly' | 'cointracking' | 'ctc' | 'coinledger' | 'generic' | 'unknown';
  /** Transactions in the file. */
  fileTxs: number;
  /** Vault transactions (that a tax tool should see) missing from the file. */
  missing: string[];
  /** Transactions in the file the vault does not know. */
  unknown: string[];
  /** Same transaction, different total amount in the file. */
  differs: { tx: string; file: number; chain: number }[];
}

function csvRows(text: string): string[][] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const sep = [',', ';', '\t'].map((s) => [s, (lines[0] ?? '').split(s).length] as const).sort((a, b) => b[1] - a[1])[0][0];
  return lines.map((l) => {
    const out: string[] = [];
    let cur = '';
    let q = false;
    for (let i = 0; i < l.length; i++) {
      const c = l[i];
      if (q) {
        if (c === '"' && l[i + 1] === '"') (cur += '"'), i++;
        else if (c === '"') q = false;
        else cur += c;
      } else if (c === '"') q = true;
      else if (c === sep) out.push(cur), (cur = '');
      else cur += c;
    }
    out.push(cur);
    return out.map((x) => x.trim());
  });
}

const HASH = /\b([0-9a-f]{64})\b/i;

/**
 * Compares a tax-tool CSV with the vault's events: the transactions a tool
 * should hold (payments received, tax paid, conversions, yield) against the
 * hashes in the file, and the amounts on both sides.
 */
export function checkTaxExport(csv: string, rows: VaultEventRow[]): ExportCheck {
  const table = csvRows(csv);
  const head = (table[0] ?? []).map((h) => h.toLowerCase());
  const tool: ExportCheck['tool'] = head.includes('sent amount') && head.includes('tag')
    ? 'koinly'
    : head.includes('buy amount') && head.includes('trade-group')
      ? 'cointracking'
      : head.some((h) => h.startsWith('timestamp (utc)'))
        ? 'ctc'
        : head.some((h) => h.startsWith('asset sent'))
          ? 'coinledger'
          : head.includes('closed_at') && head.includes('kind')
            ? 'generic'
            : 'unknown';
  const amountCols = head.map((h, i) => (/(amount|^gross$|^buy amount$|^sell amount$)/.test(h) && !/fee|net worth|reference price/.test(h) ? i : -1)).filter((i) => i >= 0);
  const fileAmounts = new Map<string, number>();
  for (const r of table.slice(1)) {
    const h = r.map((c) => HASH.exec(c)?.[1]?.toLowerCase()).find((x) => x);
    if (!h) continue;
    const sum = amountCols.reduce((a, i) => a + (Number((r[i] ?? '').replace(',', '.')) || 0), 0);
    fileAmounts.set(h, (fileAmounts.get(h) ?? 0) + sum);
  }
  const chainAmounts = new Map<string, number>();
  for (const r of rows) {
    if (!['received', 'tax_paid', 'converted', 'harvested'].includes(r.kind)) continue;
    const x = r.kind === 'received' ? (r.gross ?? 0n) : r.kind === 'converted' ? (r.amount ?? 0n) + (r.amountOut ?? 0n) : (r.amount ?? 0n);
    chainAmounts.set(r.txHash.toLowerCase(), (chainAmounts.get(r.txHash.toLowerCase()) ?? 0) + Number(formatAmount(x)));
  }
  const missing = [...chainAmounts.keys()].filter((h) => !fileAmounts.has(h));
  const unknown = [...fileAmounts.keys()].filter((h) => !chainAmounts.has(h));
  const differs: ExportCheck['differs'] = [];
  for (const [h, f] of fileAmounts) {
    const c = chainAmounts.get(h);
    // A tool splits a payment into its base and its VAT: compare the totals, to the cent.
    if (c !== undefined && Math.abs(f - c) > 0.011) differs.push({ tx: h, file: Math.round(f * 100) / 100, chain: Math.round(c * 100) / 100 });
  }
  return { tool, fileTxs: fileAmounts.size, missing, unknown, differs };
}

/** The vault period that contains a calendar date (for "which period was 15 March in?"). */
export function periodAt(kind: PeriodKind, date: Date): number {
  return periodOf(kind, BigInt(Math.floor(date.getTime() / 1000)));
}
