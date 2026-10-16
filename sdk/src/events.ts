/**
 * Reading a vault's history from contract events, for the dashboard and the
 * accountant's CSV export. Nothing personal is onchain: rows carry
 * addresses, amounts, the period and the invoice-reference hash.
 */
import { rpc, scValToNative, xdr } from '@stellar/stellar-sdk';
import { formatAmount } from './split.js';

export interface VaultEventRow {
  ledger: number;
  closedAt: string;
  txHash: string;
  kind: 'received' | 'tax_paid' | 'released' | 'rule_proposed' | 'destination_proposed' | 'rule_applied' | 'destination_applied' | 'change_cancelled';
  token?: string;
  period?: number;
  gross?: bigint;
  net?: bigint;
  vat?: bigint;
  parts?: bigint[];
  reserve?: bigint;
  amount?: bigint;
  bucket?: string;
  from?: string;
  reference?: string;
}

const KINDS = new Set(['received', 'tax_paid', 'released', 'rule_proposed', 'destination_proposed', 'rule_applied', 'destination_applied', 'change_cancelled']);

/** Every Kyros event of `vault` from `startLedger` on (RPC keeps a limited window of history). */
export async function vaultEvents(server: rpc.Server, vault: string, startLedger: number): Promise<VaultEventRow[]> {
  const rows: VaultEventRow[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 50; page++) {
    const req = cursor
      ? { filters: [{ type: 'contract' as const, contractIds: [vault] }], cursor, limit: 200 }
      : { filters: [{ type: 'contract' as const, contractIds: [vault] }], startLedger, limit: 200 };
    const res = await server.getEvents(req as rpc.Server.GetEventsRequest);
    for (const ev of res.events) {
      const topics = ev.topic.map((t: xdr.ScVal) => scValToNative(t));
      if (topics[0] !== 'kyros_vault' || !KINDS.has(String(topics[1]))) continue;
      const v = scValToNative(ev.value) as Record<string, unknown>;
      const big = (x: unknown) => (x === undefined ? undefined : BigInt(x as bigint));
      rows.push({
        ledger: ev.ledger,
        closedAt: ev.ledgerClosedAt,
        txHash: ev.txHash,
        kind: topics[1] as VaultEventRow['kind'],
        token: topics[2] !== undefined ? String(topics[2]) : undefined,
        period: topics[3] !== undefined ? Number(topics[3]) : undefined,
        gross: big(v.gross),
        net: big(v.net),
        vat: big(v.vat),
        parts: Array.isArray(v.parts) ? (v.parts as bigint[]).map((p) => BigInt(p)) : undefined,
        reserve: big(v.reserve),
        amount: big(v.amount),
        bucket: v.bucket !== undefined ? String(v.bucket) : undefined,
        from: v.from !== undefined ? String(v.from) : undefined,
        reference: v.reference instanceof Uint8Array ? Buffer.from(v.reference).toString('hex') : undefined,
      });
    }
    if (res.events.length < 200 || !res.cursor) break;
    cursor = res.cursor;
  }
  return rows;
}

const csvCell = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/** One CSV line per event, amounts in whole units, with a link to each transaction. */
export function toCsv(rows: VaultEventRow[], explorerTx = (h: string) => `https://stellar.expert/explorer/public/tx/${h}`): string {
  const head = ['closed_at', 'kind', 'period', 'token', 'gross', 'net', 'vat', 'other_reserve', 'amount', 'bucket', 'reference', 'tx'];
  const f = (x?: bigint) => (x === undefined ? '' : formatAmount(x));
  const lines = rows.map((r) =>
    [
      r.closedAt,
      r.kind,
      r.period?.toString() ?? '',
      r.token ?? '',
      f(r.gross),
      f(r.net),
      f(r.vat),
      r.parts ? f(r.parts.reduce((a, b) => a + b, 0n)) : '',
      f(r.amount),
      r.bucket ?? '',
      r.reference ?? '',
      explorerTx(r.txHash),
    ]
      .map(csvCell)
      .join(','),
  );
  return [head.join(','), ...lines].join('\n') + '\n';
}
