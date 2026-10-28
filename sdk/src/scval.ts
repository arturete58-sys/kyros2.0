/** ScVal encoding of the contract types (Soroban `#[contracttype]`: structs are maps with sorted symbol keys, enums are vectors). */
import { Address, nativeToScVal, scValToNative, xdr } from '@stellar/stellar-sdk';
import type { Due, Dues, PeriodKind } from './periods.js';
import type { Fixed, Rule, Split } from './split.js';

const sym = (s: string) => xdr.ScVal.scvSymbol(s);

function struct(fields: Record<string, xdr.ScVal>): xdr.ScVal {
  return xdr.ScVal.scvMap(
    Object.keys(fields)
      .sort()
      .map((k) => new xdr.ScMapEntry({ key: sym(k), val: fields[k] })),
  );
}

export const u32 = (n: number) => xdr.ScVal.scvU32(n);
export const u64 = (n: bigint | number) => nativeToScVal(BigInt(n), { type: 'u64' });
export const i128 = (n: bigint) => nativeToScVal(n, { type: 'i128' });
export const addr = (a: string) => new Address(a).toScVal();
export const bytes32 = (b: Uint8Array) => {
  if (b.length !== 32) throw new Error('expected 32 bytes');
  return xdr.ScVal.scvBytes(Buffer.from(b));
};

/** A SEP-40 asset: `{ other: 'EUR' }` or `{ stellar: 'C...' }`. */
export function oracleAssetToScVal(a: { stellar: string } | { other: string }): xdr.ScVal {
  return 'stellar' in a ? xdr.ScVal.scvVec([sym('Stellar'), addr(a.stellar)]) : xdr.ScVal.scvVec([sym('Other'), sym(a.other)]);
}

export function oracleAssetFromNative(v: unknown): { stellar: string } | { other: string } {
  const a = v as unknown[];
  return String(a[0]) === 'Stellar' ? { stellar: String(a[1]) } : { other: String(a[1]) };
}

/** The vault's `Conversion`: how reserve in `fromToken` becomes `toToken`. */
export interface Conversion {
  fromToken: string;
  toToken: string;
  swapper: string;
  oracle: string;
  fromPrice: { stellar: string } | { other: string };
  toPrice: { stellar: string } | { other: string };
  maxSlippageBps: number;
  maxAgeSecs: bigint;
}

export function conversionToScVal(c: Conversion): xdr.ScVal {
  return struct({
    from_token: addr(c.fromToken),
    to_token: addr(c.toToken),
    swapper: addr(c.swapper),
    oracle: addr(c.oracle),
    from_price: oracleAssetToScVal(c.fromPrice),
    to_price: oracleAssetToScVal(c.toPrice),
    max_slippage_bps: u32(c.maxSlippageBps),
    max_age_secs: u64(c.maxAgeSecs),
  });
}

export function conversionFromNative(n: Record<string, unknown>): Conversion {
  return {
    fromToken: String(n.from_token),
    toToken: String(n.to_token),
    swapper: String(n.swapper),
    oracle: String(n.oracle),
    fromPrice: oracleAssetFromNative(n.from_price),
    toPrice: oracleAssetFromNative(n.to_price),
    maxSlippageBps: Number(n.max_slippage_bps),
    maxAgeSecs: BigInt(n.max_age_secs as bigint),
  };
}

export function ruleToScVal(rule: Rule): xdr.ScVal {
  return struct({
    vat_bps: u32(rule.vatBps),
    buckets: xdr.ScVal.scvVec(rule.buckets.map((b) => struct({ name: sym(b.name), bps: u32(b.bps) }))),
  });
}

/** The vault's `InvoiceTerms`. */
export function invoiceTermsToScVal(t: { vatBps: number; withholdingBps: number; buckets: Rule['buckets'] }): xdr.ScVal {
  return struct({
    vat_bps: u32(t.vatBps),
    withholding_bps: u32(t.withholdingBps),
    buckets: xdr.ScVal.scvVec(t.buckets.map((b) => struct({ name: sym(b.name), bps: u32(b.bps) }))),
  });
}

export function periodKindToScVal(p: PeriodKind): xdr.ScVal {
  if (p.kind === 'Seconds') return xdr.ScVal.scvVec([sym('Seconds'), u64(p.seconds)]);
  if (p.kind === 'Months') return xdr.ScVal.scvVec([sym('Months'), u32(p.months)]);
  return xdr.ScVal.scvVec([sym(p.kind)]);
}

/** A `kyros_types::Due`. */
export function dueToScVal(d: Due): xdr.ScVal {
  if ('after' in d) return xdr.ScVal.scvVec([sym('After'), u64(d.after)]);
  if ('monthDay' in d) {
    const m = d.monthDay;
    return xdr.ScVal.scvVec([
      sym('MonthDay'),
      struct({ months: u32(m.months), day: u32(m.day), exception_month: u32(m.exceptionMonth), exception_months: u32(m.exceptionMonths), exception_day: u32(m.exceptionDay) }),
    ]);
  }
  const y = d.yearDate;
  return xdr.ScVal.scvVec([
    sym('YearDate'),
    struct({ fy_start_month: u32(y.fyStartMonth), fy_start_day: u32(y.fyStartDay), month: u32(y.month), day: u32(y.day), years_after: u32(y.yearsAfter) }),
  ]);
}

