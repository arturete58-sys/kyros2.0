/**
 * The tokens, oracles and protocols Kyros works with, per network.
 *
 * Every address here was checked against its publisher (see the comments);
 * check them again before a mainnet deployment, since issuers and
 * deployments can change.
 */
import { Asset, Networks, StrKey } from '@stellar/stellar-sdk';

export type Network = 'mainnet' | 'testnet';

export const PASSPHRASE: Record<Network, string> = {
  mainnet: Networks.PUBLIC,
  testnet: Networks.TESTNET,
};

/**
 * Circle's stablecoins on Stellar (classic assets; their Stellar Asset
 * Contract is the token a vault accepts).
 * EURC: developers.circle.com/stablecoins/eurc-contract-addresses.
 * USDC: developers.circle.com/stablecoins/usdc-contract-addresses.
 */
export const STABLECOINS: Record<Network, Record<'USDC' | 'EURC', { code: string; issuer: string }>> = {
  mainnet: {
    USDC: { code: 'USDC', issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN' },
    EURC: { code: 'EURC', issuer: 'GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP2' },
  },
  testnet: {
    USDC: { code: 'USDC', issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5' },
    EURC: { code: 'EURC', issuer: 'GB3Q6QDZYTHWT7E5PVS3W7FUT5GVAFC5KSZFFLPU25GO7VTC3NM2ZTVO' },
  },
};

/** The token contract (Stellar Asset Contract) of a stablecoin. */
export function stablecoinContract(network: Network, code: 'USDC' | 'EURC'): string {
  const s = STABLECOINS[network][code];
  return new Asset(s.code, s.issuer).contractId(PASSPHRASE[network]);
}

/**
 * Reflector's SEP-40 oracles (developers.stellar.org/docs/data/oracles/oracle-providers).
 * `fiat` prices currencies in USD with 14 decimals: `Other(EUR)` is the
 * dollar price of a euro and `Other(USD)` is the base (1).
 */
export const REFLECTOR: Record<Network, { stellarDex: string; external: string; fiat: string }> = {
  mainnet: {
    stellarDex: 'CALI2BYU2JE6WVRUFYTS6MSBNEHGJ35P4AVCZYF3B6QOE3QKOB2PLE6M',
    external: 'CAFJZQWSED6YAWZU3GWRTOCNPPCGBN32L7QV43XX5LZLFTK6JLN34DLN',
    fiat: 'CBKGPWGKSKZF52CFHMTRR23TBWTPMRDIYZ4O2P5VS65BMHYH4DXMCJZC',
  },
  testnet: {
    stellarDex: 'CAVLP5DH2GJPZMVO7IJY4CVOD5MWEFTJFVPD2YY2FQXOQHRGHK4D6HLP',
    external: 'CCYOZJCOPG34LLQQ7N24YXBM7LL62R7ONMZ3G6WZAAYPB5OYKOMJRN63',
    fiat: 'CCSSOHTBL3LEWUCBBEB5NJFC2OKFRC74OWEIJIZLRJBGAAU4VMU5NV4W',
  },
};

/**
 * Soroswap's router (repo soroswap/core, `public/*.contracts.json`). The
 * mainnet router's wasm hash, 4c3db3eb…, is the bytecode the Kyros swapper
 * is tested against (contracts/vendor/soroswap).
 */
export const SOROSWAP_ROUTER: Record<Network, string> = {
  mainnet: 'CAG5LRYQ5JVEUI5TEID72EYOVX44TTUJT5BQR2J6J77FH65PCCFAJDDH',
  testnet: 'CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD',
};

/** A SEP-40 asset name, as the vault's `Conversion` stores it. */
export type OracleAsset = { stellar: string } | { other: string };

/** Throws if any built-in address is malformed (a typo would fail its checksum). */
export function checkBuiltInAddresses(): void {
  for (const n of ['mainnet', 'testnet'] as Network[]) {
    for (const s of Object.values(STABLECOINS[n])) {
      if (!StrKey.isValidEd25519PublicKey(s.issuer)) throw new Error(`bad ${s.code} issuer on ${n}`);
    }
    for (const c of [...Object.values(REFLECTOR[n]), SOROSWAP_ROUTER[n]]) {
      if (!StrKey.isValidContract(c)) throw new Error(`bad contract id ${c} on ${n}`);
    }
  }
}
