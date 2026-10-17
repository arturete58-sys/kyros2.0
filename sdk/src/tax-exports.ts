/**
 * Exports for the tax tools crypto users already declare with. Kyros sets
 * the money aside when a payment arrives; these tools compute and file the
 * return. The export saves typing every payment in again.
 *
 *   - Koinly: its universal CSV (support.koinly.io, "How to create a custom
 *     CSV file with your data").
 *   - CoinTracking: its custom CSV import layout; CoinTracking's importer also
 *     lets the user map columns if its layout changes.
 *   - Generic: `toCsv` in events.ts, one line per event, for an accountant.
 *
 * Each payment becomes its taxable base (tagged as income) and, separately,
 * the VAT it carried (not income: it belongs to the tax authority and is
 * held in the vault until paid). Tax paid from the vault leaves as a
 * withdrawal; a conversion to euros is a trade; yield is interest income.
 * Releases from the vault to the owner are moves between the user's own
 * accounts and are left out.
 */
import { formatAmount } from './split.js';
import type { VaultEventRow } from './events.js';

export type TaxTool = 'koinly' | 'cointracking';

const cell = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
/** `YYYY-MM-DD HH:mm:ss`, UTC. */
const when = (iso: string) => iso.replace('T', ' ').replace(/\.\d+Z?$|Z$/, '').slice(0, 19);
const amt = (x: bigint) => formatAmount(x);

interface Line {
  date: string;
  kind: 'income' | 'vat-in' | 'tax-out' | 'trade' | 'interest';
  inAmount?: bigint;
  inCurrency?: string;
  outAmount?: bigint;
  outCurrency?: string;
  description: string;
  tx: string;
}

function lines(rows: VaultEventRow[], symbol: (token: string) => string): Line[] {
  const out: Line[] = [];
  for (const r of rows) {
    const date = when(r.closedAt);
    const cur = r.token ? symbol(r.token) : '';
    if (r.kind === 'received' && r.gross !== undefined) {
      const vat = r.vat ?? 0n;
      const incomeReserve = (r.reserve ?? 0n) - vat;
      out.push({
        date,
        kind: 'income',
        inAmount: r.gross - vat,
        inCurrency: cur,
        description: `Payment received, excluding VAT${incomeReserve > 0n ? `; ${amt(incomeReserve)} set aside for income tax in the Kyros vault` : ''}${r.reference && !/^0+$/.test(r.reference) ? ` (ref ${r.reference.slice(0, 16)})` : ''}`,
        tx: r.txHash,
      });
      if (vat > 0n) out.push({ date, kind: 'vat-in', inAmount: vat, inCurrency: cur, description: 'VAT collected with the payment, held in the Kyros vault until paid', tx: r.txHash });
    } else if (r.kind === 'tax_paid' && r.amount !== undefined) {
      out.push({ date, kind: 'tax-out', outAmount: r.amount, outCurrency: cur, description: `Tax paid from the Kyros vault (${r.bucket === 'vat' ? 'VAT' : (r.bucket ?? 'tax')})`, tx: r.txHash });
    } else if (r.kind === 'converted' && r.amount !== undefined && r.amountOut !== undefined && r.toToken) {
      out.push({ date, kind: 'trade', outAmount: r.amount, outCurrency: cur, inAmount: r.amountOut, inCurrency: symbol(r.toToken), description: 'Tax reserve converted in the Kyros vault', tx: r.txHash });
    } else if (r.kind === 'harvested' && r.amount !== undefined && r.amount > 0n) {
      out.push({ date, kind: 'interest', inAmount: r.amount, inCurrency: cur, description: 'Yield on the tax reserve', tx: r.txHash });
    }
  }
  return out;
}

/**
 * The vault's events as a CSV the tax tool imports. `symbol` names a token
 * contract (e.g. `USDC`, `EURC`).
 */
export function taxToolCsv(tool: TaxTool, rows: VaultEventRow[], symbol: (token: string) => string): string {
  const ls = lines(rows, symbol);
  const opt = (x?: bigint) => (x === undefined ? '' : amt(x));
  if (tool === 'koinly') {
    const head = ['Date', 'Sent Amount', 'Sent Currency', 'Received Amount', 'Received Currency', 'Fee Amount', 'Fee Currency', 'Net Worth Amount', 'Net Worth Currency', 'Tag', 'Description', 'TxHash'];
    const tag: Record<Line['kind'], string> = { income: 'other income', 'vat-in': '', 'tax-out': '', trade: '', interest: 'lending interest' };
    const body = ls.map((l) => [l.date, opt(l.outAmount), l.outCurrency ?? '', opt(l.inAmount), l.inCurrency ?? '', '', '', '', '', tag[l.kind], l.description, l.tx].map(cell).join(','));
    return [head.join(','), ...body].join('\n') + '\n';
  }
  const head = ['Type', 'Buy Amount', 'Buy Currency', 'Sell Amount', 'Sell Currency', 'Fee', 'Fee Currency', 'Exchange', 'Trade-Group', 'Comment', 'Date', 'Tx-ID'];
  const type: Record<Line['kind'], string> = { income: 'Income', 'vat-in': 'Deposit', 'tax-out': 'Withdrawal', trade: 'Trade', interest: 'Interest Income' };
  const body = ls.map((l) => [type[l.kind], opt(l.inAmount), l.inCurrency ?? '', opt(l.outAmount), l.outCurrency ?? '', '', '', 'Kyros', '', l.description, l.date, l.tx].map(cell).join(','));
  return [head.join(','), ...body].join('\n') + '\n';
}
