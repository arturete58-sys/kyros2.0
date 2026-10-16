/**
 * Paying tax in euros through a Stellar anchor.
 *
 * The flow, for a vault whose tax destination is the anchor's account:
 *   1. `anchorInfo(domain)` reads the anchor's stellar.toml (SEP-1).
 *   2. `anchorAuth(...)` logs in with the owner's key (SEP-10) and returns a token.
 *   3. `startWithdrawal(...)` opens a euro withdrawal to the owner's bank
 *      account: SEP-24 (the anchor's web form, with its KYC) or SEP-6.
 *   4. Once the anchor says where to send the stablecoins, `anchorPayout`
 *      turns its account and memo into the muxed address `pay_tax_to` needs,
 *      and checks it is the vault's tax destination.
 *   5. The owner signs `payTaxToOp`; the anchor sends euros to the bank
 *      account, from which the tax authority collects the direct debit
 *      (in Spain, the domiciliación of modelos 303 and 130).
 *
 * The anchor is the regulated party (it holds the licence to exchange and
 * pay out); Kyros never receives the funds. The vault refuses any account
 * other than its tax destination, and changing the destination takes the
 * vault's notice, so a stolen key cannot redirect the reserve at once.
 *
 * Only id memos fit in a contract payment (as the muxed id); an anchor that
 * asks for a text or hash memo cannot be paid from the vault directly.
 * Smart-wallet (contract) owners log in with SEP-45 instead of SEP-10,
 * which this module does not cover yet.
 */
import { Account, Keypair, MuxedAccount, StellarToml, StrKey, TransactionBuilder, WebAuth } from '@stellar/stellar-sdk';

export interface AnchorInfo {
  homeDomain: string;
  signingKey: string;
  webAuthEndpoint: string;
  /** SEP-6 server, if offered. */
  transferServer?: string;
  /** SEP-24 server, if offered. */
  transferServerSep24?: string;
  /** SEP-38 quote server, if offered. */
  quoteServer?: string;
  networkPassphrase?: string;
  currencies: { code: string; issuer?: string }[];
}

export interface AnchorOptions {
  /** For a local test anchor only. */
  allowHttp?: boolean;
  fetch?: typeof fetch;
}

/** Reads the anchor's stellar.toml (SEP-1). */
export async function anchorInfo(homeDomain: string, o: AnchorOptions = {}): Promise<AnchorInfo> {
  const t = (await StellarToml.Resolver.resolve(homeDomain, { allowHttp: o.allowHttp })) as Record<string, unknown>;
  const need = (k: string) => {
    const v = t[k];
    if (typeof v !== 'string' || !v) throw new Error(`${homeDomain}: stellar.toml has no ${k}`);
    return v;
  };
  const opt = (k: string) => (typeof t[k] === 'string' && t[k] ? (t[k] as string) : undefined);
  return {
    homeDomain,
    signingKey: need('SIGNING_KEY'),
    webAuthEndpoint: need('WEB_AUTH_ENDPOINT'),
    transferServer: opt('TRANSFER_SERVER'),
    transferServerSep24: opt('TRANSFER_SERVER_SEP0024'),
    quoteServer: opt('ANCHOR_QUOTE_SERVER'),
    networkPassphrase: opt('NETWORK_PASSPHRASE'),
    currencies: ((t.CURRENCIES as { code?: string; issuer?: string }[] | undefined) ?? [])
      .filter((c) => c.code)
      .map((c) => ({ code: String(c.code), issuer: c.issuer })),
  };
}

async function json(f: typeof fetch, url: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const r = await f(url, init);
  const body = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (!r.ok) throw new Error(`${init?.method ?? 'GET'} ${url}: ${r.status} ${String(body.error ?? '')}`.trim());
  return body;
}

/**
 * SEP-10 login: fetches the anchor's challenge, checks it was built by the
 * anchor for this account and domain, signs it with `owner` and returns the
 * session token (a JWT).
 */
export async function anchorAuth(a: AnchorInfo, owner: Keypair, networkPassphrase: string, o: AnchorOptions = {}): Promise<string> {
  const f = o.fetch ?? fetch;
  const q = new URLSearchParams({ account: owner.publicKey(), home_domain: a.homeDomain });
  const ch = await json(f, `${a.webAuthEndpoint}?${q}`);
  const passphrase = String(ch.network_passphrase ?? networkPassphrase);
  if (passphrase !== networkPassphrase) throw new Error(`anchor challenge is for another network: ${passphrase}`);
  const webAuthDomain = new URL(a.webAuthEndpoint).host;
  // Throws unless the challenge is well formed, signed by the anchor's SIGNING_KEY, for this account and domain.
  WebAuth.readChallengeTx(String(ch.transaction), a.signingKey, passphrase, a.homeDomain, webAuthDomain);
  const tx = TransactionBuilder.fromXDR(String(ch.transaction), passphrase);
  tx.sign(owner);
  const res = await json(f, a.webAuthEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ transaction: tx.toXDR() }),
  });
  if (typeof res.token !== 'string') throw new Error('anchor returned no token');
  return res.token;
}

