/**
 * The Kyros assistant: a chat that answers a user's tax questions from the
 * country's rule pack and their own vault, and tells them what to do next.
 * It runs entirely where it is called (in the app: the user's browser) — no
 * language model, no server, nothing leaves the device — and it never signs:
 * when an answer leads to an operation (apply a notice, register an invoice,
 * pay several people, convert the reserve), it returns it as an action the
 * user confirms in their own wallet.
 *
 * It understands questions in the app's six languages by their words
 * (deadlines, what is set aside, why a figure, VAT rates, whether the
 * reserve is enough, clients abroad, withholding, notices, invoices,
 * exports, euros and yield, bulk payouts, the law, moving country,
 * custody, late payment), and reads attached documents with the agents.
 */
import { checkReserve } from '../estimate.js';
import type { VaultEventRow } from '../events.js';
import type { PeriodKind } from '../periods.js';
import { vatChanges, vatRatesOn, type Deadline, type RulePack } from '../rulepacks.js';
import { taxYearStart } from '../installments.js';
import type { Rule } from '../split.js';
import { say, type AssistantLang, type TextKey } from './assistant-text.js';
import { classifyDocument, invoicePlan, readInvoice } from './invoice.js';
import { readNotice } from '../notice.js';
import { checkPayouts, parsePayouts, PAYOUTS_PER_RUN, type PayoutCheck } from './payouts.js';
import { answerReserveQuestion, buildLedger, checkTaxExport, parseReserveQuestion } from './reconcile.js';
import type { TreasuryReading } from './treasury.js';

export type { AssistantLang } from './assistant-text.js';

export type Intent =
  | 'greet'
  | 'deadline'
  | 'reserved'
  | 'spendable'
  | 'why'
  | 'vat'
  | 'enough'
  | 'abroad'
  | 'withholding'
  | 'notice'
  | 'invoice'
  | 'export'
  | 'fx'
  | 'yield'
  | 'payouts'
  | 'law'
  | 'move'
  | 'custody'
  | 'late'
  | 'payTax'
  | 'unknown';

/** Two amounts kept apart: what is in dollars (USDC) and in euros (EURC), 7 decimals. */
export interface Pair {
  usd: bigint;
  eur: bigint;
}

export interface AssistantContext {
  lang: AssistantLang;
  now?: Date;
  /** The country's name in `lang`. */
  countryName: string;
  pack?: RulePack | null;
  presetId?: string;
  /** The vault's rule. */
  rule?: Rule;
  /** Revenue the user gave at sign-up (VAT excluded, a year). */
  revenue?: number;
  activity?: string;
  spendable?: Pair;
  reserved?: Pair;
  /** Totals per bucket over the open periods. */
  buckets?: Record<string, Pair>;
  deadlines?: Deadline[];
  events?: VaultEventRow[];
  periodKind?: PeriodKind | null;
  /** The income-tax buckets of the preset (the rest is VAT). */
  incomeBuckets?: string[];
  /** Held in dollars for the period nearest its due date, with that date. */
  dollarReserve?: { period: number; amount: bigint; dueAt: bigint };
  /** The euro token contracts (EURC); amounts in any other token are dollars. */
  euroTokens?: string[];
  /** Reads the treasury (conversion, oracle, yield) on demand. */
  loadTreasury?: (apyBps?: number) => Promise<TreasuryReading | undefined>;
  /** Asks the network which payout vaults accept the token (optional). */
  verifyPayouts?: (c: PayoutCheck) => Promise<PayoutCheck['problems']>;
}

export type AssistantAction =
  | { kind: 'go'; screen: 'pay' | 'request' | 'settings' | 'activity' | 'home'; label: string }
  | { kind: 'attach'; accept: 'document' | 'csv'; label: string }
  | { kind: 'ask'; text: string }
  | { kind: 'apply-notice'; label: string; date: string; amount?: number; taxYearStart: bigint }
  | { kind: 'register-invoice'; label: string; number: string; terms: { vatBps: number; withholdingBps: number; buckets: { name: string; bps: number }[] } }
  | { kind: 'pay-many'; label: string; check: PayoutCheck }
  | { kind: 'convert'; label: string; period: number };

export interface AssistantReply {
  intent: Intent;
  /** Paragraphs separated by blank lines; lines starting with "- " are a list. */
  text: string;
  actions: AssistantAction[];
}

const LOCALE: Record<AssistantLang, string> = { es: 'es-ES', en: 'en-GB', pt: 'pt-PT', fr: 'fr-FR', de: 'de-DE', it: 'it-IT' };

// ---- intents ----

