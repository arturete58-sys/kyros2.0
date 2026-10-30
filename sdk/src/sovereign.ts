/**
 * Public money on Stellar: central bank digital currencies (CBDCs) and other
 * money a state issues on the network (a government's digital dollar, a
 * digital sovereign bond paid out as a benefit).
 *
 * For Kyros it is one more Stellar asset: a vault accepts it (`propose_token`,
 * with notice), splits each payment in it, and pays the tax in it, to the tax
 * office's own Stellar account where the government takes payments on-chain,
 * with no anchor in between. What differs is the issuer's power over it:
 * public money usually needs the issuer's authorization to be held, and the
 * issuer can freeze it or take it back (clawback), also from a vault. This
 * module lists what exists and reads those controls, so the user sees them
 * before choosing it.
 */
import { Asset } from '@stellar/stellar-sdk';

export type SovereignKind = 'cbdc' | 'government-stablecoin' | 'sovereign-bond';
export type SovereignStatus = 'live' | 'announced' | 'pilot-ended';

export interface SovereignMoney {
  id: string;
  /** ISO country code. */
  country: string;
  name: string;
  kind: SovereignKind;
  status: SovereignStatus;
  /** Month it started (or was announced), YYYY-MM. */
  since: string;
  /** Its code and issuer on Stellar's public network, once published. */
  asset?: { code: string; issuer: string };
  /** What it is, in plain words. */
  summary: string;
  /** What Kyros does with it. */
  fit: string;
  /** What the tax office takes on-chain today, if anything. */
  taxPayments?: string[];
  sources: { title: string; url: string }[];
}

/** Public money on Stellar, as of the date in `SOVEREIGN_REVIEWED`. */
export const SOVEREIGN_MONEY: SovereignMoney[] = [
  {
    id: 'bermuda-digital-dollar',
    country: 'BM',
    name: 'Bermuda Digital Dollar',
    kind: 'government-stablecoin',
    status: 'announced',
    since: '2026-05',
    summary: 'A government-issued digital dollar on Stellar, backed by fiat deposits held by Bermuda’s banks, announced in 2026 as part of a plan for an on-chain economy. Not issued yet.',
    fit: 'Bermuda already takes tax payments in USDC. With the tax office’s Stellar account as the vault’s destination, the payroll tax goes to it directly, with no anchor. When the digital dollar is issued, the vault adds it as a currency and pays in it.',
    taxPayments: ['USDC'],
    sources: [
      { title: 'CoinDesk: Bermuda, the small island nation with huge crypto ambitions (May 2026)', url: 'https://www.coindesk.com/business/2026/05/26/bermuda-the-small-island-nation-with-huge-crypto-ambitions' },
      { title: 'Circle: Bermuda becomes the first national government to accept tax payments in USDC', url: 'https://www.circle.com/blog/bermuda-becomes-1st-national-government-to-accept-tax-payments-in-usdc-stablecoin' },
    ],
  },
  {
    id: 'usdm1',
    country: 'MH',
    name: 'USDM1',
    kind: 'sovereign-bond',
    status: 'live',
    since: '2025-11',
    summary: 'A digital sovereign bond of the Republic of the Marshall Islands, issued natively on Stellar and backed one to one by short-dated US Treasuries. The government pays its universal basic income (ENRA) in it, to the Lomalo wallet.',
    fit: 'A benefit is not a client’s payment: it goes to a wallet, not through a vault. If businesses come to be paid in USDM1, a vault adds it as a currency and splits those payments like any other.',
    sources: [
      { title: 'Stellar: first on-chain universal basic income, delivered in USDM1', url: 'https://stellar.org/press/world-s-first-on-chain-disbursement-of-universal-basic-income-delivered-on-the-stellar-network-via-digital-sovereign-bond-usdm1' },
      { title: 'Decrypt: Marshall Islands test crypto for universal basic income (December 2025)', url: 'https://decrypt.co/353079/marshall-islands-test-crypto-universal-basic-income-cash-banks-fall-short' },
    ],
  },
  {
    id: 'e-hryvnia',
    country: 'UA',
    name: 'e-hryvnia',
    kind: 'cbdc',
    status: 'pilot-ended',
    since: '2021-09',
    summary: 'A pilot of an electronic hryvnia issued by TASCOMBANK on Stellar with the Stellar Development Foundation and Bitt, under the National Bank of Ukraine’s oversight. It did not go beyond the pilot.',
    fit: 'If the National Bank issues it, a Ukrainian vault adds it as a currency.',
    sources: [
      { title: 'Decrypt: Ukraine’s central bank runs digital currency pilot using Stellar', url: 'https://decrypt.co/88221/ukraines-central-bank-runs-digital-currency-pilot-using-stellar' },
      { title: 'Cointelegraph: Ukrainian bank uses Stellar to launch electronic hryvnia pilot', url: 'https://cointelegraph.com/news/ukrainian-bank-uses-stellar-to-launch-electronic-hryvnia-pilot' },
    ],
  },
];

