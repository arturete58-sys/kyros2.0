/**
 * Payout agent: a company, a DAO or a grants programme pays dozens of people
 * at once. It reads their list (a CSV from a spreadsheet or a payroll tool),
 * checks every line before anything is signed — a valid vault address, an
 * amount with no more decimals than the token has, no line twice — asks each
 * vault what it would set aside (`quote`), and builds the Router's
 * `pay_many` calls in runs small enough for one transaction each. The payer
 * signs once per run; each vault splits its payment by its own rule.
 */
import { scValToNative, StrKey, type xdr } from '@stellar/stellar-sdk';
import { parseAmount, type Split } from '../split.js';
import type { KyrosClient } from '../client.js';
import { invoiceReference } from '../client.js';
import { addr, type Payout } from '../scval.js';

export interface PayoutLine {
  /** 1-based line number in the file (header = 1). */
  line: number;
  vault: string;
  /** As written in the file. */
  amountText: string;
  amount?: bigint;
  /** The invoice number or a payroll reference; its sha256 is the payment's reference. */
  reference: string;
  name?: string;
  country?: string;
}

export type PayoutProblem =
  | 'not-an-address'
  | 'not-a-vault'
  | 'bad-amount'
  /** "1.234" or "1,234": a thousand or one and a bit? Written differently in different countries. */
  | 'ambiguous-amount'
  | 'too-many-decimals'
  | 'zero-amount'
  | 'duplicate'
  | 'missing-reference'
  | 'vault-unreachable'
  | 'token-not-accepted';

export interface PayoutCheck {
  lines: PayoutLine[];
  problems: { line: number; problem: PayoutProblem; detail?: string }[];
  total: bigint;
  /** The good lines, in runs of at most `perRun`. */
  runs: PayoutLine[][];
}

/** Payments per `pay_many` call: each one splits in its vault, and a transaction has resource limits. */
export const PAYOUTS_PER_RUN = 20;

const COLUMN: Record<keyof Omit<PayoutLine, 'line' | 'amount'>, RegExp> = {
  vault: /^(vault|b[óo]veda|address|direcci[óo]n|wallet|cuenta|account|recipient|destinatario|stellar|to|para|adresse|indirizzo|endere[cç]o|empf[äa]nger)/i,
  amountText: /^(amount|importe|cantidad|monto|betrag|montant|importo|valor|gross|bruto|total)/i,
  reference: /^(reference|referencia|ref|invoice|factura|concepto|memo|rechnung|facture|fattura|fatura|id)/i,
  name: /^(name|nombre|beneficiario|payee|nom|nome|empleado|employee|contributor)/i,
  country: /^(country|pa[ií]s|land|pays|paese)/i,
};

/** Splits a CSV line on `sep`, honouring double quotes. */
function cells(line: string, sep: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === sep) {
      out.push(cur.trim());
      cur = '';
    } else cur += c;
  }
  out.push(cur.trim());
  return out;
}

/** Reads a payout list: a header naming the columns (in English, Spanish, French, German, Italian or Portuguese), then one payment per line. */
export function parsePayouts(csv: string): PayoutLine[] {
  const rows = csv.split(/\r?\n/).filter((l) => l.trim());
  if (!rows.length) return [];
  const sep = [';', '\t', ','].map((s) => [s, rows[0].split(s).length] as const).sort((a, b) => b[1] - a[1])[0][0];
  const head = cells(rows[0], sep);
  const idx = Object.fromEntries(Object.entries(COLUMN).map(([k, re]) => [k, head.findIndex((h) => re.test(h))])) as Record<keyof typeof COLUMN, number>;
  if (idx.vault < 0 || idx.amountText < 0) throw new Error('the list needs a column for the address and one for the amount');
  return rows.slice(1).map((r, i) => {
    const c = cells(r, sep);
    const get = (k: keyof typeof COLUMN) => (idx[k] >= 0 ? (c[idx[k]] ?? '') : '');
    return { line: i + 2, vault: get('vault'), amountText: get('amountText'), reference: get('reference'), name: get('name') || undefined, country: get('country') || undefined };
  });
}

