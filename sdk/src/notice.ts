/**
 * Reading a tax office's notice (an assessment, a demand for an advance
 * payment): the due date and the amount, from the text of the PDF or of the
 * email. Where the payment date depends on the tax office (Germany,
 * Switzerland, the Netherlands, Luxembourg, Singapore...), this is how the
 * vault learns it: the app reads the notice, the user checks the two figures,
 * and the vault's due date is set from it (`set_due`) and the payment
 * scheduled.
 *
 * It recognises dates written the usual ways in English, Spanish, German,
 * French, Italian, Portuguese and Dutch, and amounts in both number styles
 * (1.234,56 and 1,234.56). Each candidate is scored by the words near it
 * ("fällig am", "a ingresar", "uiterlijk", "amount due"...).
 */

export interface NoticeFind<T> {
  value: T;
  /** The words around it in the notice. */
  context: string;
  score: number;
}

export interface NoticeReading {
  dates: NoticeFind<string>[];
  amounts: NoticeFind<number>[];
  /** The likeliest payment date (YYYY-MM-DD) and amount. */
  date?: string;
  amount?: number;
}

const MONTHS: Record<string, number> = {};
const names = [
  ['january', 'jan', 'enero', 'ene', 'januar', 'jän', 'janvier', 'janv', 'gennaio', 'gen', 'janeiro', 'januari'],
  ['february', 'feb', 'febrero', 'februar', 'février', 'fevrier', 'févr', 'febbraio', 'fevereiro', 'fev', 'februari'],
  ['march', 'mar', 'marzo', 'märz', 'maerz', 'mars', 'março', 'marco', 'maart', 'mrt'],
  ['april', 'apr', 'abril', 'abr', 'avril', 'avr', 'aprile'],
  ['may', 'mayo', 'mai', 'maggio', 'mag', 'maio', 'mei'],
  ['june', 'jun', 'junio', 'juni', 'juin', 'giugno', 'giu', 'junho'],
  ['july', 'jul', 'julio', 'juli', 'juillet', 'juil', 'luglio', 'lug', 'julho'],
  ['august', 'aug', 'agosto', 'ago', 'août', 'aout', 'augustus'],
  ['september', 'sep', 'sept', 'septiembre', 'setiembre', 'septembre', 'settembre', 'set', 'setembro'],
  ['october', 'oct', 'octubre', 'oktober', 'okt', 'octobre', 'ottobre', 'ott', 'outubro', 'out'],
  ['november', 'nov', 'noviembre', 'novembre', 'novembro'],
  ['december', 'dec', 'diciembre', 'dic', 'dezember', 'dez', 'décembre', 'decembre', 'déc', 'dicembre', 'dezembro'],
];
names.forEach((ns, i) => ns.forEach((n) => (MONTHS[n] = i + 1)));
const MONTH_RE = Object.keys(MONTHS)
  .sort((a, b) => b.length - a.length)
  .join('|');

/** Words that announce the payment date. */
const DUE_WORDS =
  /(f[äa]llig|zahlbar|zu zahlen bis|zahlungstermin|sp[äa]testens|bis zum|bis sp[äa]testens|entrichten bis|vencimiento|fecha l[íi]mite|plazo|antes del|hasta el|ingresar antes|uiterlijk|v[óo]{1,2}r|vervaldatum|betalen voor|te betalen v|due date|due on|due by|pay by|payable by|payable on or before|on or before|deadline|by|date limite|avant le|[ée]ch[ée]ance|au plus tard|payer|data limite|prazo|at[ée]|pagamento at[ée]|scadenza|entro il|da versare entro|zahlung bis|termin)\s*[:\-]?\s*$/i;
/** Words that announce the amount to pay. */
const AMOUNT_WORDS =
  /(a ingresar|a pagar|importe|total a pagar|cuota|resultado|deuda|betrag|zu zahlen|nachzahlung|abschlusszahlung|vorauszahlung|zahlbetrag|summe|te betalen|bedrag|totaal|amount due|balance due|total due|amount payable|to pay|payable|montant|à payer|a payer|reste à payer|total|valor a pagar|montante|importo|da versare|saldo)\b[^\d\n]{0,25}$/i;
/** Words that make a date unlikely to be the payment date. */
const NOT_DUE = /(datum|fecha de emisi[óo]n|issued|issue date|date of issue|ausgestellt|bescheid vom|vom|du|del ejercicio|ejercicio|tax year|steuerjahr|anno|periode|period|geboren|born|date de naissance)\s*[:\-]?\s*$/i;

function pad(n: number) {
  return String(n).padStart(2, '0');
}

function iso(y: number, m: number, d: number): string | undefined {
  if (y < 100) y += 2000;
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 2000 || y > 2100) return undefined;
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCMonth() !== m - 1) return undefined;
  return `${y}-${pad(m)}-${pad(d)}`;
}

