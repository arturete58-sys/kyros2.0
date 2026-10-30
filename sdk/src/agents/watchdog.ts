/**
 * Guardian agent: watches a vault (and its inbox) for changes that would
 * move money away from where the owner set it — a new tax destination, a
 * rule that stops setting tax aside, a yield adapter or swapper nobody
 * chose, a correction, the inbox paying into another vault — while they wait
 * out the vault's notice, and gives the owner the one operation that stops
 * each: `cancel`, `stop_strategy`, `stop_conversion`, `cancel_correction` or
 * the inbox's `cancel_move`, which the owner signs in their wallet.
 *
 * The notice is what makes this work: a stolen key can propose, but nothing
 * applies until the notice has passed, and the owner (who still has the
 * key) can cancel within it. Changes the owner made from their own device
 * are marked as theirs; anything else is flagged. Alerts can go to Telegram
 * or any webhook (email services take one) from the keeper.
 */
import type { xdr } from '@stellar/stellar-sdk';
import type { KyrosClient } from '../client.js';
import type { InboxMove, VaultEventRow } from '../events.js';

export type GuardKind = 'destination' | 'rule' | 'strategy' | 'conversion' | 'correction' | 'inbox-move' | 'payout' | 'fixed' | 'token';

export interface GuardAlert {
  kind: GuardKind;
  tx: string;
  at: string;
  /** When it applies if nobody stops it (UNIX seconds). */
  readyAt?: bigint;
  /** The new destination, adapter, swapper, vault, or the rule's reserve. */
  detail: string;
  severity: 'critical' | 'warning';
  /** The owner made it from this device. */
  mine: boolean;
  /** For a correction: its id. */
  id?: number;
}

const KIND: Partial<Record<VaultEventRow['kind'], GuardKind>> = {
  destination_proposed: 'destination',
  rule_proposed: 'rule',
  strategy_proposed: 'strategy',
  conversion_proposed: 'conversion',
  correction_proposed: 'correction',
  payout_proposed: 'payout',
  fixed_proposed: 'fixed',
  token_proposed: 'token',
};

/**
 * Pending proposals that have not applied yet and were not cancelled. `mine`
 * holds the transaction hashes of the owner's own proposals (the app keeps
 * them); `known` holds addresses the owner trusts (their tax destination,
 * the adapters and swappers they set up).
 */
export function guardAlerts(
  rows: VaultEventRow[],
  moves: InboxMove[],
  o: { now: bigint; mine?: Set<string>; known?: Set<string>; currentReserveBps?: number; openCorrections?: Set<number> },
): GuardAlert[] {
  const mine = o.mine ?? new Set<string>();
  const known = o.known ?? new Set<string>();
  const sorted = [...rows].sort((a, b) => a.ledger - b.ledger);
  const out: GuardAlert[] = [];
  for (const r of sorted) {
    const kind = KIND[r.kind];
    if (kind) {
      if (r.readyAt !== undefined && r.readyAt <= o.now) continue;
      // A later cancellation or stop clears it.
      const stops: Partial<Record<GuardKind, VaultEventRow['kind']>> = { destination: 'change_cancelled', rule: 'change_cancelled', payout: 'change_cancelled', fixed: 'change_cancelled', token: 'change_cancelled', strategy: 'strategy_stopped', conversion: 'conversion_stopped' };
      // A later cancellation, a stop, or a newer proposal of the same kind clears it.
      const cleared = sorted.some((x) => x.ledger > r.ledger && (x.kind === stops[kind] || x.kind === r.kind));
      if (cleared) continue;
      if (kind === 'correction' && o.openCorrections && !o.openCorrections.has(r.id ?? -1)) continue;
      const isMine = mine.has(r.txHash);
      let detail = '';
      let severity: GuardAlert['severity'] = 'critical';
      if (kind === 'destination') detail = r.destination ?? '';
      else if (kind === 'payout') detail = r.payout ?? '';
      else if (kind === 'fixed') severity = 'warning';
      else if (kind === 'token') {
        // A new currency only adds what the vault accepts; it moves nothing.
        detail = r.token ?? '';
        severity = 'warning';
      }
      else if (kind === 'rule') {
        detail = `${(r.rule?.reserveBps ?? 0) / 100}% reserve, ${(r.rule?.vatBps ?? 0) / 100}% VAT`;
        // A rule that keeps setting tax aside at about the same level is a routine change.
        if (r.rule && o.currentReserveBps !== undefined && r.rule.reserveBps >= o.currentReserveBps * 0.5) severity = 'warning';
      } else if (kind === 'strategy' || kind === 'conversion') {
        detail = r.adapter ?? '';
        if (r.adapter && known.has(r.adapter)) severity = 'warning';
      } else if (kind === 'correction') {
        detail = `${r.amount ?? 0n}`;
        severity = 'warning';
      }
      if (kind === 'destination' && r.destination && known.has(r.destination)) severity = 'warning';
      out.push({ kind, tx: r.txHash, at: r.closedAt, readyAt: r.readyAt, detail, severity: isMine ? 'warning' : severity, mine: isMine, id: r.id });
    }
  }
  const ms = [...moves].sort((a, b) => a.ledger - b.ledger);
  for (const m of ms) {
    if (m.kind !== 'move_proposed' || (m.readyAt !== undefined && m.readyAt <= o.now)) continue;
    if (ms.some((x) => x.ledger > m.ledger)) continue;
    const isMine = mine.has(m.txHash);
    out.push({ kind: 'inbox-move', tx: m.txHash, at: m.closedAt, readyAt: m.readyAt, detail: m.vault ?? '', severity: isMine ? 'warning' : 'critical', mine: isMine });
  }
  return out;
}

