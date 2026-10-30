import type { xdr } from '@stellar/stellar-sdk';

/** The user's own wallet. Kyros never holds its keys. */
export interface Wallet {
  kind: 'passkey' | 'classic';
  /** G… (classic) or C… (passkey smart wallet). */
  address: string;
  /** Shown to the user: "Face ID" or the wallet's name. */
  label: string;
  /** Signs `op` as the owner and submits it. Returns the transaction hash. */
  signAndSend(op: xdr.Operation): Promise<string>;
  /** Classic accounts only: signs and submits classic operations (a trustline). */
  signClassic?(ops: xdr.Operation[]): Promise<string>;
  disconnect(): Promise<void>;
}
