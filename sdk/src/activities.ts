/**
 * From "what do you do and who pays you" to a ready vault rule: the VAT the
 * country charges on that activity for that client, the regime preset, and the
 * reserve the check recommends (estimate plus the country's safety margin).
 *
 * The VAT treatment follows the common rules: in the EU, medical care and
 * recognised education are exempt (Directive 2006/112/EC, art. 132), services
 * to a business in another member state are reverse-charged (art. 196), and
 * services to clients outside the country are outside the scope or zero-rated
 * almost everywhere. Reduced rates for books and restaurant food come from each
 * pack's table. Where a country differs, the result says to check.
 */
import { checkReserve, type ReserveInput } from './estimate.js';
import { vatRatesOn, type RulePack, type RulePackPreset } from './rulepacks.js';
import { validateRule, type Rule } from './split.js';

export type ActivityId =
  | 'software'
  | 'consulting'
  | 'creative'
  | 'education'
  | 'health'
  | 'ecommerce'
  | 'books'
  | 'hospitality'
  | 'web3';

export const ACTIVITIES: Record<ActivityId, { label: string; profile: string }> = {
  software: { label: 'Software development and IT services', profile: 'software' },
  consulting: { label: 'Consulting and professional services', profile: 'consulting' },
  creative: { label: 'Design, content and creators', profile: 'creative' },
  education: { label: 'Recognised education and training', profile: 'education' },
  health: { label: 'Medical and health care', profile: 'other' },
  ecommerce: { label: 'Online sales of goods', profile: 'ecommerce' },
  books: { label: 'Books and e-books', profile: 'ecommerce' },
  hospitality: { label: 'Restaurants and food services', profile: 'hospitality' },
  web3: { label: 'Web3 services: smart contracts, audits, node operation', profile: 'software' },
};

/** Who pays: a consumer or a business at home, a business in another EU state, or a client in another country. */
export type ClientKind = 'consumer-local' | 'business-local' | 'business-eu' | 'abroad';

const EU = new Set(['AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'GR', 'ES', 'FI', 'FR', 'HR', 'HU', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK']);
/** Outside the EU, these also exempt medical care and recognised education. */
const EXEMPT_ELSEWHERE = new Set(['GB', 'CH', 'LI', 'AU', 'CA', 'NO', 'MC']);

/** The rate name a pack's table uses for books and for restaurant food, where it is reduced. */
const REDUCED: Record<string, { books?: string; hospitality?: string }> = {
  ES: { books: 'super_reduced', hospitality: 'reduced' },
  DE: { books: 'reduced', hospitality: 'reduced' },
  FR: { books: 'reduced', hospitality: 'intermediate' },
  IT: { books: 'super_reduced', hospitality: 'reduced' },
  NL: { books: 'reduced', hospitality: 'reduced' },
  PT: { books: 'reduced', hospitality: 'intermediate' },
  IE: { books: 'zero', hospitality: 'second_reduced' },
  LU: { books: 'super_reduced', hospitality: 'super_reduced' },
  CY: { books: 'reduced_5', hospitality: 'reduced' },
  MT: { books: 'reduced_5' },
  EE: { books: 'press' },
  GB: { books: 'zero' },
  CH: { books: 'reduced' },
  LI: { books: 'reduced' },
  MC: { books: 'reduced', hospitality: 'intermediate' },
};

export interface Setup {
  presetId: string;
  /** The VAT on this activity for this client: a rate name of the pack, or why there is none. */
  vat: { bps: number; rate?: string; treatment: 'standard' | 'reduced' | 'exempt' | 'reverse-charge' | 'outside-scope' | 'none' };
  /** The rule to put in the vault: that VAT plus the recommended reserve. */
  rule: Rule;
  /** Recommended reserve (estimate + safety margin), bps of the base. */
  reserveBps: number;
  precision: string;
  reasons: string[];
}

function pickPreset(pack: RulePack, wantVat: number, rate?: string): RulePackPreset {
  const withReserve = pack.presets.filter((p) => p.buckets.length > 0);
  const pool = withReserve.length ? withReserve : pack.presets;
  return (
    (rate && pool.find((p) => p.vatRate === rate)) ||
    pool.find((p) => p.vatBps === wantVat) ||
    pool.find((p) => p.vatRate === 'standard') ||
    pool[0]
  );
}

/**
 * Regimes the user picks rather than their VAT: a simplified regime that
 * charges no VAT and pays one fee or a share of revenue instead. The VAT and
 * the client alone never lead to them, so onboarding asks.
 */
export const REGIMES: Record<string, string[]> = {
  // Argentina: the monotributo replaces IVA, Ganancias and the autónomos contributions with one monthly fee by category.
  AR: ['monotributo'],
};

/** The regimes of `REGIMES` the pack has, with their preset labels. */
export function regimeChoices(pack: RulePack): { id: string; label: string }[] {
  return (REGIMES[pack.country] ?? []).flatMap((id) => {
    const p = pack.presets.find((x) => x.id === id);
    return p ? [{ id, label: p.label }] : [];
  });
}

