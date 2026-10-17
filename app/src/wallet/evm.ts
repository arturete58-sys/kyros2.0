/**
 * Wallets from outside Stellar (MetaMask, Rabby, Coinbase Wallet, Phantom,
 * OKX, Brave…), for a client who pays from Ethereum, Base, Arbitrum, OP or
 * Avalanche. Found through EIP-6963 (every installed wallet announces
 * itself), with `window.ethereum` as a fallback. The wallet signs in its own
 * extension or app; Kyros only proposes the two transactions (approve, burn).
 */
import type { EvmChain } from 'kyros-sdk';

interface Eip1193 {
  request(a: { method: string; params?: unknown[] }): Promise<unknown>;
}

export interface EvmWalletInfo {
  id: string;
  name: string;
  icon?: string;
  provider: Eip1193;
}

/** The EVM wallets installed in this browser. */
export async function evmWallets(waitMs = 400): Promise<EvmWalletInfo[]> {
  const found = new Map<string, EvmWalletInfo>();
  const onAnnounce = (ev: Event) => {
    const d = (ev as CustomEvent<{ info: { uuid: string; name: string; icon: string; rdns: string }; provider: Eip1193 }>).detail;
    if (d?.info && d.provider) found.set(d.info.rdns || d.info.uuid, { id: d.info.rdns || d.info.uuid, name: d.info.name, icon: d.info.icon, provider: d.provider });
  };
  window.addEventListener('eip6963:announceProvider', onAnnounce);
  window.dispatchEvent(new Event('eip6963:requestProvider'));
  await new Promise((r) => setTimeout(r, waitMs));
  window.removeEventListener('eip6963:announceProvider', onAnnounce);
  const legacy = (window as unknown as { ethereum?: Eip1193 }).ethereum;
  if (found.size === 0 && legacy) found.set('injected', { id: 'injected', name: 'Browser wallet', provider: legacy });
  return [...found.values()];
}

export class EvmWallet {
  constructor(
    readonly info: EvmWalletInfo,
    readonly address: string,
  ) {}

  static async connect(info: EvmWalletInfo): Promise<EvmWallet> {
    const accounts = (await info.provider.request({ method: 'eth_requestAccounts' })) as string[];
    if (!accounts?.[0]) throw new Error('no account');
    return new EvmWallet(info, accounts[0]);
  }

  private get p() {
    return this.info.provider;
  }

  /** Moves the wallet to `chain`, adding the network if the wallet does not know it. */
  async useChain(chain: EvmChain): Promise<void> {
    const chainId = `0x${chain.chainId.toString(16)}`;
    try {
      await this.p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId }] });
    } catch (e) {
      if ((e as { code?: number }).code !== 4902) throw e;
      await this.p.request({
        method: 'wallet_addEthereumChain',
        params: [{ chainId, chainName: chain.name, nativeCurrency: chain.nativeCurrency, rpcUrls: [chain.rpcUrl], blockExplorerUrls: [chain.explorer] }],
      });
    }
  }

  async read(to: string, data: string): Promise<bigint> {
    const r = (await this.p.request({ method: 'eth_call', params: [{ to, data }, 'latest'] })) as string;
    return BigInt(r === '0x' ? 0 : r);
  }

  /** Sends a transaction and waits until it is mined; throws if it reverted. */
  async send(to: string, data: string): Promise<string> {
    const hash = (await this.p.request({ method: 'eth_sendTransaction', params: [{ from: this.address, to, data }] })) as string;
    for (let i = 0; i < 180; i++) {
      const r = (await this.p.request({ method: 'eth_getTransactionReceipt', params: [hash] })) as { status?: string } | null;
      if (r?.status === '0x1') return hash;
      if (r?.status === '0x0') throw new Error(`transaction ${hash.slice(0, 10)}… reverted`);
      await new Promise((res) => setTimeout(res, 2000));
    }
    throw new Error(`transaction ${hash.slice(0, 10)}… not mined yet`);
  }
}