/** "1.234,56", "1,234.56", "1234.5" → token units (7 decimals). */
function amountOf(s: string, decimals: number): bigint {
  const t = s.replace(/[\s  '€$£]|USDC|EURC|EUR|USD/gi, '');
  if (/^\d{1,3}([.,])\d{3}(\1\d{3})+$/.test(t)) return parseAmount(t.replace(/[.,]/g, ''), decimals);
  const lastComma = t.lastIndexOf(',');
  const lastDot = t.lastIndexOf('.');
  const norm = lastComma > lastDot ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '');
  return parseAmount(norm, decimals);
}

/** Checks every line without touching the network. */
export function checkPayouts(lines: PayoutLine[], o: { decimals?: number; perRun?: number; needReference?: boolean } = {}): PayoutCheck {
  const decimals = o.decimals ?? 7;
  const problems: PayoutCheck['problems'] = [];
  const seen = new Map<string, number>();
  const good: PayoutLine[] = [];
  let total = 0n;
  for (const l of lines) {
    let ok = true;
    if (StrKey.isValidEd25519PublicKey(l.vault) || StrKey.isValidMed25519PublicKey(l.vault)) {
      // A wallet is not a vault: paying it would skip the split.
      problems.push({ line: l.line, problem: 'not-a-vault', detail: l.vault });
      ok = false;
    } else if (!StrKey.isValidContract(l.vault)) {
      problems.push({ line: l.line, problem: 'not-an-address', detail: l.vault });
      ok = false;
    }
    try {
      if (/^\s*\d{1,3}[.,]\d{3}\s*$/.test(l.amountText)) throw new Error('ambiguous');
      l.amount = amountOf(l.amountText, decimals);
      if (l.amount <= 0n) {
        problems.push({ line: l.line, problem: 'zero-amount' });
        ok = false;
      }
    } catch (e) {
      problems.push({ line: l.line, problem: /ambiguous/.test(String(e)) ? 'ambiguous-amount' : /decimals/.test(String(e)) ? 'too-many-decimals' : 'bad-amount', detail: l.amountText });
      ok = false;
    }
    if (!l.reference && o.needReference) {
      problems.push({ line: l.line, problem: 'missing-reference' });
      ok = false;
    }
    const key = `${l.vault}|${l.reference}|${l.amount ?? l.amountText}`;
    if (seen.has(key)) {
      problems.push({ line: l.line, problem: 'duplicate', detail: `line ${seen.get(key)}` });
      ok = false;
    } else seen.set(key, l.line);
    if (ok) {
      good.push(l);
      total += l.amount!;
    }
  }
  const per = o.perRun ?? PAYOUTS_PER_RUN;
  const runs: PayoutLine[][] = [];
  for (let i = 0; i < good.length; i += per) runs.push(good.slice(i, i + per));
  return { lines, problems, total, runs };
}

/**
 * Asks each vault, by simulation, whether it accepts the token and what it
 * would set aside: a contract that is not a Kyros vault, or one that does
 * not take this token, is caught before the run is signed.
 */
export async function verifyPayoutVaults(client: KyrosClient, check: PayoutCheck, token: string): Promise<{ problems: PayoutCheck['problems']; quotes: Map<number, Split> }> {
  const problems: PayoutCheck['problems'] = [];
  const quotes = new Map<number, Split>();
  for (const run of check.runs) {
    await Promise.all(
      run.map(async (l) => {
        try {
          const accepts = scValToNative(await client.read(l.vault, 'accepts', addr(token)));
          if (!accepts) {
            problems.push({ line: l.line, problem: 'token-not-accepted' });
            return;
          }
          quotes.set(l.line, await client.quote(l.vault, l.amount!));
        } catch (e) {
          problems.push({ line: l.line, problem: 'vault-unreachable', detail: (e as Error).message.slice(0, 160) });
        }
      }),
    );
  }
  problems.sort((a, b) => a.line - b.line);
  return { problems, quotes };
}

/** The payouts of one run, each carrying the sha256 of its reference (or of its line when there is none). */
export function payoutsOf(run: PayoutLine[]): Payout[] {
  return run.map((l) => ({ vault: l.vault, amount: l.amount!, reference: invoiceReference(l.reference || `payout-line-${l.line}`) }));
}

/** One `pay_many` operation per run, for the payer to sign. */
export function payoutOps(client: KyrosClient, router: string, from: string, token: string, check: PayoutCheck): xdr.Operation[] {
  return check.runs.map((run) => client.payManyOp(router, { from, token, payouts: payoutsOf(run) }));
}
