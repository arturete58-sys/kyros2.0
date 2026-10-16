/**
 * The split arithmetic, line for line the same as `kyros_types::split` in the
 * contracts, so an app can show the exact amounts before anything is signed.
 * Amounts are bigint in the token's smallest unit (7 decimals for USDC/EURC on Stellar).
 */

export const BPS = 10_000n;

export interface Bucket {
  /** Bucket name as stored onchain (a Soroban symbol, e.g. `irpf`). */
  name: string;
  /** Share of the taxable base, in basis points (2000 = 20%). */
  bps: number;
}

export interface Rule {
  /** VAT included in the gross amount, in basis points (2100 = 21%). */
  vatBps: number;
  buckets: Bucket[];
}

export interface Split {
  gross: bigint;
  base: bigint;
  vat: bigint;
  /** One per rule bucket, in order. */
  parts: bigint[];
  /** vat + sum(parts) */
  reserve: bigint;
  /** gross - reserve: what the user can spend at once. */
  net: bigint;
}

export class RuleError extends Error {}

/** Same checks as the contract: VAT <= 100%, <= 8 buckets, distinct names, none called `vat`, buckets <= 100% of the base. */
export function validateRule(rule: Rule): void {
  if (!Number.isInteger(rule.vatBps) || rule.vatBps < 0 || rule.vatBps > 10_000) throw new RuleError('VAT must be 0..10000 bps');
  if (rule.buckets.length > 8) throw new RuleError('at most 8 buckets');
  const seen = new Set<string>();
  let total = 0;
  for (const b of rule.buckets) {
    if (b.name === 'vat') throw new RuleError('`vat` is reserved');
    if (!/^[a-zA-Z0-9_]{1,32}$/.test(b.name)) throw new RuleError(`invalid bucket name ${b.name}`);
    if (seen.has(b.name)) throw new RuleError(`duplicate bucket ${b.name}`);
    if (!Number.isInteger(b.bps) || b.bps < 0) throw new RuleError(`invalid bps for ${b.name}`);
    seen.add(b.name);
    total += b.bps;
  }
  if (total > 10_000) throw new RuleError('buckets take more than the whole base');
}

/**
 * base = floor(gross * 10000 / (10000 + vat_bps)); vat = gross - base;
 * part_i = floor(base * bps_i / 10000); net = gross - vat - sum(part_i).
 */
export function split(rule: Rule, gross: bigint): Split {
  const base = (gross * BPS) / (BPS + BigInt(rule.vatBps));
  const vat = gross - base;
  const parts = rule.buckets.map((b) => (base * BigInt(b.bps)) / BPS);
  const reserve = parts.reduce((a, p) => a + p, vat);
  return { gross, base, vat, parts, reserve, net: gross - reserve };
}

/** Formats a 7-decimal amount: 12100000000n -> "1210". */
export function formatAmount(units: bigint, decimals = 7): string {
  const neg = units < 0n;
  const v = neg ? -units : units;
  const s = v.toString().padStart(decimals + 1, '0');
  const whole = s.slice(0, -decimals);
  const frac = s.slice(-decimals).replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

/** Parses "1210.5" into 7-decimal units. */
export function parseAmount(text: string, decimals = 7): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(text.trim());
  if (!m) throw new Error(`not an amount: ${text}`);
  const frac = (m[2] ?? '').padEnd(decimals, '0');
  if (frac.length > decimals) throw new Error(`more than ${decimals} decimals: ${text}`);
  return BigInt(m[1]) * 10n ** BigInt(decimals) + BigInt(frac || '0');
}
