/** ScVal encoding of the contract types (Soroban `#[contracttype]`: structs are maps with sorted symbol keys, enums are vectors). */
import { Address, nativeToScVal, scValToNative, xdr } from '@stellar/stellar-sdk';
import type { PeriodKind } from './periods.js';
import type { Rule, Split } from './split.js';

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

export function ruleToScVal(rule: Rule): xdr.ScVal {
  return struct({
    vat_bps: u32(rule.vatBps),
    buckets: xdr.ScVal.scvVec(rule.buckets.map((b) => struct({ name: sym(b.name), bps: u32(b.bps) }))),
  });
}

export function periodKindToScVal(p: PeriodKind): xdr.ScVal {
  return p.kind === 'Seconds' ? xdr.ScVal.scvVec([sym('Seconds'), u64(p.seconds)]) : xdr.ScVal.scvVec([sym(p.kind)]);
}

export function splitFromScVal(v: xdr.ScVal): Split {
  const n = scValToNative(v) as Record<string, unknown>;
  const big = (x: unknown) => BigInt(x as bigint | number | string);
  return {
    gross: big(n.gross),
    base: big(n.base),
    vat: big(n.vat),
    parts: (n.parts as unknown[]).map(big),
    reserve: big(n.reserve),
    net: big(n.net),
  };
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
  if (tag === 'Month' || tag === 'Quarter' || tag === 'Year') return { kind: tag };
  throw new Error(`unknown period kind ${tag}`);
}