export const SOVEREIGN_REVIEWED = '2026-10-30';

/** The public money of a country on Stellar, if any. */
export function sovereignFor(country: string): SovereignMoney[] {
  return SOVEREIGN_MONEY.filter((m) => m.country === country.toUpperCase());
}

/** The asset's Stellar Asset Contract, the address a vault accepts. */
export function assetContract(code: string, issuer: string, networkPassphrase: string): string {
  return new Asset(code, issuer).contractId(networkPassphrase);
}

/** The issuer's flags on a Stellar asset (Horizon's `flags`). */
export interface IssuerFlags {
  authRequired: boolean;
  authRevocable: boolean;
  authClawback: boolean;
  authImmutable: boolean;
}

export type IssuerControl = 'authorization' | 'freeze' | 'clawback';

/** What the issuer can do with the asset in a vault, and what it means. */
export function issuerControls(f: IssuerFlags): IssuerControl[] {
  const out: IssuerControl[] = [];
  if (f.authRequired) out.push('authorization');
  if (f.authRevocable) out.push('freeze');
  if (f.authClawback) out.push('clawback');
  return out;
}

export interface HorizonAssetRecord {
  asset_code: string;
  asset_issuer: string;
  flags?: { auth_required?: boolean; auth_revocable?: boolean; auth_clawback_enabled?: boolean; auth_immutable?: boolean };
}

export function flagsFromHorizon(r: HorizonAssetRecord): IssuerFlags {
  return {
    authRequired: !!r.flags?.auth_required,
    authRevocable: !!r.flags?.auth_revocable,
    authClawback: !!r.flags?.auth_clawback_enabled,
    authImmutable: !!r.flags?.auth_immutable,
  };
}

/** Reads the issuer's flags from Horizon (`/assets`); null when the asset does not exist yet. */
export async function readIssuerFlags(horizon: string, code: string, issuer: string, f: typeof fetch = fetch): Promise<IssuerFlags | null> {
  const res = await f(`${horizon.replace(/\/$/, '')}/assets?asset_code=${encodeURIComponent(code)}&asset_issuer=${encodeURIComponent(issuer)}`);
  if (!res.ok) throw new Error(`Horizon: HTTP ${res.status}`);
  const j = (await res.json()) as { _embedded?: { records?: HorizonAssetRecord[] } };
  const r = j._embedded?.records?.[0];
  return r ? flagsFromHorizon(r) : null;
}

/**
 * The addresses that must be authorized by the issuer before they can hold
 * an asset that needs authorization: the vault (it keeps the reserve) and
 * every payment address (inboxes receive before they sweep). The net amount
 * goes to the owner's own wallet, which needs its own authorization too.
 */
export function holdersToAuthorize(o: { vault: string; owner: string; payout?: string; inboxes: string[] }): string[] {
  return [...new Set([o.vault, ...o.inboxes, o.payout ?? o.owner])];
}
