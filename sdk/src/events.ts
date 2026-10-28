/**
 * Reading a vault's history from contract events, for the dashboard and the
 * accountant's CSV export. Nothing personal is onchain: rows carry
 * addresses, amounts, the period and the invoice-reference hash.
 */
import { nativeToScVal, rpc, scValToNative, xdr } from '@stellar/stellar-sdk';
import { formatAmount } from './split.js';

export interface VaultEventRow {
  ledger: number;
  closedAt: string;
  txHash: string;
  kind:
    | 'received'
    | 'tax_paid'
    | 'released'
    | 'rule_proposed'
    | 'destination_proposed'
    | 'rule_applied'
    | 'destination_applied'
    | 'change_cancelled'
    | 'converted'
    | 'invested'
    | 'harvested'
    | 'correction_applied'
    | 'strategy_proposed'
    | 'conversion_proposed'
    | 'correction_proposed'
    | 'strategy_stopped'
    | 'conversion_stopped'
    | 'deposited'
    | 'payout_proposed'
    | 'payout_applied'
    | 'fixed_proposed'
    | 'fixed_applied';
  token?: string;
  period?: number;
  gross?: bigint;
  net?: bigint;
  vat?: bigint;
  parts?: bigint[];
  /** Taken from the net amount for the period's fixed amounts. */
  fixed?: bigint;
  reserve?: bigint;
  amount?: bigint;
  bucket?: string;
  from?: string;
  reference?: string;
  /** Anchor memo (muxed id) of a tax payment. */
  memo?: bigint;
  /** A conversion: what went in (`amount`, in `token`) and what came out (`amountOut`, in `toToken`). */
  amountOut?: bigint;
  toToken?: string;
  /** A proposed change: when it applies (UNIX seconds). */
  readyAt?: bigint;
  /** A proposed tax destination. */
  destination?: string;
  /** A proposed or applied payout address. */
  payout?: string;
  /** A proposed rule: its VAT and its reserve (sum of the buckets), bps. */
  rule?: { vatBps: number; reserveBps: number };
  /** A proposed yield adapter or swapper. */
  adapter?: string;
  /** A proposed correction's id. */
  id?: number;
}

const KINDS = new Set([
  'received',
  'tax_paid',
  'released',
  'rule_proposed',
  'destination_proposed',
  'rule_applied',
  'destination_applied',
  'change_cancelled',
  'converted',
  'invested',
  'harvested',
  'correction_applied',
  'strategy_proposed',
  'conversion_proposed',
  'correction_proposed',
  'strategy_stopped',
  'conversion_stopped',
  'deposited',
  'payout_proposed',
  'payout_applied',
  'fixed_proposed',
  'fixed_applied',
]);

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
      const kind = topics[1] as VaultEventRow['kind'];
      if (kind === 'correction_applied') {
        rows.push({ ledger: ev.ledger, closedAt: ev.ledgerClosedAt, txHash: ev.txHash, kind, amount: big(v.amount) });
        continue;
      }
      if (kind === 'payout_applied' || kind === 'fixed_applied') {
        rows.push({ ledger: ev.ledger, closedAt: ev.ledgerClosedAt, txHash: ev.txHash, kind, payout: v.payout !== undefined ? String(v.payout) : undefined });
        continue;
      }
      if (kind === 'rule_proposed' || kind === 'destination_proposed' || kind === 'strategy_proposed' || kind === 'conversion_proposed' || kind === 'correction_proposed' || kind === 'payout_proposed' || kind === 'fixed_proposed') {
        const rule = v.rule as { vat_bps: number; buckets: { bps: number }[] } | undefined;
        const c = v.correction as { period: number; token: string; bucket: string; amount: bigint; ready_at: bigint } | undefined;
        const st = (v.strategy ?? v.conversion) as { adapter?: string; swapper?: string } | undefined;
        rows.push({
          ledger: ev.ledger,
          closedAt: ev.ledgerClosedAt,
          txHash: ev.txHash,
          kind,
          readyAt: big(v.ready_at ?? c?.ready_at),
          destination: v.destination !== undefined ? String(v.destination) : undefined,
          payout: v.payout !== undefined ? String(v.payout) : undefined,
          rule: rule ? { vatBps: Number(rule.vat_bps), reserveBps: rule.buckets.reduce((a, b) => a + Number(b.bps), 0) } : undefined,
          adapter: st ? String(st.adapter ?? st.swapper) : undefined,
          id: kind === 'correction_proposed' ? Number(topics[2]) : undefined,
          period: c ? Number(c.period) : undefined,
          token: c ? String(c.token) : undefined,
          bucket: c ? String(c.bucket) : undefined,
          amount: c ? BigInt(c.amount) : undefined,
        });
        continue;
      }
      if (kind === 'converted') {
        rows.push({
          ledger: ev.ledger,
          closedAt: ev.ledgerClosedAt,
          txHash: ev.txHash,
          kind,
          period: Number(topics[2]),
          token: String(v.from_token),
          amount: big(v.amount_in),
          toToken: String(v.to_token),
          amountOut: big(v.amount_out),
        });
        continue;
      }
      rows.push({
        ledger: ev.ledger,
        closedAt: ev.ledgerClosedAt,
        txHash: ev.txHash,
        kind,
        token: topics[2] !== undefined ? String(topics[2]) : undefined,
        period: topics[3] !== undefined ? Number(topics[3]) : undefined,
        gross: big(v.gross),
        net: big(v.net),
        vat: big(v.vat),
        parts: Array.isArray(v.parts) ? (v.parts as bigint[]).map((p) => BigInt(p)) : undefined,
        fixed: big(v.fixed),
        reserve: big(v.reserve),
        amount: big(v.amount),
        bucket: v.bucket !== undefined ? String(v.bucket) : undefined,
        from: v.from !== undefined ? String(v.from) : undefined,
        reference: v.reference instanceof Uint8Array ? Buffer.from(v.reference).toString('hex') : undefined,
        memo: v.memo !== undefined && v.memo !== null ? BigInt(v.memo as bigint) : undefined,
      });
    }
    if (res.events.length < 200 || !res.cursor) break;
    cursor = res.cursor;
  }
  return rows;
}