/**
 * Suggests the vault setup for an activity and a client. `revenue` (annual, in
 * the pack's currency) sizes the reserve; `region` adds the regional income tax.
 * `presetId` picks a regime of `regimeChoices` (e.g. Argentina's monotributo):
 * no VAT is charged and its reserve is checked against that regime.
 */
export function suggestSetup(
  pack: RulePack,
  s: { activity: ActivityId; client: ClientKind; revenue?: number; expenses?: number; region?: string; date?: Date | string; presetId?: string },
): Setup {
  const date = s.date ?? new Date();
  const rates = vatRatesOn(pack, date);
  const reasons: string[] = [];
  const eu = EU.has(pack.country);
  const regime = s.presetId ? regimeChoices(pack).find((r) => r.id === s.presetId) : undefined;
  if (s.presetId && !regime) throw new Error(`${s.presetId} is not a regime of ${pack.id}`);
  let vat: Setup['vat'];
  if (regime) {
    vat = { bps: 0, treatment: 'none' };
    reasons.push(`${regime.label.split(':')[0]}: no ${pack.vatName ?? 'VAT'} is charged on the invoices in this regime.`);
  } else if (!pack.vatRates?.length || rates.standard === undefined) {
    vat = { bps: 0, treatment: 'none' };
    reasons.push(`${pack.vatName ?? 'VAT'}: none in this jurisdiction, or not charged by this pack.`);
  } else if (s.client === 'abroad') {
    vat = { bps: 0, treatment: 'outside-scope' };
    reasons.push('Client in another country: services are outside the scope of VAT or zero-rated here (goods sold to consumers abroad and EU digital services to consumers follow other rules).');
  } else if (s.client === 'business-eu' && eu) {
    vat = { bps: 0, treatment: 'reverse-charge' };
    reasons.push('Business client in another EU state: the client accounts for VAT (reverse charge); the invoice carries both VAT numbers.');
  } else if ((s.activity === 'health' || s.activity === 'education') && (eu || EXEMPT_ELSEWHERE.has(pack.country))) {
    vat = { bps: 0, treatment: 'exempt' };
    reasons.push(`${s.activity === 'health' ? 'Medical care' : 'Recognised education'} is exempt from ${pack.vatName ?? 'VAT'} here; input VAT on costs cannot be deducted.`);
  } else {
    const special = REDUCED[pack.country]?.[s.activity as 'books' | 'hospitality'];
    if (special === 'zero') {
      vat = { bps: 0, rate: 'zero', treatment: 'reduced' };
      reasons.push('Books are zero-rated here.');
    } else if ((s.activity === 'books' || s.activity === 'hospitality') && special && rates[special] !== undefined) {
      vat = { bps: rates[special], rate: special, treatment: 'reduced' };
      reasons.push(`${s.activity === 'books' ? 'Books' : 'Restaurant food'} take the reduced ${rates[special] / 100}% rate here.`);
    } else {
      vat = { bps: rates.standard, rate: 'standard', treatment: 'standard' };
      reasons.push(`Standard ${pack.vatName ?? 'VAT'} rate ${rates.standard / 100}%.`);
      if (s.activity === 'books' || s.activity === 'hospitality' || ((s.activity === 'health' || s.activity === 'education') && !eu)) {
        reasons.push('Some countries reduce or exempt this activity: check the pack notes.');
      }
    }
  }
  const preset = regime ? pack.presets.find((p) => p.id === regime.id)! : pickPreset(pack, vat.bps, vat.rate);
  reasons.push(`Regime: ${preset.label}.`);
  const revenue = s.revenue ?? 50_000;
  const input: ReserveInput = { revenue, expenses: s.expenses, activity: ACTIVITIES[s.activity].profile, region: s.region };
  const check = checkReserve(pack, preset.id, input);
  const presetReserve = preset.buckets.reduce((a, b) => a + b.bps, 0);
  const reserveBps = check.recommendedBps !== undefined ? check.recommendedBps : presetReserve;
  if (check.recommendedBps !== undefined) {
    reasons.push(`Reserve: ${(reserveBps / 100).toFixed(2)}% of each payment's base (${check.precision}${check.marginBps ? `, including a ${check.marginBps / 100}-point safety margin for a ${check.enforcement} country` : ''}), for about ${revenue.toLocaleString('en')} ${pack.currency} a year.`);
  } else {
    reasons.push(`Reserve: the preset's ${presetReserve / 100}% (no estimate for this jurisdiction).`);
  }
  if (pack.country === 'ES' && s.client === 'business-local' && ['software', 'consulting', 'creative', 'web3'].includes(s.activity)) {
    reasons.push('Spain: Spanish business clients usually withhold 15% IRPF (7% in the first years) from professional invoices; if 70% or more of your income is withheld, modelo 130 is not due and the reserve can be lower.');
  }
  // One reserve bucket, named as the preset's first one; VAT as decided above.
  const name = preset.buckets[0]?.name ?? 'income_tax';
  const rule: Rule = { vatBps: vat.bps, buckets: reserveBps > 0 ? [{ name, bps: Math.min(reserveBps, 10_000) }] : [] };
  validateRule(rule);
  return { presetId: preset.id, vat, rule, reserveBps, precision: check.precision, reasons };
}
