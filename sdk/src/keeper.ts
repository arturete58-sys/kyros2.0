/**
 * The Kyros keeper: watches inboxes and calls `sweep` when money arrives.
 * It holds no user funds and no user keys; its key only pays network fees.
 * `sweep` is permissionless, so anyone can run a keeper, and if every keeper
 * stops the money waits safely in the inbox.
 */
import type { Keypair } from '@stellar/stellar-sdk';
import { KyrosClient } from './client.js';

export interface Watched {
  inbox: string;
  token: string;
  /** Ignore balances below this (default 1 unit = 0.0000001). */
  min?: bigint;
}

export interface SweepResult {
  inbox: string;
  token: string;
  gross: bigint;
  hash?: string;
  error?: string;
}

export class Keeper {
  private stopped = false;
  constructor(
    readonly client: KyrosClient,
    readonly key: Keypair,
    readonly watched: Watched[],
    readonly onSweep: (r: SweepResult) => void = () => {},
  ) {}

  /** Checks every watched inbox once and sweeps those holding money. */
  async tick(): Promise<SweepResult[]> {
    const out: SweepResult[] = [];
    for (const w of this.watched) {
      let gross = 0n;
      try {
        gross = await this.client.balance(w.token, w.inbox);
        if (gross < (w.min ?? 1n)) continue;
        const sent = await this.client.send(this.key, this.client.sweepOp(w.inbox, w.token));
        out.push({ inbox: w.inbox, token: w.token, gross, hash: sent.hash });
      } catch (e) {
        out.push({ inbox: w.inbox, token: w.token, gross, error: (e as Error).message });
      }
      this.onSweep(out[out.length - 1]);
    }
    return out;
  }

  /** Runs until `stop()`, checking every `intervalMs` (default one ledger, 5 s). */
  async run(intervalMs = 5_000): Promise<void> {
    while (!this.stopped) {
      await this.tick();
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  stop(): void {
    this.stopped = true;
  }
}
