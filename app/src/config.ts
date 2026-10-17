import { t } from './i18n';
/** What the testnet deployment workflow wrote (app/public/testnet.json). */
export interface AppConfig {
  network: 'testnet';
  rpcUrl: string;
  networkPassphrase: string;
  deployedAt: string;
  noticeSecs: number;
  wasm: { vault: string; inbox: string };
  router: string;
  registry: string;
  tokens: { usd: Token; eur: Token };
  faucetSecret: string;
  taxAccount: string;
  conversion: { swapper: string; oracle: string; eurUsdAtDeploy: string | null } | null;
  /** Cross-chain payments: the Kyros CCTP receiver and Circle's testnet USDC they arrive in (older deployments have none). */
  cctp?: { receiver: string; usdc: Token };
  passkeyWalletWasmHash: string;
}

export interface Token {
  code: string;
  issuer: string;
  contract: string;
}

export async function loadConfig(): Promise<AppConfig> {
  const r = await fetch(`${import.meta.env.BASE_URL}testnet.json`, { cache: 'no-store' });
  if (!r.ok) throw new Error(`${t('notDeployed')} (testnet.json)`);
  const c = (await r.json()) as Partial<AppConfig>;
  if (!c.router || !c.rpcUrl) throw new Error(t('notDeployed'));
  return c as AppConfig;
}
