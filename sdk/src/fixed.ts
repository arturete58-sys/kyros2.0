/**
 * Fixed amounts per period: contributions that do not follow each payment but
 * fall due every month whatever the income (Spain's self-employed fee, the
 * RETA). The vault sets the period's amount aside from the first payments of
 * the period, before the net amount goes out.
 */
import { estimateFor, estimateTaxes } from './estimate.js';
import { monthsIn, type PeriodKind } from './periods.js';
import type { RulePack } from './rulepacks.js';
import type { Rule } from './split.js';

export interface FixedFeeSuggestion {
  /** The bucket the fee is set aside in. */
  bucket: string;
  /** The pack's estimate of the fee, per month, in the pack's currency. */
  monthly: number;
  /** What the estimate says it is. */
  label?: string;
  /** The vault's percentage reserve already counts these contributions. */
  inReserve: boolean;
  /** When it does: the rule without them, so the fee is not set aside twice. */
  proposal?: Rule;
}

/**
 * The monthly contributions the pack's estimate gives for this revenue, as a
 * fixed amount. Where the preset's reserve already covers contributions, the
 * reserve without them (the first bucket lowered by their share of revenue).
 */
export function fixedFeeSuggestion(pack: RulePack, presetId: string, rule: Rule, input: { revenue: number; activity?: string; region?: string }): FixedFeeSuggestion | undefined {
  const preset = pack.presets.find((p) => p.id === presetId);
  if (!preset) throw new Error(`no preset ${presetId} in ${pack.id}`);
  const est = estimateFor(pack, presetId, input.region);
  if (!est || input.revenue <= 0) return undefined;
  const r = estimateTaxes(est, { revenue: input.revenue, activity: input.activity, region: input.region });
  if (r.social <= 0) return undefined;
  const monthly = Math.round((r.social / 12) * 100) / 100;
  const label = r.lines.find((l) => l.kind === 'social')?.label;
  const inReserve = (preset.covers ?? ['incomeTax']).includes('social');
  const out: FixedFeeSuggestion = { bucket: 'social', monthly, label, inReserve };
  if (inReserve && rule.buckets.length) {
    const cut = Math.round((r.social / input.revenue) * 10_000);
    out.proposal = { vatBps: rule.vatBps, buckets: rule.buckets.map((b, i) => (i === 0 ? { ...b, bps: Math.max(0, b.bps - cut) } : { ...b })) };
  }
  return out;
}

/** A monthly amount as the vault's amount per period (token units, 7 decimals). */
export function fixedPerPeriod(monthly: number, kind: PeriodKind): bigint {
  return BigInt(Math.round(monthly * 100)) * BigInt(monthsIn(kind)) * 100_000n;
}
