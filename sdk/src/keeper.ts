/**
 * The Kyros keeper: watches inboxes and calls `sweep` when money arrives,
 * and runs the vaults' scheduled tax payments when their date comes
 * (`run_scheduled`, which only pays the vault's tax destination).
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
  /** The vault behind the inbox, for the follow-up calls below. */
  vault?: string;
  /** After a sweep, swap the period's reserve into the reserve currency (`convert`). */
  convert?: boolean;
  /** After a sweep, move reserve into the yield strategy up to its share (`invest`). */
  invest?: boolean;
}

export interface SweepResult {
  inbox: string;
  token: string;
  gross: bigint;
  hash?: string;
  error?: string;
  /** Follow-up calls after the sweep, each with its transaction or error. */
  followUps?: { call: 'convert' | 'invest'; hash?: string; error?: string }[];
}

export interface ScheduledResult {
  vault: string;
  id: number;
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
    /** Vaults whose scheduled payments this keeper runs. */
    readonly vaults: string[] = [],
    readonly onScheduled: (r: ScheduledResult) => void = () => {},
  ) {}

  /** Runs every scheduled payment of the watched vaults whose date has come. */
  async runDue(now = BigInt(Math.floor(Date.now() / 1000))): Promise<ScheduledResult[]> {
    const out: ScheduledResult[] = [];
    for (const vault of this.vaults) {
      let due: { id: number }[] = [];
      try {
        due = (await this.client.scheduledPayments(vault)).filter((s) => s.at <= now);
      } catch (e) {
        out.push({ vault, id: 0, error: (e as Error).message });
        continue;
      }
      for (const s of due) {
        try {
          out.push({ vault, id: s.id, hash: (await this.client.send(this.key, this.client.runScheduledOp(vault, s.id))).hash });
        } catch (e) {
          out.push({ vault, id: s.id, error: (e as Error).message });
        }
        this.onScheduled(out[out.length - 1]);
      }
    }
    return out;
  }

  /** Checks every watched inbox once and sweeps those holding money. */
  async tick(): Promise<SweepResult[]> {
    const out: SweepResult[] = [];
    for (const w of this.watched) {
      let gross = 0n;
      try {
        gross = await this.client.balance(w.token, w.inbox);
        if (gross < (w.min ?? 1n)) continue;
        const sent = await this.client.send(this.key, this.client.sweepOp(w.inbox, w.token));
        const r: SweepResult = { inbox: w.inbox, token: w.token, gross, hash: sent.hash };
        if (w.vault && (w.convert || w.invest)) r.followUps = await this.followUps(w);
        out.push(r);
      } catch (e) {
        out.push({ inbox: w.inbox, token: w.token, gross, error: (e as Error).message });
      }
      this.onSweep(out[out.length - 1]);
    }
    return out;
  }

  /** `convert` then `invest`, as asked. Both are permissionless and safe to retry. */
  private async followUps(w: Watched): Promise<NonNullable<SweepResult['followUps']>> {
    const done: NonNullable<SweepResult['followUps']> = [];
    const vault = w.vault!;
    if (w.convert) {
      try {
        const period = await this.client.currentPeriod(vault);
        done.push({ call: 'convert', hash: (await this.client.send(this.key, this.client.convertOp(vault, period))).hash });
      } catch (e) {
        done.push({ call: 'convert', error: (e as Error).message });
      }
    }
    if (w.invest) {
      try {
        done.push({ call: 'invest', hash: (await this.client.send(this.key, this.client.investOp(vault))).hash });
      } catch (e) {
        done.push({ call: 'invest', error: (e as Error).message });
      }
    }
    return done;
  }

  /** Runs until `stop()`, checking every `intervalMs` (default one ledger, 5 s). */
  async run(intervalMs = 5_000): Promise<void> {
    let n = 0;
    while (!this.stopped) {
      await this.tick();
      // Scheduled payments are checked about once a minute.
      if (this.vaults.length && n++ % Math.max(1, Math.round(60_000 / intervalMs)) === 0) await this.runDue();
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  stop(): void {
    this.stopped = true;
  }
}