/** Where the anchor wants the stablecoins for a withdrawal. */
export interface WithdrawalTarget {
  /** The anchor's transaction id. */
  id: string;
  /** The account to pay, and the memo that identifies the withdrawal. */
  account: string;
  memo?: string;
  memoType?: 'id' | 'text' | 'hash';
  /** Amount the anchor expects, if it says. */
  amount?: string;
  /** SEP-24 only: the anchor's form the owner opens (KYC, bank account). */
  interactiveUrl?: string;
  status?: string;
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/**
 * Starts a withdrawal of `amount` of `assetCode` to the owner's bank account.
 * SEP-24 returns the anchor's form (the target comes later from
 * `withdrawalStatus`); SEP-6 returns the target at once.
 */
export async function startWithdrawal(
  a: AnchorInfo,
  token: string,
  w: { assetCode: string; account: string; amount?: string; lang?: string; sep?: 6 | 24; type?: string; dest?: string },
  o: AnchorOptions = {},
): Promise<WithdrawalTarget | { id: string; interactiveUrl: string }> {
  const f = o.fetch ?? fetch;
  const sep = w.sep ?? (a.transferServerSep24 ? 24 : 6);
  if (sep === 24) {
    if (!a.transferServerSep24) throw new Error(`${a.homeDomain} offers no SEP-24`);
    const body: Record<string, string> = { asset_code: w.assetCode, account: w.account, lang: w.lang ?? 'es' };
    if (w.amount) body.amount = w.amount;
    const r = await json(f, `${a.transferServerSep24}/transactions/withdraw/interactive`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...bearer(token) },
      body: JSON.stringify(body),
    });
    return { id: String(r.id), interactiveUrl: String(r.url) };
  }
  if (!a.transferServer) throw new Error(`${a.homeDomain} offers no SEP-6`);
  const q = new URLSearchParams({ asset_code: w.assetCode, account: w.account, type: w.type ?? 'bank_account' });
  if (w.amount) q.set('amount', w.amount);
  if (w.dest) q.set('dest', w.dest);
  const r = await json(f, `${a.transferServer}/withdraw?${q}`, { headers: bearer(token) });
  return {
    id: String(r.id ?? ''),
    account: String(r.account_id),
    memo: r.memo !== undefined ? String(r.memo) : undefined,
    memoType: r.memo_type as WithdrawalTarget['memoType'],
  };
}

/** Polls a SEP-24 withdrawal; once the owner finishes the form it carries the target. */
export async function withdrawalStatus(a: AnchorInfo, token: string, id: string, o: AnchorOptions = {}): Promise<WithdrawalTarget> {
  const f = o.fetch ?? fetch;
  const server = a.transferServerSep24 ?? a.transferServer;
  if (!server) throw new Error(`${a.homeDomain} has no transfer server`);
  const r = await json(f, `${server}/transaction?id=${encodeURIComponent(id)}`, { headers: bearer(token) });
  const t = (r.transaction ?? {}) as Record<string, unknown>;
  return {
    id,
    status: t.status !== undefined ? String(t.status) : undefined,
    account: String(t.withdraw_anchor_account ?? ''),
    memo: t.withdraw_memo !== undefined ? String(t.withdraw_memo) : undefined,
    memoType: t.withdraw_memo_type as WithdrawalTarget['memoType'],
    amount: t.amount_in !== undefined ? String(t.amount_in) : undefined,
  };
}

/**
 * The address the vault pays the anchor at: the anchor's account with the
 * memo as muxed id. Refuses a target that is not the vault's tax destination
 * (propose it first: it takes the vault's notice) and memos a contract
 * payment cannot carry.
 */
export function anchorPayout(t: WithdrawalTarget, taxDestination: string): string {
  if (!StrKey.isValidEd25519PublicKey(t.account)) throw new Error(`anchor account ${t.account} is not a Stellar account`);
  if (t.account !== taxDestination) {
    throw new Error(`the anchor wants payment at ${t.account} but the vault pays tax to ${taxDestination}: propose the anchor's account as tax destination first (it applies after the notice)`);
  }
  if (!t.memo || !t.memoType) return t.account;
  if (t.memoType !== 'id') throw new Error(`the anchor asks for a ${t.memoType} memo; a vault can only pay with an id memo (as a muxed address)`);
  return new MuxedAccount(new Account(t.account, '0'), t.memo).accountId();
}
