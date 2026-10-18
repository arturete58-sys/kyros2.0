/** Errors the user can read: contract, wallet and network failures in plain words, in their language. */
import { t, type Key } from './i18n';

/** Reserve Vault error codes with a message of their own (the rest get the generic one). */
const VAULT = new Set([2, 3, 4, 5, 6, 8, 15, 18, 19, 20, 24, 25, 26, 30, 31, 32, 33]);

export function friendlyError(e: unknown): string {
  const m = e instanceof Error ? `${e.name} ${e.message}` : String(e);
  if (/NotAllowedError|AbortError|cancel+ed|rejected|denied|User declined/i.test(m)) return t('err_cancelled');
  if (/balance is not sufficient|insufficient balance|txInsufficientBalance|underfunded|resulting balance is not within/i.test(m)) return t('err_balance');
  if (/Failed to fetch|NetworkError|timed? ?out|ECONNRESET|ERR_NETWORK|Load failed|503|502/i.test(m)) return t('err_network');
  const c = /Error\(Contract, #(\d+)\)/.exec(m);
  if (c && VAULT.has(Number(c[1]))) return t(`err_c${c[1]}` as Key);
  // Messages the app itself writes (already translated) pass through.
  if (!/Error\(|HostError|simulation|XDR|TypeError|undefined|\bat\b.*\(/.test(m)) return e instanceof Error ? e.message : m;
  return t('err_generic');
}
