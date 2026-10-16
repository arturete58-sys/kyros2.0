import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PeriodKind } from './periods.js';
import { type Rule, validateRule } from './split.js';

export interface RulePackPreset {
  id: string;
  label: string;
  vatBps: number;
  buckets: { name: string; bps: number; label?: string }[];
  /** Overrides the pack's period for this preset. */
  period?: 'Month' | 'Quarter' | 'Year';
  /** Overrides the pack's due offset for this preset. */
  dueOffsetDays?: number;
}

export interface RulePack {
  id: string;
  country: string;
  name: string;
  version: string;
  /** ISO 4217 code of the local currency the taxes are paid in. */
  currency: string;
  period: 'Month' | 'Quarter' | 'Year';
  dueOffsetDays: number;
  dueNote?: string;
  presets: RulePackPreset[];
  notes?: string[];
  sources?: { title: string; url: string }[];
}

/** What a vault needs from a pack: its rule, period kind and due-date offset. */
export interface VaultTerms {
  rule: Rule;
  period: PeriodKind;
  dueOffsetSecs: bigint;
}

function packDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const d of [join(here, '..', 'rule-packs'), join(here, '..', '..', 'rule-packs'), join(here, '..', '..', '..', 'rule-packs')]) {
    if (existsSync(join(d, 'es.json'))) return d;
  }
  throw new Error('rule-packs directory not found');
}

/** Ids of the bundled rule packs (`ad`, `ae`, `ch`, `de`, `es`, ...). */
export function listRulePacks(): string[] {
  return readdirSync(packDir())
    .filter((f) => f.endsWith('.json') && f !== 'schema.json')
    .map((f) => f.slice(0, -5))
    .sort();
}

/** Loads a bundled rule pack by id (`es`), or any pack file by path. */
export function loadRulePack(idOrPath: string): RulePack {
  const file = idOrPath.endsWith('.json') ? idOrPath : join(packDir(), `${idOrPath}.json`);
  const pack = JSON.parse(readFileSync(file, 'utf8')) as RulePack;
  checkRulePack(pack);
  return pack;
}

export function checkRulePack(pack: RulePack): void {
  if (!pack.id || !pack.country || !Array.isArray(pack.presets) || pack.presets.length === 0) throw new Error('incomplete rule pack');
  const periods = ['Month', 'Quarter', 'Year'];
  if (!periods.includes(pack.period)) throw new Error(`unknown period ${pack.period}`);
  if (!/^[A-Z]{3}$/.test(pack.currency ?? '')) throw new Error(`${pack.id}: currency must be an ISO 4217 code`);
  const ids = new Set<string>();
  for (const p of pack.presets) {
    if (ids.has(p.id)) throw new Error(`${pack.id}: duplicate preset ${p.id}`);
    ids.add(p.id);
    if (p.period && !periods.includes(p.period)) throw new Error(`${pack.id}/${p.id}: unknown period ${p.period}`);
    validateRule({ vatBps: p.vatBps, buckets: p.buckets.map(({ name, bps }) => ({ name, bps })) });
  }
}

/** The vault terms for one preset of a pack. */
export function termsFromPack(pack: RulePack, presetId: string): VaultTerms {
  const p = pack.presets.find((x) => x.id === presetId);
  if (!p) throw new Error(`no preset ${presetId} in ${pack.id}; have ${pack.presets.map((x) => x.id).join(', ')}`);
  return {
    rule: { vatBps: p.vatBps, buckets: p.buckets.map(({ name, bps }) => ({ name, bps })) },
    period: { kind: p.period ?? pack.period },
    dueOffsetSecs: BigInt(p.dueOffsetDays ?? pack.dueOffsetDays) * 86_400n,
  };
}