/** The owner's operation that stops a pending change. */
export function guardStopOp(client: KyrosClient, a: GuardAlert, vault: string, inbox?: string): xdr.Operation {
  switch (a.kind) {
    case 'destination':
    case 'rule':
    case 'payout':
    case 'fixed':
    case 'token':
      return client.cancelChangeOp(vault);
    case 'strategy':
      return client.stopStrategyOp(vault);
    case 'conversion':
      return client.stopConversionOp(vault);
    case 'correction':
      return client.cancelCorrectionOp(vault, a.id ?? 0);
    case 'inbox-move':
      if (!inbox) throw new Error('the inbox address is needed to cancel its move');
      return client.cancelMoveOp(inbox);
  }
}

/** One line for a notification. */
export function guardMessage(a: GuardAlert, vault: string, appUrl?: string): string {
  const when = a.readyAt ? new Date(Number(a.readyAt) * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : 'soon';
  const what: Record<GuardKind, string> = {
    destination: `a new tax destination (${a.detail})`,
    rule: `a new rule (${a.detail})`,
    strategy: `a yield adapter (${a.detail})`,
    conversion: `a currency conversion through ${a.detail}`,
    correction: `a correction taking ${a.detail} units back`,
    payout: `a new address for your income (${a.detail})`,
    fixed: 'new fixed amounts set aside each period',
    token: `a new currency the vault accepts (${a.detail})`,
    'inbox-move': `the payment address moving to vault ${a.detail}`,
  };
  return `Kyros vault ${vault.slice(0, 6)}…: ${what[a.kind]} applies on ${when}. If it was not you, open Kyros and cancel it before then.${appUrl ? ` ${appUrl}` : ''}`;
}

/** Sends a message through a Telegram bot the owner set up (token and chat from the owner). */
export async function notifyTelegram(token: string, chatId: string, text: string, f: typeof fetch = fetch): Promise<void> {
  const r = await f(`https://api.telegram.org/bot${token}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, text }) });
  if (!r.ok) throw new Error(`telegram: HTTP ${r.status}`);
}

/** Posts the alert as JSON to a webhook (an email service, a chat, a pager). */
export async function notifyWebhook(url: string, payload: unknown, f: typeof fetch = fetch): Promise<void> {
  const r = await f(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload, (_, v) => (typeof v === 'bigint' ? v.toString() : v)) });
  if (!r.ok) throw new Error(`webhook: HTTP ${r.status}`);
}