/** The vault's `Dues`: a map keyed by bucket symbol, sorted as the host requires. */
export function duesToScVal(d: Dues): xdr.ScVal {
  const entries = Object.keys(d.buckets)
    .sort()
    .map((k) => new xdr.ScMapEntry({ key: sym(k), val: dueToScVal(d.buckets[k]) }));
  return struct({
    default: dueToScVal(d.default),
    buckets: xdr.ScVal.scvMap(entries),
    closed: u32(d.closed),
    holidays: d.holidays ? xdr.ScVal.scvVec([sym('Registry'), struct({ registry: addr(d.holidays.registry), country: sym(d.holidays.country) })]) : xdr.ScVal.scvVec([sym('None')]),
  });
}

export function dueFromNative(v: unknown): Due {
  const a = v as unknown[];
  const tag = String(a[0]);
  const n = (x: unknown) => Number(x as number);
  if (tag === 'After') return { after: BigInt(a[1] as bigint) };
  const f = a[1] as Record<string, unknown>;
  if (tag === 'MonthDay') return { monthDay: { months: n(f.months), day: n(f.day), exceptionMonth: n(f.exception_month), exceptionMonths: n(f.exception_months), exceptionDay: n(f.exception_day) } };
  if (tag === 'YearDate') return { yearDate: { fyStartMonth: n(f.fy_start_month), fyStartDay: n(f.fy_start_day), month: n(f.month), day: n(f.day), yearsAfter: n(f.years_after) } };
  throw new Error(`unknown due rule ${tag}`);
}

export function duesFromNative(v: unknown): Dues {
  const o = v as { default: unknown; buckets: Record<string, unknown> | Map<string, unknown>; closed?: number; holidays?: unknown[] };
  const entries = o.buckets instanceof Map ? [...o.buckets.entries()] : Object.entries(o.buckets ?? {});
  const h = o.holidays;
  const src = h && String(h[0]) === 'Registry' ? (h[1] as { registry: string; country: string }) : null;
  return {
    default: dueFromNative(o.default),
    buckets: Object.fromEntries(entries.map(([k, x]) => [String(k), dueFromNative(x)])),
    closed: Number(o.closed ?? 0),
    holidays: src ? { registry: String(src.registry), country: String(src.country) } : null,
  };
}

/** One item of a scheduled payment (`Payment`). */
export interface ScheduledItem {
  period: number;
  token: string;
  bucket: string;
  amount: bigint;
}

export function scheduledItemsToScVal(items: ScheduledItem[]): xdr.ScVal {
  return xdr.ScVal.scvVec(items.map((p) => struct({ period: u32(p.period), token: addr(p.token), bucket: sym(p.bucket), amount: i128(p.amount) })));
}

export function splitFromScVal(v: xdr.ScVal): Split {
  const n = scValToNative(v) as Record<string, unknown>;
  const big = (x: unknown) => BigInt(x as bigint | number | string);
  return {
    gross: big(n.gross),
    base: big(n.base),
    vat: big(n.vat),
    parts: (n.parts as unknown[]).map(big),
    fixed: big(n.fixed ?? 0),
    reserve: big(n.reserve),
    net: big(n.net),
  };
}

export function fixedToScVal(fixed: Fixed[]): xdr.ScVal {
  return xdr.ScVal.scvVec(fixed.map((f) => struct({ bucket: sym(f.bucket), token: addr(f.token), amount: i128(f.amount) })));
}

export function fixedFromNative(v: unknown): Fixed[] {
  return ((v ?? []) as { bucket: string; token: string; amount: bigint }[]).map((f) => ({ bucket: String(f.bucket), token: String(f.token), amount: BigInt(f.amount) }));
}

export function ruleFromNative(n: Record<string, unknown>): Rule {
  return {
    vatBps: Number(n.vat_bps),
    buckets: (n.buckets as { name: string; bps: number }[]).map((b) => ({ name: String(b.name), bps: Number(b.bps) })),
  };
}

export function periodKindFromNative(v: unknown): PeriodKind {
  const a = v as unknown[];
  const tag = String(a[0]);
  if (tag === 'Seconds') return { kind: 'Seconds', seconds: BigInt(a[1] as bigint) };
  if (tag === 'Months') return { kind: 'Months', months: Number(a[1]) };
  if (tag === 'Month' || tag === 'Quarter' || tag === 'Year') return { kind: tag };
  throw new Error(`unknown period kind ${tag}`);
}

/** One payment of a Router batch (`pay_many`). */
export interface Payout {
  vault: string;
  amount: bigint;
  reference: Uint8Array;
}

export function payoutsToScVal(ps: Payout[]): xdr.ScVal {
  return xdr.ScVal.scvVec(ps.map((p) => struct({ vault: addr(p.vault), gross: i128(p.amount), reference: bytes32(p.reference) })));
}
