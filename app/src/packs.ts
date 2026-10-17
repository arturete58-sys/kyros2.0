/** Rule packs bundled into the app (the same JSON the SDK and the contracts' docs use). */
import { checkRulePack, type RulePack } from 'kyros-sdk';

const files = import.meta.glob('../../rule-packs/[a-z][a-z].json', { import: 'default' }) as Record<string, () => Promise<unknown>>;

const names = new Intl.DisplayNames(['es'], { type: 'region' });

export interface CountryOption {
  id: string;
  country: string;
  name: string;
}

/** Every bundled country, sorted by its Spanish name. */
export function countries(): CountryOption[] {
  return Object.keys(files)
    .map((f) => /([a-z]{2})\.json$/.exec(f)![1])
    .map((id) => ({ id, country: id.toUpperCase(), name: names.of(id.toUpperCase()) ?? id.toUpperCase() }))
    .sort((a, b) => a.name.localeCompare(b.name, 'es'));
}

export async function loadPack(id: string): Promise<RulePack> {
  const load = files[`../../rule-packs/${id}.json`];
  if (!load) throw new Error(`no rule pack for ${id}`);
  const pack = (await load()) as RulePack;
  checkRulePack(pack);
  return pack;
}

export function countryName(code: string): string {
  return names.of(code) ?? code;
}
