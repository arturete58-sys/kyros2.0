/**
 * Getting paid from another chain through Circle's CCTP V2.
 *
 * A client with USDC on Ethereum, Base, Arbitrum, OP or Avalanche pays a
 * Kyros vault without holding anything on Stellar:
 *
 *   1. On the source chain the client's own wallet (MetaMask, Rabby,
 *      Coinbase Wallet, Phantom…) approves USDC and calls
 *      `depositForBurnWithHook`, naming the Kyros CCTP receiver as
 *      `mintRecipient` and `destinationCaller`, and the vault and invoice
 *      reference in the hook data (`burnCalls`).
 *   2. Circle attests the burn (`fetchAttestation`).
 *   3. Anyone submits `mintAndPayOp` on Stellar: the receiver mints the USDC
 *      and pays it into the vault with the reference, in one transaction.
 *
 * The vault and reference are fixed by the burn the client signed, so the
 * relayer only pays the Stellar fee. Amounts on the CCTP side have 6
 * decimals; Stellar USDC has 7, and CCTP mints `amount * 10`.
 *
 * Addresses: developers.circle.com/cctp/references/contract-addresses,
 * .../cctp/references/stellar-contracts and
 * .../stablecoins/usdc-contract-addresses. Only testnets are listed; check
 * Circle's pages again before adding mainnets.
 */
import { Contract, StrKey, xdr } from '@stellar/stellar-sdk';
import type { Network } from './assets.js';

/** CCTP's domain for Stellar. */
export const STELLAR_DOMAIN = 27;

/** Circle's CCTP contracts on Stellar. */
export const STELLAR_CCTP: Record<Network, { tokenMessengerMinter: string; messageTransmitter: string; forwarder: string }> = {
  mainnet: {
    tokenMessengerMinter: 'CAE2G5Z77UP7GYPYGFOWFGW7C7J6I4YP2AFGSADRKQY62SYUFLPNFTXL',
    messageTransmitter: 'CACMENFFJPJMSDAJQLX4R7K3SFZIW2LJSE3R2UMLGSWHFHS353FVXAZV',
    forwarder: 'CBZL2IH7F6BIDAA3WBNXYKIXSATJGMSW7K5P5MJ6STX5RXN47TZJDF5T',
  },
  testnet: {
    tokenMessengerMinter: 'CDNG7HXAPBWICI2E3AUBP3YZWZELJLYSB6F5CC7WLDTLTHVM74SLRTHP',
    messageTransmitter: 'CBJ6MTCKKZG73PMDZCJMSFRD7DQEMI4FKDH7CGDSV4W6FHCRBCQAVVJY',
    forwarder: 'CA66Q2WFBND6V4UEB7RD4SAXSVIWMD6RA4X3U32ELVFGXV5PJK4T4VSZ',
  },
};

/** Circle's attestation service. */
export const IRIS: Record<Network, string> = {
  mainnet: 'https://iris-api.circle.com',
  testnet: 'https://iris-api-sandbox.circle.com',
};

export interface EvmChain {
  id: string;
  name: string;
  /** EIP-155 chain id. */
  chainId: number;
  /** CCTP domain. */
  domain: number;
  usdc: `0x${string}`;
  tokenMessenger: `0x${string}`;
  rpcUrl: string;
  explorer: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
}

/** CCTP V2's TokenMessengerV2 has the same address on every EVM testnet. */
const TOKEN_MESSENGER_V2_TESTNET = '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA';
const ETH = { name: 'Ether', symbol: 'ETH', decimals: 18 };