/** Parses "1.234,56", "1,234.56", "1 234,56", "1234" to a number. */
export function parseNoticeAmount(s: string): number | undefined {
  const t = s.replace(/[\s  ']/g, '');
  if (!/\d/.test(t)) return undefined;
  const lastComma = t.lastIndexOf(',');
  const lastDot = t.lastIndexOf('.');
  let n: string;
  if (lastComma > lastDot) n = /,\d{1,2}$/.test(t) ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '');
  else if (lastDot > lastComma) n = /\.\d{1,2}$/.test(t) ? t.replace(/,/g, '') : t.replace(/\./g, '');
  else n = t;
  const v = Number(n);
  return Number.isFinite(v) ? v : undefined;
}

/** Finds the due date and the amount in a notice's text. `today` (YYYY-MM-DD) favours dates still to come. */
export function readNotice(text: string, today = new Date().toISOString().slice(0, 10)): NoticeReading {
  const t = text.replace(/\s+/g, ' ');
  const dates: NoticeFind<string>[] = [];
  const amounts: NoticeFind<number>[] = [];
  const ctx = (i: number, len: number) => t.slice(Math.max(0, i - 60), i + len + 20).trim();
  const scoreDate = (i: number, value: string) => {
    const before = t.slice(Math.max(0, i - 45), i);
    let s = 0;
    if (DUE_WORDS.test(before)) s += 5;
    else if (/(f[äa]llig|vencimiento|uiterlijk|due|[ée]ch[ée]ance|scadenza|prazo|plazo|zahl|pay|betal|pag|versa)/i.test(before)) s += 2;
    if (NOT_DUE.test(before)) s -= 4;
    if (value >= today) s += 1;
    return s;
  };
  const push = (i: number, len: number, value: string | undefined) => {
    if (value) dates.push({ value, context: ctx(i, len), score: scoreDate(i, value) });
  };
  // 31.01.2027, 31/01/2027, 31-01-2027 (day first), and 2027-01-31.
  for (const m of t.matchAll(/\b(\d{1,2})[./-](\d{1,2})[./-](\d{4}|\d{2})\b/g)) push(m.index!, m[0].length, iso(Number(m[3]), Number(m[2]), Number(m[1])));
  for (const m of t.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) push(m.index!, m[0].length, iso(Number(m[1]), Number(m[2]), Number(m[3])));
  // 31 de enero de 2027, 31. Januar 2027, 31 janvier 2027, 31 January 2027.
  const word = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th|º|\\.)?\\s+(?:de\\s+)?(${MONTH_RE})\\.?\\s+(?:de\\s+)?(\\d{4})\\b`, 'gi');
  for (const m of t.matchAll(word)) push(m.index!, m[0].length, iso(Number(m[3]), MONTHS[m[2].toLowerCase()], Number(m[1])));
  // January 31, 2027.
  const us = new RegExp(`\\b(${MONTH_RE})\\.?\\s+(\\d{1,2}),?\\s+(\\d{4})\\b`, 'gi');
  for (const m of t.matchAll(us)) push(m.index!, m[0].length, iso(Number(m[3]), MONTHS[m[1].toLowerCase()], Number(m[2])));
  // Amounts: a number with two decimals, or next to a currency.
  const money = /(?:(€|EUR|CHF|USD|\$|£|GBP|SGD|S\$|HK\$)\s?)?(\d{1,3}(?:[.,\s '’]\d{3})*(?:[.,]\d{2})|\d+[.,]\d{2})(?:\s?(€|EUR|CHF|USD|SGD))?/g;
  for (const m of t.matchAll(money)) {
    const i = m.index!;
    const value = parseNoticeAmount(m[2]);
    if (value === undefined || value <= 0) continue;
    // Skip what is really a date (31.01.27).
    if (/^\d{1,2}[.]\d{2}$/.test(m[2]) && /^[.]\d{2,4}/.test(t.slice(i + m[0].length))) continue;
    const before = t.slice(Math.max(0, i - 50), i);
    let score = m[1] || m[3] ? 2 : 0;
    if (AMOUNT_WORDS.test(before)) score += 5;
    else if (/(zahl|pagar|ingres|betal|pay|payer|pagam|versa|importe|betrag|bedrag|amount|montant|importo|valor)/i.test(before)) score += 2;
    amounts.push({ value, context: ctx(i, m[0].length), score });
  }
  const best = <T,>(xs: NoticeFind<T>[], tie: (a: T, b: T) => number) => [...xs].sort((a, b) => b.score - a.score || tie(a.value, b.value))[0]?.value;
  return {
    dates,
    amounts,
    date: best(dates, (a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    amount: best(amounts, (a, b) => b - a),
  };
}