/** Words that point to each intent, in any of the six languages; the best-scoring intent wins. */
const WORDS: [Intent, RegExp, number][] = [
  ['greet', /^\s*(hola|hello|hi|hey|buenas|ol[áa]|oi|bonjour|salut|hallo|servus|ciao|salve)\b[\s!.?]*$/i, 5],
  ['why', /(por ?qu[ée]|why|warum|wieso|pourquoi|perch[ée]|porqu[eê]|explica|explain|erkl[äa]r|expliqu|spiega)/i, 2],
  ['why', /\b(130|303|131|modelo|trimestre|quarter|quartal|t[1-4]|q[1-4])\b/i, 1],
  ['deadline', /(cu[áa]ndo|plazo|vence|vencimiento|fecha|deadline|when|due|f[äa]llig|frist|termin|wann|[ée]ch[ée]ance|quand|scadenz|quando|prazo|calendario|calendar|kalender|calendrier)/i, 2],
  ['reserved', /(apartad|reservad|guardad|set aside|reserved|saved|zur[üu]ckgelegt|r[üu]cklage|mis de c[ôo]t[ée]|r[ée]serv[ée]|accantonat|da parte|reservad|separad|cu[áa]nto (tengo|hay|llevo)|how much (have|do) i|wie viel habe|combien j|quanto ho|quanto tenho)/i, 2],
  ['spendable', /(gastar|disponible|spend|available|ausgeben|verf[üu]gbar|d[ée]penser|disponible|spendere|disponibil|libre|free to use)/i, 3],
  ['vat', /(qu[ée] iva|tipo de iva|iva (aplico|cobro|pongo|cargo)|vat rate|which vat|what vat|charge vat|mwst|ust\.?-?satz|steuersatz|umsatzsteuer|taux de tva|quelle tva|aliquota|che iva|taxa de iva|que iva|igic)/i, 3],
  ['enough', /(suficiente|bastante|alcanza|\bllega\b|enough|reicht|genug|suffi|basta|chega|cu[áa]nto deber[íi]a|how much should|wie viel sollte|combien devrais|quanto dovrei|quanto devo|facturo|ingreso|gano|i (earn|bill|make)|verdiene|umsatz von|je (gagne|facture)|guadagno|fatturo|ganho|fa[çc]o)/i, 3],
  ['abroad', /(extranjer|abroad|foreign|ausland|[ée]tranger|estero|exterior|intracomunitari|intra-?eu|reverse[\s-]?charge|inversi[óo]n del sujeto|otro pa[íi]s|another country|other country|anderen land|autre pays|altro paese|outro pa[íi]s|fuera de (espa[ñn]a|mi pa[íi]s)|eu client|cliente (de la ue|europeo|ue))/i, 3],
  ['withholding', /(retenci[óo]n|retencion|retener|withhold|ritenuta|reten[çc][ãa]o|einbehalt|quellensteuer|retenue|irpf 15|15 ?%)/i, 3],
  ['notice', /(carta|notificaci|requerimiento|liquidaci[óo]n|aeat|finanzamt|bescheid|notice|letter from|avis d|courrier|avviso|cartella|notifica[çc][ãa]o|aviso das finan|hacienda me|me ha llegado|i got a|ho ricevuto|j.ai re[çc]u|ich habe .*bekommen|recebi)/i, 3],
  ['invoice', /(factura|invoice|rechnung|facture|fattura|fatura)/i, 2],
  ['export', /(koinly|cointracking|coinledger|crypto tax calculator|\bctc\b|gestor|asesor|accountant|steuerberat|comptable|commercialista|contabilista|exporta|export|csv|descargar|download|herunterladen|t[ée]l[ée]charg|scaric|descarreg)/i, 3],
  ['fx', /(euro|eurc|convert|cambiar a|cambio|exchange rate|tipo de cambio|divisa|\bfx\b|d[óo]lar|dollar|wechselkurs|umtausch|taux de change|tasso di cambio|c[âa]mbio|swap|soroswap|or[áa]culo|oracle|reflector)/i, 2],
  ['fx', /(convert|convierto|convertir|cambiar a euros|a euros|to euros|in euro|en euros|em euros|in eur\b)/i, 2],
  ['yield', /(rendimiento|rentabilidad|inter[ée]s(es)?|yield|apy|apr|blend|rendite|zinsen|rendement|int[ée]r[êe]ts|rendimento|interessi|juros|ganar con|earn on|prestar|lend)/i, 3],
  ['payouts', /(pagar a varios|pagos masivos|varias personas|n[óo]mina|payroll|bulk|batch|many people|several people|sammelzahlung|mehrere personen|paiements group[ée]s|plusieurs personnes|pagamenti multipli|pi[ùu] persone|pagamentos em massa|v[áa]rias pessoas|pay_many|becas|grants|bounties|dao)/i, 3],
  ['law', /(novedad|qu[ée] ha cambiado|cambios? (en|de) la ley|ley|law|legal|rules changed|what changed|gesetz|[äa]nderung|neuerung|loi|nouveaut|legge|novit[àa]|lei|novidade|verifactu|factura electr[óo]nica|e-?invoic|e-?rechnung|making tax digital|\bmtd\b|2027|reforma|reform)/i, 2],
  ['move', /(me mudo|mudarme|mudanza|me voy a vivir|cambio de pa[íi]s|moving|move to|relocat|umzieh|umzug|d[ée]m[ée]nag|trasferi|mi trasferisco|mudar(-me)? para|mudan[çc]a)/i, 4],
  ['custody', /(seguro|segura|custodi|puede kyros|tocar mi dinero|mis claves|clave privada|private key|safe|secure|custody|can kyros|sicher|verwahr|s[ûu]r|s[ée]curit|sicuro|sicurezza|seguran[çc]a|chave privada|robar|steal|hack)/i, 3],
  ['late', /(tarde|retraso|atraso|recargo|multa|sanci[óo]n|late|penalt|fine|interest on late|s[äa]umnis|versp[äa]t|zu sp[äa]t|zuschlag|retard|p[ée]nalit|ritardo|sanzion|mora|atrasad)/i, 3],
  ['payTax', /(c[óo]mo pago|pagar (el|los|mis) impuesto|pay (my )?tax|how do i pay|steuer(n)? zahlen|wie zahle|payer (mes|les) imp[ôo]ts|comment payer|pagare le tasse|come pago|pagar (os )?impostos|como pago)/i, 4],
];