/** EVM testnets a client can pay from. */
export const EVM_TESTNETS: EvmChain[] = [
  { id: 'base-sepolia', name: 'Base Sepolia', chainId: 84532, domain: 6, usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', tokenMessenger: TOKEN_MESSENGER_V2_TESTNET, rpcUrl: 'https://sepolia.base.org', explorer: 'https://sepolia.basescan.org', nativeCurrency: ETH },
  { id: 'ethereum-sepolia', name: 'Ethereum Sepolia', chainId: 11155111, domain: 0, usdc: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238', tokenMessenger: TOKEN_MESSENGER_V2_TESTNET, rpcUrl: 'https://ethereum-sepolia-rpc.publicnode.com', explorer: 'https://sepolia.etherscan.io', nativeCurrency: ETH },
  { id: 'arbitrum-sepolia', name: 'Arbitrum Sepolia', chainId: 421614, domain: 3, usdc: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d', tokenMessenger: TOKEN_MESSENGER_V2_TESTNET, rpcUrl: 'https://sepolia-rollup.arbitrum.io/rpc', explorer: 'https://sepolia.arbiscan.io', nativeCurrency: ETH },
  { id: 'op-sepolia', name: 'OP Sepolia', chainId: 11155420, domain: 2, usdc: '0x5fd84259d66Cd46123540766Be93DFE6D43130D7', tokenMessenger: TOKEN_MESSENGER_V2_TESTNET, rpcUrl: 'https://sepolia.optimism.io', explorer: 'https://sepolia-optimism.etherscan.io', nativeCurrency: ETH },
  { id: 'avalanche-fuji', name: 'Avalanche Fuji', chainId: 43113, domain: 1, usdc: '0x5425890298aed601595a70AB815c96711a31Bc65', tokenMessenger: TOKEN_MESSENGER_V2_TESTNET, rpcUrl: 'https://api.avax-test.network/ext/bc/C/rpc', explorer: 'https://testnet.snowtrace.io', nativeCurrency: { name: 'Avalanche', symbol: 'AVAX', decimals: 18 } },
];

// ---- bytes ----

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

export function fromHex(h: string): Uint8Array {
  const s = h.startsWith('0x') ? h.slice(2) : h;
  if (s.length % 2 || /[^0-9a-f]/i.test(s)) throw new Error(`not hex: ${h.slice(0, 20)}`);
  return Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16));
}

/** A Stellar contract (C…) as the 32 bytes CCTP uses. */
export function contractBytes32(contractId: string): Uint8Array {
  if (!StrKey.isValidContract(contractId)) throw new Error(`${contractId} is not a contract address`);
  return new Uint8Array(StrKey.decodeContract(contractId));
}

/** The hook data the Kyros CCTP receiver reads: the vault and the invoice reference. */
export function kyrosHookData(vault: string, reference: Uint8Array = new Uint8Array(32)): Uint8Array {
  if (reference.length !== 32) throw new Error('the reference has 32 bytes');
  const h = new Uint8Array(96);
  const v = new DataView(h.buffer);
  v.setUint32(24, 1); // Kyros hook version
  v.setUint32(28, 64); // vault + reference
  h.set(contractBytes32(vault), 32);
  h.set(reference, 64);
  return h;
}

// ---- EVM calls (ABI-encoded by hand: only static words and one bytes argument) ----

const word = (x: bigint) => {
  if (x < 0n || x >= 1n << 256n) throw new Error('out of range for uint256');
  return x.toString(16).padStart(64, '0');
};
const addressWord = (a: string) => {
  if (!/^0x[0-9a-fA-F]{40}$/.test(a)) throw new Error(`not an EVM address: ${a}`);
  return a.slice(2).toLowerCase().padStart(64, '0');
};

export const SELECTORS = {
  approve: '0x095ea7b3',
  allowance: '0xdd62ed3e',
  balanceOf: '0x70a08231',
  depositForBurnWithHook: '0x779b432d',
} as const;

export const approveData = (spender: string, amount: bigint) => `${SELECTORS.approve}${addressWord(spender)}${word(amount)}` as `0x${string}`;
export const allowanceData = (owner: string, spender: string) => `${SELECTORS.allowance}${addressWord(owner)}${addressWord(spender)}` as `0x${string}`;
export const balanceOfData = (owner: string) => `${SELECTORS.balanceOf}${addressWord(owner)}` as `0x${string}`;

export interface Burn {
  /** Amount to burn, 6 decimals. */
  amount: bigint;
  destinationDomain: number;
  mintRecipient: Uint8Array;
  burnToken: string;
  destinationCaller: Uint8Array;
  /** Most the client lets Circle keep, 6 decimals. */
  maxFee: bigint;
  /** 1000 = fast (seconds, small fee), 2000 = standard (waits for finality, no fee). */
  minFinalityThreshold: number;
  hookData: Uint8Array;
}

export function depositForBurnWithHookData(b: Burn): `0x${string}` {
  if (b.mintRecipient.length !== 32 || b.destinationCaller.length !== 32) throw new Error('recipients have 32 bytes');
  const head = [
    word(b.amount),
    word(BigInt(b.destinationDomain)),
    hex(b.mintRecipient),
    addressWord(b.burnToken),
    hex(b.destinationCaller),
    word(b.maxFee),
    word(BigInt(b.minFinalityThreshold)),
    word(8n * 32n), // offset of the bytes argument: after the 8 head words
  ];
  const padded = hex(b.hookData).padEnd(Math.ceil(b.hookData.length / 32) * 64, '0');
  return `${SELECTORS.depositForBurnWithHook}${head.join('')}${word(BigInt(b.hookData.length))}${padded}` as `0x${string}`;
}

/** USDC with 7 decimals (Stellar) to 6 (CCTP), rounding up so the vault never gets less. */
export const toCctpUnits = (stellarUnits: bigint) => (stellarUnits + 9n) / 10n;

/**
 * What to burn so that `target` (6 decimals) arrives after Circle's fee of
 * `feeBps` basis points (may be fractional), and the fee cap that allows it.
 */
export function grossUp(target: bigint, feeBps: number): { amount: bigint; maxFee: bigint } {
  const ppm = BigInt(Math.ceil(feeBps * 100)); // fee in millionths
  if (ppm === 0n) return { amount: target, maxFee: 0n };
  const amount = (target * 1_000_000n + (1_000_000n - ppm) - 1n) / (1_000_000n - ppm);
  return { amount, maxFee: amount - target };
}

/**
 * The two transactions the client's EVM wallet sends to pay `amount`
 * (Stellar units, 7 decimals) into `vault` from `chain`.
 */
export function burnCalls(
  chain: EvmChain,
  p: { receiver: string; vault: string; reference?: Uint8Array; amount: bigint; feeBps: number; fast: boolean },
): { approve: { to: string; data: `0x${string}` }; burn: { to: string; data: `0x${string}` }; amount: bigint; maxFee: bigint } {
  const { amount, maxFee } = grossUp(toCctpUnits(p.amount), p.fast ? p.feeBps : 0);
  const receiver = contractBytes32(p.receiver);
  return {
    amount,
    maxFee,
    approve: { to: chain.usdc, data: approveData(chain.tokenMessenger, amount) },
    burn: {
      to: chain.tokenMessenger,
      data: depositForBurnWithHookData({
        amount,
        destinationDomain: STELLAR_DOMAIN,
        mintRecipient: receiver,
        burnToken: chain.usdc,
        destinationCaller: receiver,
        maxFee,
        minFinalityThreshold: p.fast ? 1000 : 2000,
        hookData: kyrosHookData(p.vault, p.reference),
      }),
    },
  };
}

// ---- Circle's attestation service ----

/** The fast-transfer fee from `sourceDomain` to Stellar, in basis points (0 if unknown). */
export async function fastFeeBps(network: Network, sourceDomain: number, f: typeof fetch = fetch): Promise<number> {
  try {
    const r = await f(`${IRIS[network]}/v2/burn/USDC/fees/${sourceDomain}/${STELLAR_DOMAIN}`);
    if (!r.ok) return 1;
    const fees = (await r.json()) as { finalityThreshold: number; minimumFee: number }[];
    return fees.find((x) => x.finalityThreshold === 1000)?.minimumFee ?? 1;
  } catch {
    return 1;
  }
}

export interface Attested {
  message: string;
  attestation: string;
}

/** Waits until Circle attests the burn in `txHash`; returns the message and attestation (hex). */
export async function fetchAttestation(
  network: Network,
  sourceDomain: number,
  txHash: string,
  o: { fetch?: typeof fetch; everyMs?: number; timeoutMs?: number; onWait?: (status: string) => void } = {},
): Promise<Attested> {
  const f = o.fetch ?? fetch;
  const until = Date.now() + (o.timeoutMs ?? 45 * 60_000);
  const url = `${IRIS[network]}/v2/messages/${sourceDomain}?transactionHash=${txHash}`;
  for (;;) {
    try {
      const r = await f(url);
      if (r.ok) {
        const d = (await r.json()) as { messages?: { message: string; attestation: string; status: string }[] };
        const m = d.messages?.[0];
        if (m?.status === 'complete' && m.attestation && m.attestation !== 'PENDING') return { message: m.message, attestation: m.attestation };
        o.onWait?.(m?.status ?? 'pending');
      } else o.onWait?.(r.status === 404 ? 'not seen yet' : `HTTP ${r.status}`);
    } catch (e) {
      o.onWait?.((e as Error).message);
    }
    if (Date.now() > until) throw new Error(`no attestation for ${txHash} yet; it can still be relayed later`);
    await new Promise((res) => setTimeout(res, o.everyMs ?? 5000));
  }
}

/** The Stellar operation that mints an attested burn and pays it into its vault. Anyone can submit it. */
export function mintAndPayOp(receiver: string, a: Attested): xdr.Operation {
  return new Contract(receiver).call('mint_and_pay', xdr.ScVal.scvBytes(Buffer.from(fromHex(a.message))), xdr.ScVal.scvBytes(Buffer.from(fromHex(a.attestation))));
}
