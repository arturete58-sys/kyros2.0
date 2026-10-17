/** Rule packs bundled into the app (the same JSON the SDK and the contracts' docs use). */
import { checkRulePack, type HolidayData, type RulePack } from 'kyros-sdk';
import { getLang, locale } from './i18n';

const files = import.meta.glob('../../rule-packs/[a-z][a-z].json', { import: 'default' }) as Record<string, () => Promise<unknown>>;
const holidayFiles = import.meta.glob('../../rule-packs/holidays/[a-z][a-z].json', { import: 'default' }) as Record<string, () => Promise<unknown>>;

/** The public holidays generated for a pack (rule-packs/holidays), if any. */
export async function loadHolidays(id: string): Promise<HolidayData | undefined> {
  const load = holidayFiles[`../../rule-packs/holidays/${id}.json`];
  return load ? ((await load()) as HolidayData) : undefined;
}

const cache = new Map<string, Intl.DisplayNames>();
function names(): Intl.DisplayNames {
  const l = getLang();
  if (!cache.has(l)) cache.set(l, new Intl.DisplayNames([l], { type: 'region' }));
  return cache.get(l)!;
}

export interface CountryOption {
  id: string;
  country: string;
  name: string;
}

/** Every bundled country, named and sorted in the user's language. */
export function countries(): CountryOption[] {
  return Object.keys(files)
    .map((f) => /([a-z]{2})\.json$/.exec(f)![1])
    .map((id) => ({ id, country: id.toUpperCase(), name: names().of(id.toUpperCase()) ?? id.toUpperCase() }))
    .sort((a, b) => a.name.localeCompare(b.name, locale()));
}

export async function loadPack(id: string): Promise<RulePack> {
  const load = files[`../../rule-packs/${id}.json`];
  if (!load) throw new Error(`no rule pack for ${id}`);
  const pack = (await load()) as RulePack;
  checkRulePack(pack);
  return pack;
}

export function countryName(code: string): string {
  return names().of(code) ?? code;
}