/** An inbox's proposal to pay into another vault, and whether it was cancelled. */
export interface InboxMove {
  ledger: number;
  closedAt: string;
  txHash: string;
  kind: 'move_proposed' | 'move_cancelled';
  vault?: string;
  readyAt?: bigint;
}

/** The inbox's move proposals and cancellations from `startLedger` on. */
export async function inboxMoves(server: rpc.Server, inbox: string, startLedger: number): Promise<InboxMove[]> {
  const res = await server.getEvents({ filters: [{ type: 'contract' as const, contractIds: [inbox] }], startLedger, limit: 200 } as rpc.Server.GetEventsRequest);
  const out: InboxMove[] = [];
  for (const ev of res.events) {
    const t = ev.topic.map((x: xdr.ScVal) => scValToNative(x));
    if (t[0] !== 'kyros_inbox' || (t[1] !== 'move_proposed' && t[1] !== 'move_cancelled')) continue;
    const v = (scValToNative(ev.value) ?? {}) as { vault?: string; ready_at?: bigint };
    out.push({ ledger: ev.ledger, closedAt: ev.ledgerClosedAt, txHash: ev.txHash, kind: t[1], vault: v.vault ? String(v.vault) : undefined, readyAt: v.ready_at !== undefined ? BigInt(v.ready_at) : undefined });
  }
  return out;
}

/** A token transfer into an address (who paid an inbox, and how much). */
export interface Transfer {
  /** The event's id: stable, to remember which transfers were handled. */
  id: string;
  ledger: number;
  closedAt: string;
  txHash: string;
  token: string;
  from: string;
  amount: bigint;
}

/**
 * Transfers of `tokens` into `to` from `startLedger` on: who paid a payment
 * address. The chain does not say where a payer is; this only tells wallets apart.
 */
export async function transfersInto(server: rpc.Server, tokens: string[], to: string, startLedger: number): Promise<Transfer[]> {
  const sym = xdr.ScVal.scvSymbol('transfer').toXDR('base64');
  const dest = nativeToScVal(to, { type: 'address' }).toXDR('base64');
  // Stellar asset contracts add the asset as a fourth topic; other tokens may not.
  const topics = [
    [sym, '*', dest, '*'],
    [sym, '*', dest],
  ];
  const rows: Transfer[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const filters = [{ type: 'contract' as const, contractIds: tokens, topics }];
    const req = cursor ? { filters, cursor, limit: 200 } : { filters, startLedger, limit: 200 };
    const res = await server.getEvents(req as rpc.Server.GetEventsRequest);
    for (const ev of res.events) {
      const t = ev.topic.map((x: xdr.ScVal) => scValToNative(x));
      if (t[0] !== 'transfer' || String(t[2]) !== to) continue;
      const v = scValToNative(ev.value) as unknown;
      const amount = typeof v === 'object' && v !== null && 'amount' in (v as object) ? BigInt((v as { amount: bigint }).amount) : BigInt(v as bigint);
      rows.push({ id: ev.id, ledger: ev.ledger, closedAt: ev.ledgerClosedAt, txHash: ev.txHash, token: String(ev.contractId), from: String(t[1]), amount });
    }
    if (res.events.length < 200 || !res.cursor) break;
    cursor = res.cursor;
  }
  return rows;
}

const csvCell = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/** One CSV line per event, amounts in whole units, with a link to each transaction. */
export function toCsv(rows: VaultEventRow[], explorerTx = (h: string) => `https://stellar.expert/explorer/public/tx/${h}`): string {
  const head = ['closed_at', 'kind', 'period', 'token', 'gross', 'net', 'vat', 'other_reserve', 'amount', 'bucket', 'reference', 'to_token', 'amount_out', 'memo', 'tx'];
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
      r.parts ? f(r.parts.reduce((a, b) => a + b, r.fixed ?? 0n)) : '',
      f(r.amount),
      r.bucket ?? '',
      r.reference ?? '',
      r.toToken ?? '',
      f(r.amountOut),
      r.memo?.toString() ?? '',
      explorerTx(r.txHash),
    ]
      .map(csvCell)
      .join(','),
  );
  return [head.join(','), ...lines].join('\n') + '\n';
}
