/**
 * SEP-7 transaction links. An invoice link carries the prepared Router
 * payment; any SEP-7 wallet opens it, shows it and asks the payer to sign.
 * https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0007.md
 */
import type { Transaction } from '@stellar/stellar-sdk';

export interface Sep7Options {
  /** Shown to the payer by the wallet (max 300 characters). */
  msg?: string;
  /** Where the wallet posts the signed transaction instead of submitting it ("url:https://..."). */
  callback?: string;
  networkPassphrase?: string;
  /** Domain that signs the request (SEP-7 origin_domain). */
  originDomain?: string;
}

export function sep7TxUri(tx: Transaction | string, o: Sep7Options = {}): string {
  const xdr = typeof tx === 'string' ? tx : tx.toXDR();
  const q = new URLSearchParams({ xdr });
  if (o.msg) {
    if (o.msg.length > 300) throw new Error('SEP-7 msg is limited to 300 characters');
    q.set('msg', o.msg);
  }
  if (o.callback) q.set('callback', o.callback.startsWith('url:') ? o.callback : `url:${o.callback}`);
  if (o.networkPassphrase) q.set('network_passphrase', o.networkPassphrase);
  if (o.originDomain) q.set('origin_domain', o.originDomain);
  return `web+stellar:tx?${q.toString()}`;
}