export function detectIntent(q: string): Intent {
  const score = new Map<Intent, number>();
  for (const [intent, re, w] of WORDS) if (re.test(q)) score.set(intent, (score.get(intent) ?? 0) + w);
  // A question about a figure in a period ("why ... Q3") is the reconciliation, even with other words around.
  if ((score.get('why') ?? 0) >= 2 && /(\b(t|q)[1-4]\b|trimestre|quarter|quartal|\b20\d{2}\b|enero|january|mes|month)/i.test(q)) score.set('why', (score.get('why') ?? 0) + 3);
  // "How much would I earn at 4%" is yield, not the reserve check.
  if ((score.get('yield') ?? 0) > 0 && /\d\s*%/.test(q)) score.set('yield', (score.get('yield') ?? 0) + 2);
  const best = [...score.entries()].sort((a, b) => b[1] - a[1])[0];
  return best ? best[0] : 'unknown';
}

// ---- formatting ----

function fmtNum(lang: AssistantLang, n: number, digits = 2): string {
  return new Intl.NumberFormat(LOCALE[lang], { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n);
}
const units = (x: bigint) => Number(x) / 1e7;
function fmtPair(lang: AssistantLang, p: Pair): string {
  const parts: string[] = [];
  if (p.usd !== 0n) parts.push(`${fmtNum(lang, units(p.usd))} USDC`);
  if (p.eur !== 0n) parts.push(`${fmtNum(lang, units(p.eur))} EURC`);
  return parts.join(' + ') || fmtNum(lang, 0);
}
// A no-break space keeps "21 %" on one line.
const pct = (lang: AssistantLang, bps: number) => `${new Intl.NumberFormat(LOCALE[lang], { maximumFractionDigits: 2 }).format(bps / 100)}\u00a0%`;
function fmtDate(lang: AssistantLang, iso: string): string {
  const d = new Date(`${iso.slice(0, 10)}T12:00:00Z`);
  return new Intl.DateTimeFormat(LOCALE[lang], { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(d);
}
const shortTx = (h: string) => `${h.slice(0, 6)}…${h.slice(-4)}`;

/** "2026-Q3" / "2026-03" / "2026" as the phrase that opens a sentence: "En el 3.er trimestre de 2026", "In Q3 2026"... */
function periodWords(lang: AssistantLang, label: string): string {
  const q = /^(\d{4})-Q([1-4])$/.exec(label);
  if (q) {
    const [y, n] = [q[1], q[2]];
    return { es: `En el ${n}.º trimestre de ${y}`, en: `In Q${n} ${y}`, pt: `No ${n}.º trimestre de ${y}`, fr: `Au ${n === '1' ? '1er' : `${n}e`} trimestre ${y},`, de: `Im Q${n} ${y}`, it: `Nel ${n}° trimestre ${y}` }[lang];
  }
  const m = /^(\d{4})-(\d{2})$/.exec(label);
  if (m) {
    const month = new Intl.DateTimeFormat(LOCALE[lang], { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 15)));
    return { es: `En ${month}`, en: `In ${month}`, pt: `Em ${month}`, fr: `En ${month},`, de: `Im ${month}`, it: `A ${month}` }[lang];
  }
  return { es: `En ${label}`, en: `In ${label}`, pt: `Em ${label}`, fr: `En ${label},`, de: `Im Jahr ${label}`, it: `Nel ${label}` }[lang];
}

/** The first plain number in a question (40.000, 40,000, 40k, 40 mil). */
export function numberIn(q: string): number | undefined {
  const m = /(\d{1,3}(?:[.,\s]\d{3})+|\d+(?:[.,]\d+)?)\s*(k|mil\b|tausend|mille|thousand)?/i.exec(q.replace(/\b20\d{2}\b/g, ''));
  if (!m) return undefined;
  let s = m[1];
  if (/^\d{1,3}([.,\s]\d{3})+$/.test(s)) s = s.replace(/[.,\s]/g, '');
  else s = s.replace(',', '.');
  let n = Number(s);
  if (!Number.isFinite(n)) return undefined;
  if (m[2]) n *= 1000;
  return n;
}

function percentIn(q: string): number | undefined {
  const m = /(\d{1,2}(?:[.,]\d{1,2})?)\s*%/.exec(q);
  return m ? Math.round(Number(m[1].replace(',', '.')) * 100) : undefined;
}

const sumPair = (xs: Pair[]): Pair => xs.reduce((a, b) => ({ usd: a.usd + b.usd, eur: a.eur + b.eur }), { usd: 0n, eur: 0n });

// ---- answers ----

export function assistantIntro(ctx: AssistantContext): AssistantReply {
  const L = ctx.lang;
  return {
    intent: 'greet',
    text: `${say(L, 'intro', { country: ctx.countryName })}\n\n${say(L, 'tryAsking')}`,
    actions: (['q1', 'q2', 'q3', 'q4', 'q5', 'q6'] as TextKey[]).map((k) => ({ kind: 'ask' as const, text: say(L, k) })),
  };
}

function bucketName(lang: AssistantLang, b: string, ctx: AssistantContext): string {
  if (b === 'vat') return say(lang, 'taxVat');
  // Pack labels are in English: other languages get the tax's name and the bucket's own short name.
  const label = ctx.pack?.presets.find((p) => p.id === ctx.presetId)?.buckets.find((x) => x.name === b)?.label;
  if (lang === 'en' && label) return label;
  return `${say(lang, 'bucketIncome')} (${b.toUpperCase().replace(/_/g, ' ')})`;
}

function deadlines(ctx: AssistantContext): AssistantReply {
  const L = ctx.lang;
  const ds = (ctx.deadlines ?? []).slice(0, 4);
  if (!ds.length) return { intent: 'deadline', text: say(L, 'deadlinesNone'), actions: [] };
  // What is set aside goes with the first deadline of its bucket (prepayments take the income-tax reserve).
  const income = ctx.incomeBuckets ?? ctx.rule?.buckets.map((b) => b.name) ?? [];
  const used = new Set<string>();
  const lines = ds.map((d) => {
    const b = d.bucket && ctx.buckets?.[d.bucket] ? d.bucket : d.kind === 'prepayment' || d.kind === 'income' ? income.find((x) => !used.has(x) && ctx.buckets?.[x]) : undefined;
    const held = b && !used.has(b) ? ctx.buckets?.[b] : undefined;
    if (b) used.add(b);
    const h = held && (held.usd > 0n || held.eur > 0n) ? ` — ${say(L, 'deadlineHeld', { amount: fmtPair(L, held) })}` : '';
    return `- ${fmtDate(L, d.date)}: ${d.what}${h}`;
  });
  return { intent: 'deadline', text: `${say(L, 'deadlinesHead')}\n${lines.join('\n')}\n\n${say(L, 'deadlineTip')}`, actions: [{ kind: 'go', screen: 'pay', label: say(L, 'a_pay') }] };
}

function reserved(ctx: AssistantContext): AssistantReply {
  const L = ctx.lang;
  const entries = Object.entries(ctx.buckets ?? {}).filter(([, p]) => p.usd > 0n || p.eur > 0n);
  if (!entries.length) return { intent: 'reserved', text: say(L, 'reservedNone'), actions: [] };
  const total = sumPair(entries.map(([, p]) => p));
  const lines = entries.map(([b, p]) => {
    const next = (ctx.deadlines ?? []).find((d) => d.bucket === b);
    return `- ${bucketName(L, b, ctx)}: ${fmtPair(L, p)}${next ? ` (${fmtDate(L, next.date)})` : ''}`;
  });
  return { intent: 'reserved', text: `${say(L, 'reservedHead', { total: fmtPair(L, total) })}\n${lines.join('\n')}`, actions: [{ kind: 'go', screen: 'pay', label: say(L, 'a_pay') }] };
}

function vat(ctx: AssistantContext): AssistantReply {
  const L = ctx.lang;
  const pack = ctx.pack;
  if (!pack?.vatRates?.length) return { intent: 'vat', text: say(L, 'vatNone', { country: ctx.countryName }), actions: [] };
  const now = ctx.now ?? new Date();
  const rates = vatRatesOn(pack, now);
  const list = (r: Record<string, number>) =>
    Object.entries(r)
      .filter(([k]) => !k.startsWith('regional_'))
      .map(([, v]) => pct(L, v))
      .filter((v, i, a) => a.indexOf(v) === i)
      .join(' / ');
  const parts = [say(L, 'vatInForce', { vat: pack.vatName ?? say(L, 'taxVat'), country: ctx.countryName, rates: list(rates) })];
  if (ctx.rule) parts.push(say(L, 'vatVault', { pct: pct(L, ctx.rule.vatBps) }));
  for (const c of vatChanges(pack, now).slice(0, 2)) parts.push(say(L, 'vatChange', { date: fmtDate(L, c.from), rates: list(c.rates), proposed: c.proposed ? say(L, 'proposedTag') : '' }));
  parts.push(say(L, 'vatFollow'));
  return { intent: 'vat', text: parts.join('\n\n'), actions: [{ kind: 'go', screen: 'settings', label: say(L, 'a_settings') }] };
}

function enough(q: string, ctx: AssistantContext): AssistantReply {
  const L = ctx.lang;
  const pack = ctx.pack;
  const revenue = numberIn(q) ?? ctx.revenue;
  if (!pack || !ctx.presetId) return { intent: 'enough', text: say(L, 'askRevenue'), actions: [] };
  if (!revenue) return { intent: 'enough', text: say(L, 'askRevenue'), actions: [] };
  const reserveBps = ctx.rule ? ctx.rule.buckets.reduce((a, b) => a + b.bps, 0) : undefined;
  const c = checkReserve(pack, ctx.presetId, { revenue, activity: ctx.activity, reserveBps });
  const current = pct(L, c.reserveBps);
  if (c.requiredBps === undefined || c.status === 'unknown') return { intent: 'enough', text: say(L, 'reserveUnknown', { country: ctx.countryName, current }), actions: [] };
  const money = `${new Intl.NumberFormat(LOCALE[L], { maximumFractionDigits: 0 }).format(revenue)} ${pack.currency}`;
  const head = say(L, 'reserveEstimate', { revenue: money, country: ctx.countryName, required: pct(L, c.requiredBps), recommended: pct(L, c.recommendedBps ?? c.requiredBps), current });
  const verdict = c.status === 'short' ? say(L, 'reserveShort') : c.status === 'generous' ? say(L, 'reserveGenerous') : say(L, 'reserveOk');
  const year = pack.estimate?.year ?? (ctx.now ?? new Date()).getUTCFullYear();
  return {
    intent: 'enough',
    text: `${head}\n\n${verdict}\n\n${say(L, 'estimateCaveat', { year })}`,
    actions: c.status === 'short' ? [{ kind: 'go', screen: 'settings', label: say(L, 'a_settings') }] : [],
  };
}

function why(q: string, ctx: AssistantContext): AssistantReply {
  const L = ctx.lang;
  const rq = parseReserveQuestion(q, ctx.now ?? new Date());
  const incomeBuckets = ctx.incomeBuckets ?? ctx.rule?.buckets.map((b) => b.name) ?? [];
  const ledger = buildLedger(ctx.events ?? [], { buckets: ctx.rule?.buckets.map((b) => b.name) ?? incomeBuckets, periodKind: ctx.periodKind });
  const a = answerReserveQuestion(rq, ledger, { periodKind: ctx.periodKind, incomeBuckets });
  const label = rq.label ? periodWords(L, rq.label) : say(L, 'lastPeriod');
  const tax = say(L, rq.tax === 'vat' ? 'taxVat' : rq.tax === 'income' ? 'taxIncome' : 'taxAll');
  const total: Pair = { usd: 0n, eur: 0n };
  // Tokens are told apart by the events themselves: EURC events name the euro token.
  for (const [tk, x] of Object.entries(a.totals)) (isEuro(tk, ctx) ? (total.eur += x) : (total.usd += x));
  if (!a.entries.length) return { intent: 'why', text: say(L, 'whyNone', { label, tax }), actions: [{ kind: 'go', screen: 'activity', label: say(L, 'a_activity') }] };
  const pairOf = (tk: string | undefined, x: bigint): Pair => (tk && isEuro(tk, ctx) ? { usd: 0n, eur: x } : { usd: x, eur: 0n });
  const head =
    rq.metric === 'paid'
      ? say(L, 'paidHead', { label, total: fmtPair(L, total), tax })
      : rq.metric === 'received'
        ? say(L, 'receivedHead', { label, total: fmtPair(L, total), n: a.entries.length })
        : say(L, 'whyHead', { label, total: fmtPair(L, total), tax, n: new Set(a.entries.map((e) => e.tx)).size });
  const shown = a.entries.slice(0, 6).map((e) => `- ${say(L, 'whyLine', { date: fmtDate(L, e.date), amount: fmtPair(L, pairOf(e.token, e.amount)), of: e.gross !== undefined && rq.metric === 'reserved' ? say(L, 'whyOf', { gross: fmtPair(L, pairOf(e.token, e.gross)) }) : '', tx: shortTx(e.tx) })}`);
  if (a.entries.length > 6) shown.push(`- ${say(L, 'more', { n: a.entries.length - 6 })}`);
  const parts = [head, shown.join('\n')];
  if (rq.metric === 'reserved' && ctx.rule) parts.push(say(L, 'whyRule', { vat: pct(L, ctx.rule.vatBps), res: pct(L, ctx.rule.buckets.reduce((s, b) => s + b.bps, 0)) }));
  if (rq.amount !== undefined) {
    const m = a.matches?.[0];
    const amount = fmtNum(L, rq.amount);
    parts.push(m ? say(L, 'whyMatch', { amount, date: fmtDate(L, m.date), tx: shortTx(m.tx) }) : say(L, 'whyNoMatch', { amount }));
  }
  return { intent: 'why', text: parts.join('\n\n'), actions: [{ kind: 'go', screen: 'activity', label: say(L, 'a_activity') }] };
}

/** Whether a token contract is the euro one (EURC); every other token counts as dollars. */
const isEuro = (tk: string, ctx: AssistantContext) => ctx.euroTokens?.includes(tk) ?? false;

function law(ctx: AssistantContext): AssistantReply {
  const L = ctx.lang;
  const pack = ctx.pack;
  if (!pack) return { intent: 'law', text: say(L, 'notUnderstood'), actions: [] };
  const now = ctx.now ?? new Date();
  const parts = [say(L, 'lawHead', { country: ctx.countryName, reviewed: fmtDate(L, pack.reviewed ?? now.toISOString()) })];
  const changes = vatChanges(pack, now)
    .slice(0, 3)
    .map((c) => `- ${say(L, 'vatChange', { date: fmtDate(L, c.from), rates: Object.values(c.rates).map((v) => pct(L, v)).filter((v, i, a) => a.indexOf(v) === i).join(' / '), proposed: c.proposed ? say(L, 'proposedTag') : '' })}`);
  if (changes.length) parts.push(changes.join('\n'));
  const notes = (pack.notes ?? []).filter((n) => !/^Rule packs are information/.test(n)).slice(0, 6);
  if (notes.length) parts.push(`${say(L, 'lawNotesLang')}\n${notes.map((n) => `- ${n}`).join('\n')}`);
  const official = (pack.sources ?? []).filter((s) => (s as { official?: boolean }).official).length;
  parts.push(say(L, 'lawSources', { n: official }));
  return { intent: 'law', text: parts.join('\n\n'), actions: [{ kind: 'go', screen: 'settings', label: say(L, 'a_settings') }] };
}

function late(ctx: AssistantContext): AssistantReply {
  const L = ctx.lang;
  const facts = ctx.pack?.enforcement?.facts ?? [];
  const parts = facts.length ? [`${say(L, 'late', { country: ctx.countryName })}\n${facts.map((f) => `- ${f}`).join('\n')}`] : [];
  parts.push(say(L, 'lateTip'));
  return { intent: 'late', text: parts.join('\n\n'), actions: [{ kind: 'go', screen: 'pay', label: say(L, 'a_pay') }] };
}

async function fx(ctx: AssistantContext): Promise<AssistantReply> {
  const L = ctx.lang;
  const r = ctx.dollarReserve;
  if (!r || r.amount <= 0n) return { intent: 'fx', text: say(L, 'fxNothing'), actions: [] };
  const t = await ctx.loadTreasury?.().catch(() => undefined);
  if (!t) return { intent: 'fx', text: say(L, 'fxNoData'), actions: [] };
  const a = t.advice;
  const held = `${fmtNum(L, units(r.amount))} USDC`;
  const spread = a.spreadBps !== undefined ? pct(L, Math.max(0, a.spreadBps)) : '—';
  const days = Math.max(0, a.days);
  if (a.decision === 'set-up-conversion') {
    const text = [say(L, 'fxSetup', { held }), ...(a.reasons.includes('notice-longer-than-due') ? [say(L, 'fxLate')] : [])].join('\n\n');
    return { intent: 'fx', text, actions: [{ kind: 'go', screen: 'settings', label: say(L, 'a_settings') }] };
  }
  if (a.decision === 'cannot-quote') return { intent: 'fx', text: say(L, 'fxCannot'), actions: [] };
  if (a.decision === 'nothing-to-convert') return { intent: 'fx', text: say(L, 'fxNothing'), actions: [] };
  if (a.decision === 'convert-now') {
    const text = a.reasons.includes('due-soon') ? say(L, 'fxDueSoon', { days }) : say(L, 'fxNow', { held, out: fmtNum(L, units(a.quotedOut ?? 0n)), spread, days });
    return { intent: 'fx', text, actions: [{ kind: 'convert', label: say(L, 'a_convert'), period: r.period }] };
  }
  return { intent: 'fx', text: say(L, 'fxWait', { spread, days }), actions: [] };
}

async function yieldAnswer(q: string, ctx: AssistantContext): Promise<AssistantReply> {
  const L = ctx.lang;
  const given = percentIn(q);
  const t = await ctx.loadTreasury?.(given).catch(() => undefined);
  const y = t?.yield;
  if (!y) return { intent: 'yield', text: `${say(L, 'yieldAsk')}\n\n${say(L, 'yieldRisk')}`, actions: [] };
  const amount = `${fmtNum(L, units(y.untilDue))} USDC`;
  const text =
    y.source === 'observed'
      ? say(L, 'yieldObserved', { apy: pct(L, y.apyBps), days: y.days, amount })
      : say(L, 'yieldGiven', { apy: pct(L, y.apyBps), held: `${fmtNum(L, units(ctx.dollarReserve?.amount ?? 0n))} USDC`, days: y.days, amount });
  return { intent: 'yield', text: `${text}\n\n${say(L, 'yieldRisk')}`, actions: [] };
}

/** Answers a question typed in the chat. */
export async function assistantReply(question: string, ctx: AssistantContext): Promise<AssistantReply> {
  const L = ctx.lang;
  const intent = detectIntent(question);
  switch (intent) {
    case 'greet':
      return assistantIntro(ctx);
    case 'deadline':
      return deadlines(ctx);
    case 'reserved':
      return reserved(ctx);
    case 'spendable':
      return { intent, text: say(L, 'spendable', { amount: fmtPair(L, ctx.spendable ?? { usd: 0n, eur: 0n }) }), actions: [] };
    case 'why':
      return why(question, ctx);
    case 'vat':
      return vat(ctx);
    case 'enough':
      return enough(question, ctx);
    case 'abroad':
      return { intent, text: say(L, 'abroad'), actions: [{ kind: 'go', screen: 'home', label: say(L, 'a_home') }] };
    case 'withholding':
      return { intent, text: `${ctx.pack?.country === 'ES' ? say(L, 'withholding') : say(L, 'withholdingOther')}`, actions: ctx.pack?.country === 'ES' ? [{ kind: 'go', screen: 'request', label: say(L, 'a_request') }] : [{ kind: 'attach', accept: 'document', label: say(L, 'a_attach') }] };
    case 'notice':
      return { intent, text: say(L, 'noticeIntro'), actions: [{ kind: 'attach', accept: 'document', label: say(L, 'a_attach') }, { kind: 'go', screen: 'pay', label: say(L, 'a_pay') }] };
    case 'invoice':
      return { intent, text: say(L, 'invoiceIntro'), actions: [{ kind: 'attach', accept: 'document', label: say(L, 'a_attach') }, { kind: 'go', screen: 'request', label: say(L, 'a_request') }] };
    case 'export':
      return { intent, text: say(L, 'exportIntro'), actions: [{ kind: 'go', screen: 'activity', label: say(L, 'a_activity') }, { kind: 'attach', accept: 'csv', label: say(L, 'a_attachCsv') }] };
    case 'fx':
      return fx(ctx);
    case 'yield':
      return yieldAnswer(question, ctx);
    case 'payouts':
      return { intent, text: say(L, 'payoutsIntro', { per: PAYOUTS_PER_RUN }), actions: [{ kind: 'attach', accept: 'csv', label: say(L, 'a_attachCsv') }] };
    case 'law':
      return law(ctx);
    case 'move':
      return { intent, text: say(L, 'move'), actions: [{ kind: 'go', screen: 'settings', label: say(L, 'a_settings') }] };
    case 'custody':
      return { intent, text: say(L, 'custody'), actions: [] };
    case 'late':
      return late(ctx);
    case 'payTax':
      return { intent, text: say(L, 'payTax'), actions: [{ kind: 'go', screen: 'pay', label: say(L, 'a_pay') }] };
    default:
      return { intent: 'unknown', text: `${say(L, 'notUnderstood')}\n${say(L, 'topics')}`, actions: (['q1', 'q3', 'q5'] as TextKey[]).map((k) => ({ kind: 'ask' as const, text: say(L, k) })) };
  }
}

/** The tax year a notice is about: a year written next to "ejercicio", "tax year", "Steuerjahr"... or the last one. */
function noticeYear(text: string, pack: RulePack, now: Date): bigint {
  const m = /(ejercicio|periodo|tax year|year of assessment|steuerjahr|veranlagungszeitraum|f[üu]r das jahr|ann[ée]e|anno d['’]imposta|ano)\D{0,12}(20\d{2})/i.exec(text);
  const nowSecs = BigInt(Math.floor(now.getTime() / 1000));
  if (m) {
    const y = Number(m[2]);
    const offset = y - now.getUTCFullYear();
    return taxYearStart(pack.calendar.fiscalYearStart, nowSecs, offset);
  }
  return taxYearStart(pack.calendar.fiscalYearStart, nowSecs, -1);
}

/** Reads a document attached in the chat with the right agent. */
export async function assistantDocument(text: string, fileName: string, ctx: AssistantContext): Promise<AssistantReply> {
  const L = ctx.lang;
  const now = ctx.now ?? new Date();
  const kind = classifyDocument(text, fileName);
  if (kind === 'notice') {
    const n = readNotice(text, now.toISOString().slice(0, 10));
    if (!n.date || !ctx.pack) return { intent: 'notice', text: say(L, 'noticeNoDate'), actions: [{ kind: 'go', screen: 'pay', label: say(L, 'a_pay') }] };
    const start = noticeYear(text, ctx.pack, now);
    const year = new Date(Number(start + 86_400n) * 1000).getUTCFullYear();
    const amount = n.amount !== undefined ? say(L, 'noticeAmount', { amount: fmtNum(L, n.amount) }) : '';
    return {
      intent: 'notice',
      text: say(L, 'noticeRead', { date: fmtDate(L, n.date), amount, year }),
      actions: [{ kind: 'apply-notice', label: say(L, 'a_applyNotice'), date: n.date, amount: n.amount, taxYearStart: start }],
    };
  }
  if (kind === 'invoice') {
    const r = readInvoice(text);
    const rule = ctx.rule ?? { vatBps: 0, buckets: [] };
    const plan = invoicePlan(r, rule);
    const cur = r.currency ? ` ${r.currency}` : '';
    const f = (k: TextKey, x?: number) => (x !== undefined ? say(L, k, { x: `${fmtNum(L, x)}${cur}` }) : undefined);
    const figures = [f('fBase', r.base), r.treatment === 'standard' && r.vatRateBps !== undefined ? say(L, 'fVat', { x: pct(L, r.vatRateBps) }) : undefined, r.withholdingRateBps ? say(L, 'fWh', { x: pct(L, r.withholdingRateBps) }) : undefined, f('fTotal', r.total)].filter(Boolean).join(', ');
    const parts = [say(L, 'invoiceRead', { number: r.number ?? say(L, 'invNoNumber'), figures: figures || '—' })];
    const treat: Partial<Record<typeof r.treatment, TextKey>> = { 'reverse-charge': 'treat_reverse', exempt: 'treat_exempt', 'outside-scope': 'treat_outside', franchise: 'treat_franchise' };
    if (treat[r.treatment]) parts.push(say(L, treat[r.treatment]!, { w: r.treatmentEvidence ?? '' }));
    if (r.treatment === 'standard' && r.vatRateBps === undefined) parts.push(say(L, 'warn_vat', { pct: pct(L, rule.vatBps) }));
    parts.push(say(L, 'invoicePlan', { vat: pct(L, plan.terms.vatBps), wh: pct(L, plan.terms.withholdingBps), res: pct(L, plan.terms.buckets.reduce((s, b) => s + b.bps, 0)) }));
    if (r.warnings.includes('totals-do-not-add-up')) parts.push(say(L, 'warn_totals'));
    if (!r.number) parts.push(say(L, 'warn_number'));
    const actions: AssistantAction[] = r.number ? [{ kind: 'register-invoice', label: say(L, 'a_registerInvoice'), number: r.number, terms: plan.terms }] : [{ kind: 'go', screen: 'request', label: say(L, 'a_request') }];
    return { intent: 'invoice', text: parts.join('\n\n'), actions };
  }
  if (kind === 'payouts-csv') {
    let check: PayoutCheck;
    try {
      check = checkPayouts(parsePayouts(text), { decimals: 7 });
    } catch {
      return { intent: 'payouts', text: say(L, 'payoutsIntro', { per: PAYOUTS_PER_RUN }), actions: [] };
    }
    if (ctx.verifyPayouts && check.runs.length) {
      const more = await ctx.verifyPayouts(check).catch(() => []);
      if (more.length) {
        const bad = new Set(more.map((p) => p.line));
        check = { ...check, problems: [...check.problems, ...more].sort((a, b) => a.line - b.line), runs: check.runs.map((r) => r.filter((l) => !bad.has(l.line))).filter((r) => r.length) };
        check.total = check.runs.flat().reduce((s, l) => s + (l.amount ?? 0n), 0n);
      }
    }
    const ok = check.runs.reduce((s, r) => s + r.length, 0);
    const parts = [ok ? say(L, 'payoutsChecked', { ok, total: `${fmtNum(L, units(check.total))} USDC`, runs: check.runs.length }) : say(L, 'payoutsNoneOk')];
    if (check.problems.length) parts.push(`${say(L, 'payoutsProblems')}\n${check.problems.slice(0, 12).map((p) => `- ${say(L, 'line', { line: p.line, what: say(L, `p_${p.problem}` as TextKey, { detail: p.detail ?? '' }) })}`).join('\n')}`);
    return { intent: 'payouts', text: parts.join('\n\n'), actions: ok && !check.problems.length ? [{ kind: 'pay-many', label: say(L, 'a_payMany'), check }] : [] };
  }
  if (kind === 'tax-export-csv') {
    const c = checkTaxExport(text, ctx.events ?? []);
    const tool = { koinly: 'Koinly', cointracking: 'CoinTracking', ctc: 'Crypto Tax Calculator', coinledger: 'CoinLedger', generic: 'Kyros', unknown: '?' }[c.tool];
    const parts = [say(L, 'exportChecked', { tool, n: c.fileTxs })];
    if (!c.missing.length && !c.unknown.length && !c.differs.length) parts.push(say(L, 'exportOk'));
    if (c.missing.length) parts.push(say(L, 'exportMissing', { n: c.missing.length }));
    if (c.unknown.length) parts.push(say(L, 'exportUnknown', { n: c.unknown.length }));
    for (const d of c.differs.slice(0, 5)) parts.push(say(L, 'exportDiffers', { tx: shortTx(d.tx), file: fmtNum(L, d.file), chain: fmtNum(L, d.chain) }));
    return { intent: 'export', text: parts.join('\n\n'), actions: [{ kind: 'go', screen: 'activity', label: say(L, 'a_activity') }] };
  }
  return { intent: 'unknown', text: say(L, 'unknownDoc'), actions: [] };
}
