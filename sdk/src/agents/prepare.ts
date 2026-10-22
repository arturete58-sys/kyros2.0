/**
 * Transactions prepared for someone else to sign: each operation in its own
 * transaction from `source`, simulated (fees and resources set), with
 * consecutive sequence numbers so they can be signed and sent in order.
 * Nothing is signed or sent here.
 */
import { TransactionBuilder, type xdr } from '@stellar/stellar-sdk';
import type { KyrosClient } from '../client.js';

export async function prepareSequence(client: KyrosClient, source: string, ops: { what: string; op: xdr.Operation }[], timeoutSecs = 3600): Promise<{ what: string; xdr: string }[]> {
  const account = await client.server.getAccount(source);
  const out: { what: string; xdr: string }[] = [];
  for (const s of ops) {
    // Building increments the account's sequence, so each transaction takes the next number.
    const tx = new TransactionBuilder(account, { fee: client.o.fee ?? '100', networkPassphrase: client.o.networkPassphrase }).addOperation(s.op).setTimeout(timeoutSecs).build();
    out.push({ what: s.what, xdr: (await client.server.prepareTransaction(tx)).toXDR() });
  }
  return out;
}
